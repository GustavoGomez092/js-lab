import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_VERSION, type ConversationTurn, MAX_CONVERSATION_TURNS } from "@jslab/shared";
import { ConversationStore } from "../../src/main/services/conversation-store";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-conversation-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const turn = (id: string, content: string, overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id,
  role: "user",
  content,
  stopped: false,
  ...overrides,
});

/** Zero debounce, so a save lands on `flush()` rather than on a timer the test would have to wait out. */
const open = (path: string) => ConversationStore.open(path, { delayMs: 0 });

const readBack = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as { version: number; messages: ConversationTurn[] };

describe("ConversationStore (spec §14.3)", () => {
  test("a profile with no conversation yet starts empty, and is not treated as damaged", async () => {
    const store = await open(join(dir, "ai", "conversation.json"));
    expect(store.messages).toEqual([]);
    expect(store.recovered).toBe("none");
    expect(store.primary).toBe("missing");
  });

  test("saves the conversation to ai/conversation.json, creating the folder", async () => {
    const path = join(dir, "ai", "conversation.json");
    const store = await open(path);
    store.save([turn("a", "why?"), turn("b", "because", { role: "assistant" })]);
    await store.flush();

    const file = await readBack(path);
    expect(file.version).toBe(CONVERSATION_VERSION);
    expect(file.messages.map((message) => message.content)).toEqual(["why?", "because"]);
  });

  test("restores what a previous launch wrote", async () => {
    const path = join(dir, "ai", "conversation.json");
    const first = await open(path);
    first.save([turn("a", "remember me", { stopped: true })]);
    await first.flush();

    const second = await open(path);
    expect(second.messages).toEqual([turn("a", "remember me", { stopped: true })]);
  });

  test("New Chat's empty conversation is persisted, rather than leaving the old one on disk", async () => {
    const path = join(dir, "ai", "conversation.json");
    const store = await open(path);
    store.save([turn("a", "old")]);
    await store.flush();
    store.save([]);
    await store.flush();

    expect((await readBack(path)).messages).toEqual([]);
    expect((await open(path)).messages).toEqual([]);
  });

  test("a corrupt conversation.json recovers from the .bak instead of losing the transcript", async () => {
    const path = join(dir, "ai", "conversation.json");
    const store = await open(path);
    // Two saves, because the first write has no previous file to back up.
    store.save([turn("a", "kept by the backup")]);
    await store.flush();
    store.save([turn("a", "kept by the backup"), turn("b", "newer", { role: "assistant" })]);
    await store.flush();

    await writeFile(path, "{ this is not json");
    const recovered = await open(path);
    expect(recovered.recovered).toBe("backup");
    expect(recovered.messages.map((message) => message.content)).toEqual(["kept by the backup"]);
  });

  /**
   * Both files unreadable is the one path on which the store could come back "healthy but read-only": were the
   * version captured during the load to outlive the parse that threw, `newerVersion` would latch on and the
   * conversation would silently never be written again. It cannot today, because the version is recorded only
   * after a parse succeeds -- so this pins that property, and a future parser that recorded it any earlier
   * would fail here.
   */
  test("when both files are unreadable it falls back to empty AND can still save afterwards", async () => {
    const path = join(dir, "ai", "conversation.json");
    // The store creates `ai/` on its first write; these tests plant files before any store has run.
    await mkdir(join(dir, "ai"), { recursive: true });
    await writeFile(path, JSON.stringify({ version: CONVERSATION_VERSION + 99, messages: "not an array" }));
    await writeFile(`${path}.bak`, "also not json");

    const store = await open(path);
    expect(store.messages).toEqual([]);
    expect(store.recovered).toBe("defaults");
    expect(store.newerVersion).toBeNull();

    store.save([turn("a", "written after the recovery")]);
    await store.flush();
    expect((await readBack(path)).messages.map((message) => message.content)).toEqual(["written after the recovery"]);
  });

  /**
   * A downgrade must not rewrite a file a newer JSLab owns: this build would drop every field that version
   * added, and the user would come back to a truncated transcript after upgrading again (session.json's I4).
   */
  test("a conversation.json from a newer JSLab is read but never written back", async () => {
    const path = join(dir, "ai", "conversation.json");
    const newer = { version: CONVERSATION_VERSION + 1, messages: [turn("a", "from the future")] };
    await mkdir(join(dir, "ai"), { recursive: true });
    await writeFile(path, JSON.stringify(newer));

    const store = await open(path);
    expect(store.newerVersion).toBe(CONVERSATION_VERSION + 1);
    expect(store.messages.map((message) => message.content)).toEqual(["from the future"]);

    store.save([turn("b", "this build's edit")]);
    await store.flush();
    expect(await readBack(path)).toEqual(newer);
  });

  test("an over-long conversation is trimmed before it is written, newest turns kept", async () => {
    const path = join(dir, "ai", "conversation.json");
    const store = await open(path);
    store.save(Array.from({ length: MAX_CONVERSATION_TURNS + 3 }, (_, index) => turn(`t${index}`, "x")));
    await store.flush();

    const file = await readBack(path);
    expect(file.messages).toHaveLength(MAX_CONVERSATION_TURNS);
    expect(file.messages[0]?.id).toBe("t3");
    // What is held matches what was written, so the next bootstrap serves the trimmed set rather than a
    // conversation the file does not actually contain.
    expect(store.messages).toHaveLength(MAX_CONVERSATION_TURNS);
  });
});
