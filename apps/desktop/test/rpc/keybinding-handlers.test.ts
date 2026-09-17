import { describe, expect, mock, test } from "bun:test";
import { COMMANDS, DEFAULT_KEYBINDINGS, type KeybindingRule } from "@jslab/shared";
import {
  createCommandPublishHandlers,
  createKeybindingHandlers,
  type KeybindingHandlerDeps,
} from "../../src/main/rpc/keybinding-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";
import { strings } from "../../src/main/strings";

function setup(published: string[] = []) {
  const saved: KeybindingRule[][] = [];
  const deps = {
    store: {
      path: "/data/keybindings.json",
      rules: [{ key: "cmd+k", command: "-output.clear" }] as readonly KeybindingRule[],
      save: mock(async (rules: readonly KeybindingRule[]) => {
        saved.push([...rules]);
      }),
    },
    registeredCommands: () => published,
    log: mock(() => {}),
  } satisfies KeybindingHandlerDeps;
  return { deps, saved, handlers: createKeybindingHandlers(deps) };
}

describe("commands.catalog", () => {
  // The cross-plan guarantee (R-M5D-REGISTRY-1): the catalogue is COMMANDS, not a list this milestone maintains.
  // When M5a adds edit.toggleLogpoint/edit.clearLogpoints bindings or any milestone adds a command, this test keeps
  // passing only if the enumeration stays dynamic.
  test("lists every command in the shared catalogue, and nothing else", async () => {
    const { handlers } = setup();
    const { commands } = await handlers.requests["commands.catalog"]({});
    expect(commands).toHaveLength(COMMANDS.length);
    expect(commands.map((entry) => entry.id).sort()).toEqual(COMMANDS.map((entry) => entry.id).sort());
    for (const entry of commands) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(typeof entry.registered).toBe("boolean");
    }
  });

  // Without this, `title: command.id` and `category: "run"` both survive: the test above only checks that a title is
  // non-empty and never looks at `category` at all. The pane groups rows by category and labels them by title, so a
  // catalogue that carried either field wrongly would render wrongly while every other assertion here passed.
  test("carries each command's own title and category, not a placeholder", async () => {
    const { handlers } = setup();
    const { commands } = await handlers.requests["commands.catalog"]({});
    const byId = new Map(commands.map((entry) => [entry.id, entry]));
    for (const command of COMMANDS) {
      expect(byId.get(command.id)?.title).toBe(command.title);
      expect(byId.get(command.id)?.category).toBe(command.category);
    }
    // A catalogue that collapsed every row onto one category would still satisfy a per-row equality check if
    // COMMANDS itself were single-category; it is not, so this states the property the grouping depends on.
    expect(new Set(commands.map((entry) => entry.category)).size).toBeGreaterThan(1);
  });

  test("annotates which commands the running window actually registered", async () => {
    const { handlers } = setup(["run.start", "not.a.real.command"]);
    const { commands } = await handlers.requests["commands.catalog"]({});
    const byId = new Map(commands.map((entry) => [entry.id, entry]));
    expect(byId.get("run.start")?.registered).toBe(true);
    expect(byId.get("run.kill")?.registered).toBe(false);
    expect(byId.has("not.a.real.command" as never)).toBe(false);
  });

  // The window publishes on every registry build, so the catalogue must read the ids at call time rather than
  // capturing them when the handler group was created.
  test("reflects the ids published after the handler group was built", async () => {
    let published: string[] = [];
    const handlers = createKeybindingHandlers({
      store: { path: "/data/keybindings.json", rules: [], save: async () => {} },
      registeredCommands: () => published,
      log: () => {},
    });
    expect(
      (await handlers.requests["commands.catalog"]({})).commands.find((e) => e.id === "run.start")?.registered,
    ).toBe(false);
    published = ["run.start"];
    expect(
      (await handlers.requests["commands.catalog"]({})).commands.find((e) => e.id === "run.start")?.registered,
    ).toBe(true);
  });

  test("validates its payload like every other inbound request (spec §18)", () => {
    const { handlers, deps } = setup();
    expect(() => handlers.requests["commands.catalog"]("nope")).toThrow(InvalidPayloadError);
    expect(deps.log).toHaveBeenCalled();
  });
});

describe("keybindings.get / keybindings.save", () => {
  test("returns the user rules, the defaults and the file path", async () => {
    const { handlers } = setup();
    const result = await handlers.requests["keybindings.get"]({});
    expect(result.rules).toEqual([{ key: "cmd+k", command: "-output.clear" }]);
    expect(result.defaults).toEqual([...DEFAULT_KEYBINDINGS]);
    expect(result.path).toBe("/data/keybindings.json");
  });

  // Copies, not the live arrays: the response crosses the RPC boundary as mutable `KeybindingRule[]`, and handing
  // out the store's own array (or the module-level DEFAULT_KEYBINDINGS) would let a caller edit what Main believes
  // is on disk. Matches the same guarantee app.bootstrap already makes (rpc-handlers.test.ts).
  test("hands back copies rather than the store's own arrays", async () => {
    const { handlers, deps } = setup();
    const result = await handlers.requests["keybindings.get"]({});
    expect(result.rules).not.toBe(deps.store.rules);
    expect(result.defaults).not.toBe(DEFAULT_KEYBINDINGS);
  });

  test("keybindings.get validates its payload (spec §18)", () => {
    const { handlers } = setup();
    expect(() => handlers.requests["keybindings.get"]("nope")).toThrow(InvalidPayloadError);
  });

  test("saves valid rules and reports a write failure as a readable result", async () => {
    const { handlers, saved, deps } = setup();
    expect(await handlers.requests["keybindings.save"]({ rules: [{ key: "cmd+j", command: "run.start" }] })).toEqual({
      ok: true,
    });
    expect(saved).toEqual([[{ key: "cmd+j", command: "run.start" }]]);
    // A successful save is not an error condition and must not be logged as one.
    expect(deps.log).not.toHaveBeenCalled();

    deps.store.save.mockImplementation(async () => {
      throw new Error("EACCES: /opt/data/keybindings.json");
    });
    const failed = await handlers.requests["keybindings.save"]({ rules: [] });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).not.toMatch(/[/\\]/);
      // Stated exactly, so replacing the user-facing line with the raw cause cannot pass (spec §18).
      expect(failed.error).toBe(strings.keybindings.saveFailed);
    }
    // The absolute path is still recoverable by whoever debugs it -- it goes to the log, never to the user.
    expect(deps.log).toHaveBeenCalled();
    expect(String(deps.log.mock.calls.at(-1))).toContain("EACCES");
  });

  test("rejects a malformed payload rather than writing it", async () => {
    const { handlers, saved } = setup();
    await expect(handlers.requests["keybindings.save"]({ rules: "nope" })).rejects.toThrow();
    await expect(handlers.requests["keybindings.save"]({})).rejects.toThrow();
    expect(saved).toEqual([]);
  });

  // The bounds are the reason this schema exists rather than passing the array through: an unbounded rule list
  // (or a rule with an unbounded key) is written straight to disk and re-read at every launch.
  test("rejects rules that break the per-rule shape or the list cap, without writing", async () => {
    const { handlers, saved } = setup();
    await expect(handlers.requests["keybindings.save"]({ rules: [{ key: "", command: "run.start" }] })).rejects.toThrow(
      InvalidPayloadError,
    );
    await expect(handlers.requests["keybindings.save"]({ rules: [{ key: "cmd+j" }] })).rejects.toThrow(
      InvalidPayloadError,
    );
    const tooMany = Array.from({ length: 501 }, () => ({ key: "cmd+j", command: "run.start" }));
    await expect(handlers.requests["keybindings.save"]({ rules: tooMany })).rejects.toThrow(InvalidPayloadError);
    // 500 is the boundary itself, and must still be accepted.
    expect(await handlers.requests["keybindings.save"]({ rules: tooMany.slice(0, 500) })).toEqual({ ok: true });
    expect(saved).toHaveLength(1);
  });
});

describe("commands.published", () => {
  test("records the ids the main window registered", () => {
    const received: string[][] = [];
    const handlers = createCommandPublishHandlers({ onPublished: (ids) => received.push(ids), log: () => {} });
    handlers.messages["commands.published"]({ ids: ["run.start", "run.kill"] });
    expect(received).toEqual([["run.start", "run.kill"]]);
  });

  // Messages are fire-and-forget: an invalid one is logged and dropped, never thrown into the RPC layer.
  test("drops an invalid payload instead of throwing, and records nothing", () => {
    const received: string[][] = [];
    const log = mock(() => {});
    const handlers = createCommandPublishHandlers({ onPublished: (ids) => received.push(ids), log });
    expect(() => handlers.messages["commands.published"]({ ids: "run.start" })).not.toThrow();
    expect(() => handlers.messages["commands.published"]({ ids: [""] })).not.toThrow();
    expect(() =>
      handlers.messages["commands.published"]({ ids: Array.from({ length: 1001 }, () => "x") }),
    ).not.toThrow();
    expect(received).toEqual([]);
    expect(log).toHaveBeenCalledTimes(3);
  });
});
