import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@jslab/shared";
import { FileService, isProbablyText, LARGE_FILE_BYTES, nodeFileSystem } from "../../src/main/files/file-service";
import { readE2EOpenDialog, readE2ESaveDialog } from "../../src/main/platform/e2e-dialogs";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-files-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Real files for content, with a stat override so size limits can be tested without writing 5 MB. */
function service(sizes: Record<string, number> = {}, now = () => 0) {
  return new FileService(
    {
      ...nodeFileSystem,
      stat: async (path) => {
        const real = await nodeFileSystem.stat(path);
        return { ...real, size: sizes[path] ?? real.size };
      },
    },
    { now },
  );
}

describe("FileService", () => {
  test("prepareOpen returns text files, defers large files and reports unreadable ones", async () => {
    const small = join(dir, "a.ts");
    const crlf = join(dir, "win.js");
    const big = join(dir, "big.js");
    const huge = join(dir, "huge.js");
    const binary = join(dir, "img.txt");
    await writeFile(small, "const a = 1\n");
    await writeFile(crlf, "a\r\nb\r\n");
    await writeFile(big, "x");
    await writeFile(huge, "x");
    await writeFile(binary, new Uint8Array([0x89, 0x50, 0x00, 0x47]));
    const files = service({ [big]: LARGE_FILE_BYTES + 1, [huge]: 60 * 1024 * 1024 });
    const result = await files.prepareOpen([small, crlf, big, huge, binary, join(dir, "missing.ts")]);
    expect(result.ready).toEqual([
      { path: small, content: "const a = 1\n" },
      { path: crlf, content: "a\r\nb\r\n" },
    ]);
    expect(result.large).toEqual([{ token: expect.any(String), path: big, size: LARGE_FILE_BYTES + 1 }]);
    expect(result.errors).toEqual([
      "huge.js is larger than 50 MB and can't be opened.",
      "img.txt isn't a text file.",
      "missing.ts couldn't be read.",
    ]);
  });

  test("confirmLarge reads each issued token once and rejects unknown or expired tokens", async () => {
    let clock = 0;
    const big = join(dir, "big.js");
    await writeFile(big, "big content");
    const files = service({ [big]: LARGE_FILE_BYTES + 10 }, () => clock);
    const [first] = (await files.prepareOpen([big])).large;
    expect(await files.confirmLarge([first?.token ?? "", "forged"])).toEqual({
      ready: [{ path: big, content: "big content" }],
      errors: ["That file request expired. Open the file again."],
    });
    expect((await files.confirmLarge([first?.token ?? ""])).ready).toEqual([]);
    const [second] = (await files.prepareOpen([big])).large;
    clock = 6 * 60_000;
    expect((await files.confirmLarge([second?.token ?? ""])).ready).toEqual([]);
  });

  test("write stores content atomically and returns its hash", async () => {
    const path = join(dir, "nested", "out.ts");
    expect(await service().write(path, "x = 1\r\n")).toBe(contentHash("x = 1\r\n"));
    expect(await readFile(path, "utf8")).toBe("x = 1\r\n");
  });

  test("save-as confirmation tokens are single use", () => {
    const files = service();
    const token = files.issueSaveAsToken({ tabId: "t1", path: "/d/a.ts", content: "c" });
    expect(files.takeSaveAsToken(token)).toEqual({ tabId: "t1", path: "/d/a.ts", content: "c" });
    expect(files.takeSaveAsToken(token)).toBeNull();
  });

  test("text detection and E2E dialog answers", async () => {
    expect(isProbablyText(new TextEncoder().encode("héllo"))).toBe(true);
    expect(isProbablyText(new Uint8Array([65, 0, 66]))).toBe(false);
    expect(await readE2EOpenDialog(dir)).toEqual([]);
    await writeFile(join(dir, "e2e-open-dialog.json"), JSON.stringify(["/a.ts", 5]));
    expect(await readE2EOpenDialog(dir)).toEqual(["/a.ts"]);
    expect(await readE2EOpenDialog(dir)).toEqual([]);
    await writeFile(join(dir, "e2e-save-dialog.json"), JSON.stringify({ path: "/b.ts" }));
    expect(await readE2ESaveDialog(dir)).toBe("/b.ts");
    expect(await readE2ESaveDialog(dir)).toBeNull();
  });
});
