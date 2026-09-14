import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "@jslab/shared";
import { buildDebugReport } from "../../src/main/logging/debug-report";
import { createRedactor } from "../../src/main/logging/redact";
import { RotatingLog } from "../../src/main/logging/rotating-log";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-logs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-09-13T10:00:00.000Z");

describe("redaction", () => {
  test("masks auth headers, npm tokens and common key shapes", () => {
    const redact = createRedactor();
    expect(redact("Authorization: Bearer abc.def-123 next")).toBe("Authorization: [REDACTED] next");
    expect(redact('{"authorization":"token s3cr3t"}')).toBe('{"authorization":"[REDACTED]"}');
    expect(redact("//registry.npmjs.org/:_authToken=npm_abcdef123")).toBe(
      "//registry.npmjs.org/:_authToken=[REDACTED]",
    );
    expect(redact("key sk-proj-ABCDEFGHIJKLMNOPQRSTUV and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe(
      "key [REDACTED] and [REDACTED]",
    );
    expect(redact("AKIAABCDEFGHIJKLMNOP xoxb-1234567890-abcdef")).toBe("[REDACTED] [REDACTED]");
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });

  test("masks caller-supplied secrets of four or more characters", () => {
    const redact = createRedactor(() => ["hunter2", "ab"]);
    expect(redact("password=hunter2, short=ab")).toBe("password=[REDACTED], short=ab");
  });
});

describe("RotatingLog", () => {
  test("writes redacted leveled lines and skips debug unless enabled", () => {
    const log = new RotatingLog({ dir, now: fixedNow, redact: createRedactor(), echo: () => {} });
    log.info("started", { pid: 1 });
    log.debug("hidden");
    log.error("failed", new Error("Authorization: Bearer zzz"));
    const text = readFileSync(join(dir, "main.log"), "utf8");
    expect(text.startsWith('2026-09-13T10:00:00.000Z INFO started {"pid":1}\n')).toBe(true);
    expect(text).not.toContain("hidden");
    expect(text).toContain("ERROR failed Error: Authorization: [REDACTED]");
    expect(text).not.toContain("zzz");
    const verbose = new RotatingLog({ dir, fileName: "debug.log", debug: true, now: fixedNow, echo: () => {} });
    verbose.debug("shown");
    expect(readFileSync(join(dir, "debug.log"), "utf8")).toContain("DEBUG shown");
  });

  test("rotates at maxBytes and keeps at most maxFiles files", () => {
    const log = new RotatingLog({ dir, maxBytes: 200, maxFiles: 3, now: fixedNow, echo: () => {} });
    for (let i = 0; i < 40; i++) log.info(`line ${i} ${"x".repeat(40)}`);
    expect(readdirSync(dir).sort()).toEqual(["main.log", "main.log.1", "main.log.2"]);
    expect(existsSync(join(dir, "main.log.3"))).toBe(false);
  });

  test("tail returns the newest lines, reading into the previous file when needed", () => {
    const log = new RotatingLog({ dir, maxBytes: 200, maxFiles: 5, now: fixedNow, echo: () => {} });
    for (let i = 0; i < 12; i++) log.info(`entry ${i} ${"y".repeat(30)}`);
    const lines = log.tail(5);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toContain("entry 11");
    expect(lines[0]).toContain("entry 7");
  });
});

describe("debug report", () => {
  test("contains versions, platform, settings and the last 500 log lines, redacted", () => {
    const report = JSON.parse(
      buildDebugReport({
        versions: { app: "0.2.0", bun: "1.4.0", electrobun: "2.0.1" },
        os: { macOS: "26.5.2", arch: "arm64" },
        settings: defaultSettings(),
        logLines: [...Array.from({ length: 600 }, (_, i) => `l${i}`), "Authorization: Bearer leak"],
        redact: createRedactor(),
      }),
    );
    expect(report).toMatchObject({
      version: "0.2.0",
      bunVersion: "1.4.0",
      electrobunVersion: "2.0.1",
      macOS: "26.5.2",
      arch: "arm64",
    });
    expect(report.settings.version).toBe(2);
    expect(report.log).toHaveLength(500);
    expect(report.log.at(-1)).toBe("Authorization: [REDACTED]");
  });
});
