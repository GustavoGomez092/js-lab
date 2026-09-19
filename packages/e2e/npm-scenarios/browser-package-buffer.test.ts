import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { publishPackage, startTestRegistry, type TestRegistry } from "@jslab/test-registry";
import { activeTab, createUserData, type LaunchedApp, launchApp, REPO_ROOT, waitFor } from "../src";

/**
 * The user report this file exists for (M4): in a `browser` tab,
 *
 *     import { nanoid } from 'nanoid'
 *     const nanoId: string = nanoid()
 *
 * failed with `ReferenceError: Can't find variable: Buffer`, because `resolve-plugin.ts` resolved the bare
 * specifier with `Bun.resolveSync` -- the *runtime* resolver, which knows nothing about the `browser` export
 * condition -- and handed `Bun.build({target:"browser"})` a concrete path to nanoid's **node** entry. That entry
 * calls `Buffer.allocUnsafe`, and a WebKit page has no `Buffer`. `browserEntryFor` (85186c8) re-resolves through
 * the `exports` map under browser conditions, and `vendor-chunk-v5` (6ec7a91) makes every chunk bundled by the old
 * resolver unaddressable.
 *
 * **The user's own hypothesis is tested here as a variable, not assumed away.** They observed that the app copies
 * where packages worked were the ones with no Web View loaded, and asked whether the Web View being active is what
 * makes the difference. So the same import runs three ways: a `browser` tab with the Web View **shown**, a
 * `browser` tab with it **hidden** (the default), and a `bun` tab (the default runtime, which has no Web View at
 * all and a real `Buffer`). Whichever of `runtime` and Web View visibility actually decides the outcome, these
 * three cases separate them.
 *
 * **The chunk on disk is the real proof.** Each browser case asserts the vendor chunk the run actually produced
 * contains zero `Buffer.allocUnsafe` and does contain `crypto.getRandomValues` -- nanoid's browser entry's own
 * marker. Every launch gets a fresh, private data folder, so the chunk found there was produced by that run and
 * cannot have been served from an earlier one; the tests assert the cache was empty beforehand as well.
 *
 * Both versions are republished into the loopback test registry from a package folder already on this machine:
 * this repo's own installed `nanoid@3.3.19` (a transitive dependency) and Bun's on-disk install cache for
 * `nanoid@6.0.1`, overridable with `JSLAB_E2E_NANOID_6_DIR`. **Nothing here ever reaches the public npm registry.**
 * The two versions have different manifest shapes -- v3 declares `exports["."].browser` *and* a top-level `browser`
 * map, v6 the same but with a flatter `exports` -- and both node entries call `Buffer.allocUnsafe`, so each is a
 * genuine reproduction of the reported failure.
 */

const NANOID_V3 = "3.3.19";
const NANOID_V6 = "6.0.1";

let registry: TestRegistry;
let work = "";
let apps: LaunchedApp[] = [];

/** Candidate local package folders for a nanoid version, in preference order. Never a network fetch. */
function nanoidSourceCandidates(version: string): string[] {
  const override = version === NANOID_V6 ? process.env.JSLAB_E2E_NANOID_6_DIR : process.env.JSLAB_E2E_NANOID_3_DIR;
  return [
    ...(override ? [override] : []),
    join(REPO_ROOT, "node_modules", ".bun", `nanoid@${version}`, "node_modules", "nanoid"),
    join(homedir(), ".bun", "install", "cache", `nanoid@${version}@@@1`),
  ];
}

/** Republishes a local nanoid package folder into the loopback registry, pinned to `version`. */
async function publishNanoid(version: string, src: string): Promise<void> {
  for (const from of nanoidSourceCandidates(version)) {
    const manifest = Bun.file(join(from, "package.json"));
    if (!(await manifest.exists())) continue;
    if ((JSON.parse(await manifest.text()) as { version: string }).version !== version) continue;
    const dir = join(src, `nanoid@${version}`);
    await cp(from, dir, { recursive: true, dereference: true });
    await publishPackage(registry.url, dir, work);
    return;
  }
  throw new Error(
    `No local nanoid@${version} to republish. This suite never uses the public npm registry, so point ` +
      `JSLAB_E2E_NANOID_${version.startsWith("6") ? "6" : "3"}_DIR at a local nanoid@${version} package folder.`,
  );
}

beforeAll(async () => {
  registry = await startTestRegistry();
  work = await mkdtemp(join(tmpdir(), "jl-buf-"));
  const src = join(work, "fixtures");
  await mkdir(src, { recursive: true });
  await publishNanoid(NANOID_V3, src);
  await publishNanoid(NANOID_V6, src);
}, 600_000);

afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

afterAll(async () => {
  await registry?.stop();
  await rm(work, { recursive: true, force: true });
});

interface NpmSnapshot {
  installed: { name: string; version: string | null }[];
  operations: { target: string; status: string; errorKind: string | null }[];
}

async function launchWithRegistry() {
  const userData = await createUserData();
  await mkdir(join(userData, "packages"), { recursive: true });
  await writeFile(join(userData, "packages", ".npmrc"), `registry=${registry.url}\n`);
  const app = await launchApp({
    userData,
    settings: { version: 3, run: { autoRun: false } },
    env: { JSLAB_E2E_BUN_CACHE_DIR: join(work, "bun-cache") },
  });
  apps.push(app);
  return app;
}

async function install(app: LaunchedApp, name: string, version: string) {
  await app.command("npm.install", { spec: `${name}@${version}` });
  await waitFor(
    async () => {
      const npm = (await app.state()).ui.npm as NpmSnapshot;
      const failed = npm.operations.find((op) => op.target.startsWith(name) && op.status === "failed");
      if (failed) throw new Error(`install of ${name}@${version} failed: ${failed.errorKind}`);
      return npm.installed.some((pkg) => pkg.name === name && pkg.version === version) || null;
    },
    { timeoutMs: 300_000, message: `nanoid@${version} was never installed` },
  );
}

/** The `.js` chunks the web runner's vendor cache currently holds for this launch (`<userData>/cache/vendor`). */
async function vendorChunks(userData: string): Promise<{ file: string; code: string }[]> {
  const dir = join(userData, "cache", "vendor");
  const names = await readdir(dir).catch(() => [] as string[]);
  const chunks = names.filter((name) => name.endsWith(".js") && !name.endsWith(".js.map"));
  return Promise.all(
    chunks.map(async (name) => ({ file: join(dir, name), code: await readFile(join(dir, name), "utf8") })),
  );
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** The user's snippet verbatim, plus one line that proves the call actually returned an id. */
const nanoidProgram = [
  'import { nanoid } from "nanoid";',
  "const nanoId: string = nanoid();",
  'console.log("nanoid:" + typeof nanoId + ":" + nanoId.length);',
];

async function typeProgram(app: LaunchedApp) {
  const code = nanoidProgram.join("\n");
  await app.command("language.typescript");
  await app.type(code);
  await waitFor(async () => activeTab(await app.state()).code === code || null, {
    message: "the editor never took the typed code",
  });
}

const consoleText = (entries: { kind: string; text: string }[]) =>
  entries.filter((entry) => entry.kind === "console").map((entry) => entry.text);

/**
 * Output entries of any kind that mention `Buffer`. The reported failure arrives as an error entry reading
 * `ReferenceError: Can't find variable: Buffer`, so matching on the text catches it whatever kind carries it.
 */
const bufferEntries = (entries: { kind: string; text: string }[]) =>
  entries.filter((entry) => entry.text.includes("Buffer"));

/** Error-kind entries: whatever the run failed with, in the run's own words. */
const errorEntries = (entries: { kind: string; text: string }[]) => entries.filter((entry) => entry.kind === "error");

/** `kind: text` per entry -- the form every failure here quotes. */
const quoted = (entries: { kind: string; text: string }[]) => entries.map((entry) => `${entry.kind}: ${entry.text}`);

/** Fails quoting every offending entry, so the failure names the reported error instead of implying it. */
function expectNoBufferEntries(entries: { kind: string; text: string }[]) {
  expect(quoted(bufferEntries(entries))).toEqual([]);
}

/**
 * Waits for the success line, **racing it against failure** so a regression names itself.
 *
 * Waiting only for `nanoid:` meant that when the bug came back the run sat here until the 180 s timeout and then
 * died with "Expected output never appeared" -- `expectNoBufferError`, the one assertion that would have named
 * `Buffer`, was never reached, so a real regression cost ~13 minutes to report "something broke". The predicate
 * therefore also accepts a `Buffer` entry *and* any error entry; whichever lands first ends the wait, and the
 * assertions below then run on those same entries.
 *
 * Both extra branches earn their place, and the mutant proves why. Cutting `browserEntryFor` sends nanoid 6 into a
 * web tab as its node entry, which throws `ReferenceError: Can't find variable: Buffer` -- the `Buffer` branch
 * catches that in ~16 s. But nanoid 3 under the very same mutation never emits a `Buffer` entry at all; it fails
 * earlier and differently, so with only the `Buffer` branch that one case still burned the full 180 s and reported
 * nothing usable. The error branch names it too.
 *
 * Neither branch can make a clean run flaky. Output entries accumulate for the life of a run, so the set this
 * predicate sees only ever grows, and every passing case ends with `expectNoBufferError` asserting the final set
 * holds no `Buffer` entry -- so none existed at any earlier moment either. The error branch is held to the same
 * standard by the assertion below: a healthy run reaches its success line with no error entry at all.
 */
async function waitForNanoidLine(app: LaunchedApp, timeoutMs = 180_000) {
  let entries: { kind: string; text: string }[];
  try {
    entries = await app.waitForOutput(
      (all) =>
        all.some((entry) => entry.kind === "console" && entry.text.startsWith("nanoid:")) ||
        bufferEntries(all).length > 0 ||
        errorEntries(all).length > 0,
      timeoutMs,
    );
  } catch (timedOut) {
    // Nothing decisive ever arrived. Report what the run *did* produce: "Expected output never appeared" on its
    // own sends the reader back for another 13-minute run just to find out what was on screen.
    const seen = quoted(await app.output());
    throw new Error(
      `${String(timedOut)} -- no \`nanoid:\` line, no \`Buffer\` entry and no error entry ever arrived. ` +
        `Output actually seen (${seen.length} entries): ${seen.length > 0 ? seen.join(" | ") : "(none)"}`,
    );
  }
  expectNoBufferEntries(entries);
  expect(quoted(errorEntries(entries))).toEqual([]);
  return consoleText(entries).find((text) => text.startsWith("nanoid:")) as string;
}

/**
 * The end-of-run check that no output entry of any kind mentions `Buffer`. `waitForNanoidLine` now races the same
 * condition, so this covers the narrower case of an entry that lands only *after* the success line.
 */
async function expectNoBufferError(app: LaunchedApp) {
  expectNoBufferEntries(await app.output());
}

/**
 * The strongest available evidence: the vendor chunk this run actually produced carries nanoid's **browser**
 * entry. Zero `Buffer.allocUnsafe` (the node entry's marker, and the exact call the user's error came from) and at
 * least one `crypto.getRandomValues` (the browser entry's).
 */
function expectBrowserEntryChunk(chunks: { file: string; code: string }[], version: string, label: string) {
  expect(chunks.length).toBeGreaterThan(0);
  const combined = chunks.map((chunk) => chunk.code).join("\n");
  const allocUnsafe = occurrences(combined, "allocUnsafe");
  const getRandomValues = occurrences(combined, "getRandomValues");
  console.log(
    `[evidence] nanoid@${version} ${label}: ${chunks.length} vendor chunk(s), ` +
      `allocUnsafe=${allocUnsafe}, getRandomValues=${getRandomValues}, files=${chunks
        .map((chunk) => chunk.file)
        .join(",")}`,
  );
  expect(allocUnsafe).toBe(0);
  expect(getRandomValues).toBeGreaterThan(0);
}

/**
 * Runs the user's snippet in a web tab and returns the chunk the run produced.
 *
 * `showWebView` drives `view.toggleWebView` -- the same command the View menu, the palette and the status-bar
 * button dispatch -- and waits until the tile really is on screen, so the Web View's visibility is a controlled
 * variable here rather than an assumption.
 */
async function runInWebTab(options: {
  version: string;
  runtimeCommand: string;
  runtime: string;
  showWebView: boolean;
  label: string;
}) {
  const app = await launchWithRegistry();
  await install(app, "nanoid", options.version);

  await app.command(options.runtimeCommand);
  await waitFor(async () => activeTab(await app.state()).runtime === options.runtime || null, {
    message: `the tab never switched to ${options.runtime}`,
  });

  if (options.showWebView) {
    await app.command("view.toggleWebView");
    await waitFor(
      async () => ((await app.state()).ui.regions as Record<string, boolean>).webViewTile === true || null,
      {
        timeoutMs: 20_000,
        message: "the Web View tile was never shown",
      },
    );
  }
  // Whatever the toggle did, record what it actually produced rather than trusting the request.
  const webViewShown = ((await app.state()).ui.regions as Record<string, boolean>).webViewTile === true;
  expect(webViewShown).toBe(options.showWebView);

  // Nothing has bundled yet, so anything found afterwards was produced by this run -- never served from a
  // previous one. (Each launch also gets its own fresh data folder, so there is no older generation to inherit.)
  expect(await vendorChunks(app.userData)).toEqual([]);

  await typeProgram(app);
  await app.command("run.start");

  const line = await waitForNanoidLine(app);
  await expectNoBufferError(app);
  const chunks = await vendorChunks(app.userData);
  expectBrowserEntryChunk(chunks, options.version, options.label);
  return { app, line };
}

describe("an npm package's browser entry reaches a web tab (user report: Can't find variable: Buffer)", () => {
  test("nanoid@6.0.1 imports and runs in a browser tab with the Web View SHOWN", async () => {
    const { line } = await runInWebTab({
      version: NANOID_V6,
      runtimeCommand: "runtime.browser",
      runtime: "browser",
      showWebView: true,
      label: "browser/web-view-shown",
    });
    expect(line).toBe("nanoid:string:21");
  }, 600_000);

  test("nanoid@6.0.1 imports and runs in a browser tab with the Web View HIDDEN", async () => {
    const { line } = await runInWebTab({
      version: NANOID_V6,
      runtimeCommand: "runtime.browser",
      runtime: "browser",
      showWebView: false,
      label: "browser/web-view-hidden",
    });
    expect(line).toBe("nanoid:string:21");
  }, 600_000);

  test("nanoid@3.3.19 imports and runs in a browser tab (the older exports shape)", async () => {
    const { line } = await runInWebTab({
      version: NANOID_V3,
      runtimeCommand: "runtime.browser",
      runtime: "browser",
      showWebView: true,
      label: "browser/v3",
    });
    expect(line).toBe("nanoid:string:21");
  }, 600_000);

  test("nanoid@6.0.1 imports and runs in a browser-node tab as well", async () => {
    const { line } = await runInWebTab({
      version: NANOID_V6,
      runtimeCommand: "runtime.browserNode",
      runtime: "browser-node",
      showWebView: true,
      label: "browser-node",
    });
    expect(line).toBe("nanoid:string:21");
  }, 600_000);

  /**
   * The control for the user's observation. A tab with no Web View is a `bun` tab -- `bun` is the default runtime,
   * and spec §7.1 gives a `bun` tab no Web View tile at all -- and under Bun the node entry's `Buffer` genuinely
   * exists, which is why packages always worked there. This pins that half so the three browser cases above are
   * read against a known-good baseline rather than in isolation.
   */
  test("nanoid@6.0.1 also runs in a bun tab, which has no Web View at all (the control)", async () => {
    const app = await launchWithRegistry();
    await install(app, "nanoid", NANOID_V6);
    expect(activeTab(await app.state()).runtime).toBe("bun");
    expect(((await app.state()).ui.regions as Record<string, boolean>).webViewTile).toBe(false);

    await typeProgram(app);
    await app.command("run.start");
    expect(await waitForNanoidLine(app)).toBe("nanoid:string:21");
    await expectNoBufferError(app);
    // A bun run never bundles for the web, so it leaves the vendor cache untouched.
    expect(await vendorChunks(app.userData)).toEqual([]);
  }, 600_000);
});
