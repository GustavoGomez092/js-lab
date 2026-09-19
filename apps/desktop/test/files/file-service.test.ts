import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  // Test 1 (I-1): size limits aren't enforced only at the initial stat; a file can grow (or be replaced) during
  // the large-file token's 5-minute window, so confirmLarge must refuse it based on what's actually read.
  test("confirmLarge refuses a file that grew past the size limit while its token was pending", async () => {
    const big = join(dir, "big.js");
    await writeFile(big, "x".repeat(15));
    const files = new FileService(nodeFileSystem, { largeFileBytes: 10, maxFileBytes: 20 });
    const [large] = (await files.prepareOpen([big])).large;
    expect(large?.token).toEqual(expect.any(String));
    await writeFile(big, "x".repeat(25));
    expect(await files.confirmLarge([large?.token ?? ""])).toEqual({
      ready: [],
      errors: ["big.js is larger than 50 MB and can't be opened."],
    });
  });

  // Test 2 (m-1): Save As confirmation tokens get the same 5-minute TTL as large-file tokens, so their held
  // content is freed rather than held onto forever.
  test("save-as confirmation tokens expire after five minutes", () => {
    let clock = 0;
    const files = new FileService(nodeFileSystem, { now: () => clock });
    const token = files.issueSaveAsToken({ tabId: "t1", path: "/d/a.ts", content: "c" });
    clock = 6 * 60_000;
    expect(files.takeSaveAsToken(token)).toBeNull();
  });

  // Test 5 (m-4): saving through a symlink must not replace the link itself with a plain file.
  test("write follows a symlink to its real target so the link survives", async () => {
    const target = join(dir, "real.ts");
    const link = join(dir, "link.ts");
    await writeFile(target, "old content");
    await symlink(target, link);
    expect(await service().write(link, "new content")).toBe(contentHash("new content"));
    expect(await readFile(target, "utf8")).toBe("new content");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  // Test 6 (m-5): decoding is fatal on invalid UTF-8 (rejected as non-text, not silently mangled), and a BOM is
  // preserved on decode so saving the content back reproduces the same bytes.
  test("invalid UTF-8 is rejected as non-text, and a UTF-8 BOM round-trips unchanged", async () => {
    const latin1 = join(dir, "latin1.txt");
    await writeFile(latin1, Buffer.from([0x48, 0xe9, 0x6c, 0x6c, 0x6f]));
    expect((await service().prepareOpen([latin1])).errors).toEqual(["latin1.txt isn't a text file."]);

    const bom = join(dir, "bom.ts");
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const a = 1;\n")]);
    await writeFile(bom, original);
    const [file] = (await service().prepareOpen([bom])).ready;
    expect(file?.content.charCodeAt(0)).toBe(0xfeff);
    await service().write(bom, file?.content ?? "");
    expect(await readFile(bom)).toEqual(original);
  });

  // R-M5b-S2 sweep: the size limit now sits before the allocation, not after it. The error cannot show that --
  // read-then-measure refused this same file with this same message -- so the assertion has to be the cost.
  //
  // Measured in a child process, and that is load-bearing. RSS never shrinks, so if any earlier test in this
  // run has already mapped 512 MB, a second 512 MB read reuses those pages and the delta collapses. Measured:
  // with the check moved after the read, an in-process version of this test passed while the same assertion in
  // bounded-read.test.ts failed at 512 MB -- it was proving the order the files happened to run in. The whole
  // scenario therefore lives in the child, which gets its own baseline and cannot be preloaded by a neighbour.
  test("confirmLarge refuses a file swapped for a huge one WITHOUT reading it into memory", async () => {
    const big = join(dir, "grew.js");
    const service = join(import.meta.dir, "..", "..", "src", "main", "files", "file-service.ts");
    const script = [
      `const { FileService, nodeFileSystem } = await import(${JSON.stringify(service)});`,
      `const { writeFile, open } = await import("node:fs/promises");`,
      `await writeFile(${JSON.stringify(big)}, "x".repeat(15));`,
      `const files = new FileService(nodeFileSystem, { largeFileBytes: 10, maxFileBytes: 20 });`,
      `const [large] = (await files.prepareOpen([${JSON.stringify(big)}])).large;`,
      `console.log("TOKEN:" + (large && large.token ? "yes" : "no"));`,
      // What the 5-minute token window actually allows: the file the user confirmed is not the file that gets
      // read. 512 MB to `stat`, zero blocks on disk, so it costs nothing unless something really reads it.
      `const handle = await open(${JSON.stringify(big)}, "w");`,
      `try { await handle.truncate(512 * 1024 * 1024); } finally { await handle.close(); }`,
      `const before = process.memoryUsage().rss;`,
      `const result = await files.confirmLarge([large ? large.token : ""]);`,
      `const after = process.memoryUsage().rss;`,
      // `result` is read only after the second sample, so a mutant's bytes stay reachable until measured.
      `console.log("READY:" + result.ready.length);`,
      `console.log("ERRORS:" + JSON.stringify(result.errors));`,
      `console.log("DELTA:" + Math.round((after - before) / (1024 * 1024)));`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    await child.exited;
    const out = await new Response(child.stdout).text();

    expect(out).toContain("TOKEN:yes");
    expect(out).toContain("READY:0");
    expect(out).toContain(`ERRORS:["grew.js is larger than 50 MB and can't be opened."]`);
    expect(Number(/DELTA:(-?\d+)/.exec(out)?.[1] ?? Number.NaN)).toBeLessThan(64);
  });
});
