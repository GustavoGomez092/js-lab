import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSettings } from "@jslab/shared";
import { buildDebugReport } from "../../src/main/logging/debug-report";
import { createRedactor } from "../../src/main/logging/redact";
import {
  aiAccount,
  GITHUB_ACCOUNT,
  KEYCHAIN_SERVICE,
  type KeychainResult,
  type KeychainRun,
  MAX_SECRET_CHARS,
  NOT_FOUND_EXIT,
  SecretStore,
  spawnSecurity,
} from "../../src/main/secrets/keychain";

/**
 * XT-08, the Keychain secret store (spec §18, design ruling D11).
 *
 * Everything below drives the real `SecretStore` over a recording stand-in for the `security` subprocess, except
 * the last test, which is the integration half and touches the developer's real login keychain under an
 * obviously-synthetic service name it deletes in a `finally`.
 *
 * The expected argv arrays, the expected base64 payloads and the expected plaintexts are written here as
 * LITERALS rather than as `SECURITY_BIN` / `KEYCHAIN_SERVICE` lookups or as `Buffer.from(...)` calls. Comparing
 * the store's output against the very constant or the very encoder the store itself used would survive a
 * mutation of either -- that tautology is what this project keeps catching, so the anchors are spelled out.
 */

/** `/Users/me`-style obvious fake, matching `test/shell.test.ts`. Never a real home. */
const HOME_FIXTURE = "/Users/me";

/** Obviously synthetic. Its base64 below is the literal anchor for every encoding assertion. */
const SECRET = "synthetic-openai-key-not-real";
const SECRET_B64 = "c3ludGhldGljLW9wZW5haS1rZXktbm90LXJlYWw=";

interface Call {
  argv: readonly string[];
  stdin: string;
}

/** Records every spawn the store would have made, and answers with whatever the test dictates. */
function recorder(reply: (argv: readonly string[]) => Partial<KeychainResult> = () => ({})) {
  const calls: Call[] = [];
  const run: KeychainRun = async (argv, stdin) => {
    calls.push({ argv, stdin });
    const answer = reply(argv);
    return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  return { calls, run };
}

const reportFrom = (logLines: string[]): string =>
  buildDebugReport({
    versions: { app: "0.3.0", bun: "1.4.0", electrobun: "2.0.1" },
    os: { macOS: "26.5.2", arch: "arm64" },
    settings: defaultSettings(),
    logLines,
    redact: createRedactor(),
    home: HOME_FIXTURE,
  });

describe("SecretStore (XT-08, spec §18)", () => {
  test("the service and account names are the ones spec §4.5 and §15 name", () => {
    expect(KEYCHAIN_SERVICE).toBe("dev.jslab.app");
    expect(GITHUB_ACCOUNT).toBe("github");
    expect(aiAccount("openai")).toBe("ai.openai");
  });

  /**
   * The argv hazard, which is the whole reason the CLI needed care. `security`'s own help says so: "Use of the
   * -p or -w options is insecure. Specify -w as the last option to be prompted."
   */
  test("set passes the value on stdin and never on argv", async () => {
    const { calls, run } = recorder();
    await new SecretStore(run).set("ai.openai", SECRET);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([
      "/usr/bin/security",
      "add-generic-password",
      "-a",
      "ai.openai",
      "-s",
      "dev.jslab.app",
      "-U",
      "-w",
    ]);
    // `-w` must be the LAST option, or `security` reads the next argv element as the password instead of prompting.
    expect(calls[0]?.argv.at(-1)).toBe("-w");
    // Stated separately from the array equality above, because this is the property that must hold however the
    // argv list is later rearranged: neither the secret nor its encoded spelling is anywhere in the process table.
    for (const element of calls[0]?.argv ?? []) {
      expect(element).not.toContain(SECRET);
      expect(element).not.toContain(SECRET_B64);
    }
  });

  /**
   * Measured: `security` prompts TWICE ("password data for new item:", "retype password for new item:"). Sent
   * once, it takes EOF as an empty confirmation, loops, takes EOF for both prompts on the second pass, and exits
   * 0 having stored the EMPTY STRING -- so the caller is told the key was saved when nothing was.
   */
  test("set writes the payload twice, because a single copy silently stores the empty string", async () => {
    const { calls, run } = recorder();
    await new SecretStore(run).set("github", SECRET);
    expect(calls[0]?.stdin).toBe(`${SECRET_B64}\n${SECRET_B64}\n`);
  });

  /**
   * Why base64 at all. Measured against the real `security`: a value containing a newline is stored as the empty
   * string, and a value containing a tab or any non-ASCII byte reads back HEX-encoded -- while `deadbeef` and
   * `123456` read back verbatim, so the hex spelling is ambiguous and cannot be detected after the fact.
   */
  test("a value with a newline or non-ASCII characters round-trips exactly", async () => {
    const newline = `a${String.fromCharCode(10)}b`;
    const { calls, run } = recorder();
    await new SecretStore(run).set("github", newline);
    // base64 has no newline of its own, so the payload is still a single line for `security` to read.
    expect(calls[0]?.stdin).toBe("YQpi\nYQpi\n");

    const reader = recorder(() => ({ stdout: "YQpi\n" }));
    expect(await new SecretStore(reader.run).get("github")).toBe(newline);

    const unicode = recorder(() => ({ stdout: "Y2xlzIEt56eY5a+GLfCflJE=\n" }));
    expect(await new SecretStore(unicode.run).get("github")).toBe("clé-秘密-🔑");
  });

  test("a missing item reads as null and deletes as false, and deleting twice is not an error", async () => {
    // errSecItemNotFound. Pinned as a literal: `security` exits 44 for a find or a delete that matched nothing.
    expect(NOT_FOUND_EXIT).toBe(44);
    const { run } = recorder(() => ({ exitCode: 44 }));
    const store = new SecretStore(run);
    expect(await store.get("github")).toBeNull();
    expect(await store.delete("github")).toBe(false);

    const present = recorder(() => ({ exitCode: 0 }));
    expect(await new SecretStore(present.run).delete("github")).toBe(true);
  });

  /**
   * `status` is what a UI is allowed to ask for. It must answer "is there one?" without ever reading the value,
   * which is why the probe omits both `-w` and `-g`: the password is not merely discarded here, it is never read
   * out of the keychain, so there is no plaintext in Main to leak.
   */
  test("status answers with booleans only and never asks security for a value", async () => {
    const { calls, run } = recorder((argv) => ({
      exitCode: argv.includes("github") ? 0 : NOT_FOUND_EXIT,
      // Offered deliberately: if the probe ever asked for the password, this is what it would come back with.
      stdout: "LEAKED-VALUE",
    }));
    const status = await new SecretStore(run).status([GITHUB_ACCOUNT, aiAccount("openai")]);

    expect(status).toEqual({ github: true, "ai.openai": false });
    expect(Object.values(status).every((value) => typeof value === "boolean")).toBe(true);
    expect(JSON.stringify(status)).not.toContain("LEAKED-VALUE");
    for (const call of calls) {
      expect(call.argv).not.toContain("-w");
      expect(call.argv).not.toContain("-g");
    }
  });

  /**
   * An account is an argv element, so one spelled `-A` would stop being a value and start being a flag -- and
   * `-A` on an add is "allow any application to access this item without warning". The guard has to run BEFORE
   * the spawn, which is what the call count asserts.
   */
  test("an account name that could be read as a flag is refused before anything is spawned", async () => {
    const { calls, run } = recorder();
    const store = new SecretStore(run);
    for (const bad of ["-w", "-A", "", "a b", `a${String.fromCharCode(10)}b`, "-", "a/b", ".hidden"]) {
      await expect(store.get(bad)).rejects.toThrow();
      await expect(store.set(bad, SECRET)).rejects.toThrow();
      await expect(store.delete(bad)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
    // The control: a legitimate account still reaches the subprocess, so the guard is not refusing everything.
    await store.get(aiAccount("openai"));
    expect(calls).toHaveLength(1);
  });

  test("an over-long secret is refused before anything is spawned", async () => {
    expect(MAX_SECRET_CHARS).toBe(4096);
    const { calls, run } = recorder();
    await expect(new SecretStore(run).set("github", "x".repeat(4097))).rejects.toThrow();
    expect(calls).toEqual([]);
    // The control: one character under the cap is accepted, so the bound is the cap and not a blanket refusal.
    await new SecretStore(run).set("github", "x".repeat(4096));
    expect(calls).toHaveLength(1);
  });

  /**
   * The base64 of a secret IS the secret, so an error that helpfully quoted "the payload we sent" would leak as
   * completely as one that printed the key. Both spellings are asserted absent.
   */
  test("a failed security call reports the account and neither spelling of the value", async () => {
    const { run } = recorder(() => ({ exitCode: 1, stderr: "SecKeychainAddGenericPassword returned -25299" }));
    const error = await new SecretStore(run).set(GITHUB_ACCOUNT, SECRET).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("github");
    expect(error?.message).toContain("-25299");
    expect(error?.message).not.toContain(SECRET);
    expect(error?.message).not.toContain(SECRET_B64);
  });

  /**
   * The debug-report proof (spec §20). Built from everything a full set/get/delete cycle observably produced --
   * the argv arrays, which are what a spawn logger would write, and the thrown error message.
   *
   * The positive control is what makes this worth anything: `createRedactor()` does not know this secret and no
   * built-in pattern matches it, so a report built from a line that really contains it DOES contain it. The
   * absence above is therefore the store declining to emit the value, not redaction quietly covering for it.
   */
  test("nothing the store produces can carry the secret into the debug report", async () => {
    const { calls, run } = recorder((argv) => (argv.includes("delete-generic-password") ? { exitCode: 1 } : {}));
    const store = new SecretStore(run);
    await store.set(aiAccount("openai"), SECRET);
    await store.get(aiAccount("openai"));
    await store.status([GITHUB_ACCOUNT]);
    const error = await store.delete(aiAccount("openai")).then(
      () => null,
      (caught: unknown) => caught as Error,
    );

    const emitted = [...calls.map((call) => JSON.stringify(call.argv)), String(error?.message)];
    const report = reportFrom(emitted);
    expect(report).not.toContain(SECRET);
    expect(report).not.toContain(SECRET_B64);

    // Control: the same report, from a line that does contain the secret, contains it. Without this the
    // assertions above would pass just as happily against a redactor that masked everything, or an empty report.
    expect(reportFrom([`stored ${SECRET}`])).toContain(SECRET);
    expect(emitted.length).toBeGreaterThan(3);
  });

  /**
   * The structural half of the same guarantee. The store takes no logger and reaches for none, so it cannot put
   * a line into the rotating log that the debug report is built from -- a stronger property than redaction,
   * because it does not depend on a pattern recognising the secret.
   */
  test("the store module has no way to log at all", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "src", "main", "secrets", "keychain.ts"), "utf8");
    // The scan can see the file -- without this a renamed path would make the assertions below pass vacuously.
    expect(source).toContain("export class SecretStore");
    expect(source.length).toBeGreaterThan(3000);

    expect(source).not.toMatch(/\blog\s*\(/);
    expect(source).not.toContain("console.");
    // The subprocess-output discipline (R-M5b-S3): the spawn caps both pipes.
    expect(source).toContain("maxBuffer: MAX_SHORT_SUBPROCESS_OUTPUT_BYTES");
  });

  /**
   * The integration half (parity Verify `I`). This one really writes to the developer's login keychain, under a
   * service name that is obviously synthetic and unique per run, and removes it in a `finally` so a failed
   * assertion cannot leave an item behind.
   */
  test.skipIf(process.platform !== "darwin")(
    "round-trips a real Keychain item and cleans up after itself",
    async () => {
      const service = `dev.jslab.app.xt08-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
      const store = new SecretStore(spawnSecurity, service);
      const account = aiAccount("synthetic");
      const value = `synthetic-not-a-real-key-${String.fromCharCode(10)}clé-秘密-🔑`;
      try {
        expect(await store.status([account])).toEqual({ [account]: false });
        expect(await store.get(account)).toBeNull();

        await store.set(account, value);
        expect(await store.get(account)).toBe(value);
        expect(await store.status([account])).toEqual({ [account]: true });

        await store.set(account, "replaced");
        expect(await store.get(account)).toBe("replaced");

        expect(await store.delete(account)).toBe(true);
        expect(await store.delete(account)).toBe(false);
        expect(await store.get(account)).toBeNull();
      } finally {
        await store.delete(account).catch(() => {});
      }
    },
  );
});
