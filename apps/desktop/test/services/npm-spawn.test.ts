import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyNpmFailure } from "@jslab/npm";
import { createBunSpawn, createLineMasker } from "../../src/main/services/npm-spawn";

describe("createBunSpawn (spec §11.3, fix round 1 M-6/M-5d)", () => {
  test("createBunSpawn keeps a trailing multi-byte character and aborts a running child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jslab-npm-spawn-"));
    const spawn = createBunSpawn(process.execPath);
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    try {
      // Part (a): a trailing multi-byte character (never typed in source) must survive the capture unmangled.
      const accent = String.fromCharCode(233);
      const word = `caf${accent}`;
      const script = `process.stdout.write(${JSON.stringify(word)})`;
      const result = await spawn(["-e", script], {
        cwd: dir,
        env,
        signal: new AbortController().signal,
        onOutput: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.endsWith(accent)).toBe(true);
      expect(result.stdout).toBe(word);

      // Part (b): an abort must kill the child (by the adapter's own tracked process) within a few seconds.
      const controller = new AbortController();
      const startedAt = Date.now();
      const slow = spawn(["-e", "setTimeout(() => {}, 30000)"], {
        cwd: dir,
        env,
        signal: controller.signal,
        onOutput: () => {},
      });
      await Bun.sleep(100);
      controller.abort();
      const killed = await slow;
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(killed.exitCode === null || killed.exitCode !== 0).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // R-M3-T26-FIX-3 (R-2, NI-1, NI-2): pipe reads end anywhere, and stdout and stderr interleave, so Main masks
  // complete lines per stream before anything reaches onOutput, the collected result or NpmOpError.log.
  test("npm output is masked line by line per stream", async () => {
    const NL = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const leaks = ["secret", "user:", "sec", "abc12345", "abc123", "abc"];
    const isLineEnd = (text: string) => text.endsWith(NL) || text.endsWith(CR);
    const assertMasked = (text: string, where: string) => {
      for (const leak of leaks) {
        if (text.includes(leak)) throw new Error(`${where}: ${JSON.stringify(leak)} in ${JSON.stringify(text)}`);
      }
      expect(leaks.some((leak) => text.includes(leak))).toBe(false);
    };

    // (a) The seam: stdout credentials split across chunks, with stderr lines landing between the halves.
    const calls: string[] = [];
    const stdout = createLineMasker((text) => calls.push(text));
    const stderr = createLineMasker((text) => calls.push(text));
    const sequence: [typeof stdout, string][] = [
      [stdout, "GET https://user:sec"],
      [stderr, `warn: retrying${NL}`],
      [stdout, `ret@registry.example/zod${NL}Authorization: Bear`],
      [stderr, `warn: still retrying${CR}${NL}`],
      [stdout, "er abc12"],
      [stderr, "error: Connection"],
      [stdout, `345${CR}_auth = abc`],
      [stderr, `Refused downloading package manifest fixture-a${NL}`],
      [stdout, `123${NL}tail _auth = abc123`],
    ];
    for (const [index, [masker, chunk]] of sequence.entries()) {
      masker.push(chunk);
      for (const call of calls) {
        expect(isLineEnd(call)).toBe(true);
        assertMasked(call, `after chunk ${index}`);
      }
    }
    const beforeEnd = calls.length;
    stdout.end();
    stderr.end();
    // Only the end flush may lack a line break: the unterminated stdout tail, masked.
    expect(calls.slice(beforeEnd)).toEqual(["tail _auth = ***"]);
    for (const call of calls) assertMasked(call, "after the end flush");
    expect(calls.join("").includes("https://registry.example/zod")).toBe(true);
    expect(calls.join("").includes("Authorization: Bearer ***")).toBe(true);
    const collected = { exitCode: 1, stdout: stdout.text, stderr: stderr.text };
    assertMasked(collected.stdout, "collected stdout");
    assertMasked(collected.stderr, "collected stderr");
    expect(collected.stdout).toBe(
      `GET https://registry.example/zod${NL}Authorization: Bearer ***${CR}_auth = ***${NL}tail _auth = ***`,
    );
    expect(classifyNpmFailure(collected)?.kind).toBe("network");

    // (b) The real spawn: a child writes the same shapes in separate, delayed writes to both pipes.
    const dir = await mkdtemp(join(tmpdir(), "jslab-npm-spawn-mask-"));
    try {
      const steps: [number, string][] = [
        [1, "GET https://user:sec"],
        [2, `warn: retrying${NL}`],
        [1, `ret@registry.example/zod${NL}Authorization: Bear`],
        [2, "error: Connection"],
        [1, "er abc12345"],
        [2, `Refused downloading package manifest fixture-a${NL}`],
        [1, `${NL}_auth = abc`],
        [1, `123${NL}`],
      ];
      const script = [
        `const steps = ${JSON.stringify(steps)};`,
        "let index = 0;",
        "const next = () => {",
        "  const step = steps[index++];",
        "  if (!step) { process.exitCode = 1; return; }",
        "  (step[0] === 1 ? process.stdout : process.stderr).write(step[1]);",
        "  setTimeout(next, 30);",
        "};",
        "next();",
      ].join(NL);
      const outputs: string[] = [];
      const result = await createBunSpawn(process.execPath)(["-e", script], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        signal: new AbortController().signal,
        onOutput: (text) => outputs.push(text),
      });
      expect(result.exitCode).toBe(1);
      expect(outputs.length).toBeGreaterThan(0);
      for (const output of outputs) {
        expect(isLineEnd(output)).toBe(true);
        assertMasked(output, "real spawn onOutput");
      }
      assertMasked(result.stdout, "real spawn stdout");
      assertMasked(result.stderr, "real spawn stderr");
      expect(result.stdout).toBe(`GET https://registry.example/zod${NL}Authorization: Bearer ***${NL}_auth = ***${NL}`);
      expect(result.stderr.includes("ConnectionRefused")).toBe(true);
      expect(classifyNpmFailure(result)?.kind).toBe("network");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
