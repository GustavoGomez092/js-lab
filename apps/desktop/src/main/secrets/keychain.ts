import { MAX_SHORT_SUBPROCESS_OUTPUT_BYTES } from "../platform/subprocess-output";

/**
 * The macOS Keychain adapter (XT-08, spec §18, design ruling D11 "macOS Keychain via a `security` CLI adapter").
 *
 * This is the storage mechanism only. Its two intended callers -- the AI provider keys (TL-23, account
 * `ai.<provider>`) and the GitHub token (XT-04, account `github`) -- are not built here.
 *
 * WHY THE CLI AND NOT A NATIVE BINDING
 * A native/FFI binding to `SecItemAdd`/`SecItemCopyMatching` would avoid a subprocess entirely, but every such
 * binding on npm is a new dependency, and this repository's lockfile is fixed. `bun:ffi` against
 * `Security.framework` needs no package, but it would hand-marshal `CFDictionary`/`CFData` structs into a
 * privileged system framework from Main's event loop, where a mistake is a crash or a corrupted keychain rather
 * than a failed exit code. The CLI is what the design already chose, and its one real hazard -- argv -- is
 * closable, which is what the rest of this file is about.
 */

/** Spec §4.5: "The Keychain service name is `dev.jslab.app`". One spelling, so nothing can disagree about it. */
export const KEYCHAIN_SERVICE = "dev.jslab.app";

/**
 * Absolute, never the bare name `security` on PATH.
 *
 * Every other helper Main spawns is looked up by bare name (`osascript`, `sw_vers`, `system_profiler`), and
 * `test/platform/subprocess-output.test.ts` relies on that to substitute a flooding stand-in. This one is
 * deliberately different: Main merges the user's login-shell PATH (`platform/login-shell-env.ts`), so a bare
 * name here would let anything earlier on that PATH receive the user's API keys on its stdin. A secret-bearing
 * spawn is the one place where the substitution that makes those tests possible is itself the hazard.
 */
export const SECURITY_BIN = "/usr/bin/security";

/** `errSecItemNotFound`. `security` exits with this for a find or a delete that matched nothing (measured). */
export const NOT_FOUND_EXIT = 44;

/**
 * A secret's length bound, in characters of the ORIGINAL string.
 *
 * Real values on this path are short: an OpenAI key is ~50 characters, an Anthropic key ~100, a GitHub
 * fine-grained PAT ~93. The bound is set far above all of them rather than snugly, because refusing a key a
 * provider legitimately issues is a bug while the cap only has to stop an unbounded string being handed to a
 * subprocess. At this cap the base64 payload is at most 4x/3 of the UTF-8 bytes, and `set` writes it twice, so
 * the most that can ever reach `security`'s stdin is about 44 KB.
 */
export const MAX_SECRET_CHARS = 4096;

/**
 * What an account name may be. Checked before every spawn, for two separate reasons.
 *
 * ARGV INJECTION: `security` parses its own arguments, so an account of `-w` or `-A` would stop being a value
 * and start being a flag -- `-A` on an add is "allow any application to read this item without warning". A
 * leading `-` is impossible under this pattern, which is what makes the argv array below safe to build.
 *
 * ROUND-TRIP: the account is an argv element, so a newline or a NUL in it cannot survive the trip either.
 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Spec §15: the GitHub token's account. */
export const GITHUB_ACCOUNT = "github";

/** Spec §14: an AI provider's key lives under `ai.<provider>`. */
export function aiAccount(provider: string): string {
  return `ai.${provider}`;
}

export interface KeychainResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The seam. Everything that talks to the real Keychain goes through one of these, so the store's behaviour can
 * be driven in tests without touching the developer's login keychain.
 */
export type KeychainRun = (argv: readonly string[], stdin: string) => Promise<KeychainResult>;

/**
 * Why a secret is stored base64-encoded rather than as itself.
 *
 * `security find-generic-password -w` does not always give back what was put in. Measured on this machine
 * (macOS 26.5, /usr/bin/security):
 *
 *   - a value containing a NEWLINE is destroyed on the way IN. `-w` reads the value as a line, so
 *     `printf 'a\nb'` stored the empty string -- and exited 0 while doing it.
 *   - a value containing a TAB or any non-ASCII byte comes back HEX-ENCODED. `clé-秘密-🔑` read back as
 *     `636cc3a92de7a798e5af862df09f9491`; `a\tb` read back as `610962`.
 *   - and that hex is AMBIGUOUS, which is what rules out simply decoding it: `deadbeef` and `123456` are
 *     plain ASCII, so they come back VERBATIM and are indistinguishable from the hex spelling of some other
 *     value. A reader that guessed would corrupt exactly the secrets that look like hex.
 *
 * Base64 makes the hex path unreachable instead of trying to detect it: the stored text is always ASCII,
 * always free of whitespace, so `-w` always returns it verbatim, and the decode is exact for every input
 * including emoji. The cost is that Keychain Access shows the encoded form rather than the raw key.
 */
function encodeSecret(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeSecret(stored: string): string {
  return Buffer.from(stored, "base64").toString("utf8");
}

/**
 * The default runner: a real `security` subprocess.
 *
 * `stdout`/`stderr` are both capped at `MAX_SHORT_SUBPROCESS_OUTPUT_BYTES` for the reason `subprocess-output.ts`
 * sets out -- Bun drains a child's pipe eagerly, so declining to read bounds nothing and only `maxBuffer`, which
 * ends the child, does. Everything `security` legitimately prints here is one short line.
 */
export const spawnSecurity: KeychainRun = async (argv, stdin) => {
  if (process.platform !== "darwin") {
    throw new Error("The Keychain secret store is available on macOS only");
  }
  const proc = Bun.spawn([...argv], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: MAX_SHORT_SUBPROCESS_OUTPUT_BYTES,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/**
 * Main's secret store (spec §18). Set, get, delete, and ask WHICH accounts hold a value -- never a listing of
 * values.
 *
 * Nothing in this class logs. It takes no logger and reaches for none: the debug report (spec §20) is built from
 * the rotating log, so a store that cannot write a log line cannot contribute a secret to the report, whatever
 * `logging/redact.ts` does or does not happen to match. That is a stronger guarantee than redaction, because it
 * does not depend on a pattern recognising the secret.
 */
export class SecretStore {
  constructor(
    private readonly run: KeychainRun = spawnSecurity,
    private readonly service: string = KEYCHAIN_SERVICE,
  ) {}

  /**
   * Stores `value` under `account`, replacing whatever was there.
   *
   * The value travels on STDIN and never on argv. `-w` given as the last option with no value makes `security`
   * prompt for the password, and it reads that prompt from stdin rather than from /dev/tty (measured), so a
   * piped value is accepted with no terminal at all -- which is what makes this usable from a GUI app.
   *
   * It is written TWICE because `security` asks twice ("password data for new item:", "retype password for new
   * item:"). Sending it once is not an error that surfaces: measured, `security` read the single line, took EOF
   * as an empty confirmation, looped, took EOF for both prompts on the second pass, and exited 0 having stored
   * the EMPTY STRING. A caller would have been told the key was saved. `test/secrets/keychain.test.ts` pins the
   * second copy for exactly that reason.
   */
  async set(account: string, value: string): Promise<void> {
    assertAccount(account);
    if (value.length > MAX_SECRET_CHARS) {
      throw new Error(`Secret for ${account} is longer than ${MAX_SECRET_CHARS} characters`);
    }
    const encoded = encodeSecret(value);
    const result = await this.run(
      [SECURITY_BIN, "add-generic-password", "-a", account, "-s", this.service, "-U", "-w"],
      `${encoded}\n${encoded}\n`,
    );
    if (result.exitCode !== 0) throw failure("store", account, result);
  }

  /** The value, or null when no item exists. The only method that ever handles plaintext. */
  async get(account: string): Promise<string | null> {
    assertAccount(account);
    const result = await this.run([SECURITY_BIN, "find-generic-password", "-a", account, "-s", this.service, "-w"], "");
    if (result.exitCode === NOT_FOUND_EXIT) return null;
    if (result.exitCode !== 0) throw failure("read", account, result);
    return decodeSecret(result.stdout.trim());
  }

  /** Removes the item. Returns false when there was nothing to remove, so deleting twice is not an error. */
  async delete(account: string): Promise<boolean> {
    assertAccount(account);
    const result = await this.run([SECURITY_BIN, "delete-generic-password", "-a", account, "-s", this.service], "");
    if (result.exitCode === NOT_FOUND_EXIT) return false;
    if (result.exitCode !== 0) throw failure("delete", account, result);
    return true;
  }

  /**
   * Which of `accounts` hold a value. Booleans only -- this is what a UI is allowed to know.
   *
   * It probes each account with a find that omits `-w` (and `-g`), so `security` reports the item's ATTRIBUTES
   * and never its password: the value is not merely discarded here, it is never read out of the keychain in the
   * first place, so there is no plaintext in Main's memory to leak.
   *
   * The caller supplies the account list rather than the store enumerating one. The only way to enumerate items
   * by service is `security dump-keychain`, which dumps the user's ENTIRE keychain -- every unrelated password
   * they own -- and raises an access prompt per item. Reading all of a user's secrets to discover the names of
   * four of our own is a far worse trade than asking the caller which four it means, and the caller (the AI
   * settings pane, the accounts pane) always knows.
   */
  async status(accounts: readonly string[]): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      accounts.map(async (account) => {
        assertAccount(account);
        const result = await this.run([SECURITY_BIN, "find-generic-password", "-a", account, "-s", this.service], "");
        if (result.exitCode === NOT_FOUND_EXIT) return [account, false] as const;
        if (result.exitCode !== 0) throw failure("check", account, result);
        return [account, true] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
}

function assertAccount(account: string): void {
  if (!ACCOUNT_PATTERN.test(account)) throw new Error(`Invalid Keychain account name: ${JSON.stringify(account)}`);
}

/**
 * The error for a failed `security` call.
 *
 * It names the account and quotes `security`'s own stderr, and it is built from neither the value nor anything
 * derived from it. That matters more than it looks: the base64 of a secret IS the secret, so an error that
 * helpfully included "the payload we sent" would leak just as completely as one that printed the key.
 */
function failure(action: string, account: string, result: KeychainResult): Error {
  const detail = result.stderr.trim() || `exit ${result.exitCode}`;
  return new Error(`Couldn't ${action} the Keychain item for ${account}: ${detail}`);
}
