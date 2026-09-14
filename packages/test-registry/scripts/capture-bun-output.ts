import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { npmEnvironment } from "@jslab/npm";
import { defaultPackagesManifest } from "@jslab/shared";
import { normalizeOutput, publishStandardFixtures, startTestRegistry } from "../src";

const OUT = resolve(import.meta.dir, "../../npm/test/fixtures/bun-output");
const created = await mkdtemp(join(tmpdir(), "jslab-capture-"));
// Bun may print either spelling of the temp root (/var/… or /private/var/…); both are normalized.
const root = await realpath(created);
const registry = await startTestRegistry();
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

try {
  await publishStandardFixtures(registry.url, join(root, "work"));
  const replacements: [string, string][] = [
    [root, "<TMP>"],
    [created, "<TMP>"],
    [registry.url, "<REGISTRY>/"],
    [registry.url.replace(/\/$/, ""), "<REGISTRY>"],
  ];

  const project = async (name: string, registryLine: string) => {
    const dir = join(root, name);
    await mkdir(join(dir, "npm-home"), { recursive: true });
    await mkdir(join(dir, "project"), { recursive: true });
    await writeFile(join(dir, "project", "package.json"), JSON.stringify(defaultPackagesManifest(), null, 2));
    await writeFile(join(dir, "project", ".npmrc"), `${registryLine}\n`);
    return {
      cwd: join(dir, "project"),
      env: npmEnvironment({
        base: { PATH: process.env.PATH, TMPDIR: tmpdir() },
        npmHome: join(dir, "npm-home"),
        bunCacheDir: join(dir, "cache"),
      }),
    };
  };

  const run = async (name: string, argv: string[], where: { cwd: string; env: Record<string, string> }) => {
    const proc = Bun.spawn([process.execPath, ...argv], {
      cwd: where.cwd,
      env: where.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const fixture = {
      name,
      argv,
      exitCode,
      stdout: normalizeOutput(stdout, replacements),
      stderr: normalizeOutput(stderr, replacements),
      bunVersion: Bun.version,
    };
    await writeFile(join(OUT, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    return fixture;
  };

  await mkdir(OUT, { recursive: true });
  check(Bun.version === "1.4.0", `expected the bundled Bun 1.4.0, got ${Bun.version}`);

  const main = await project("main", `registry=${registry.url}`);
  const addOk = await run("add-ok", ["add", "--exact", "fixture-outdated@1.0.0"], main);
  check(
    addOk.exitCode === 0 && /installed fixture-outdated@1\.0\.0/.test(addOk.stdout),
    "add-ok: exit 0 with 'installed fixture-outdated@1.0.0'",
  );

  const blocked = await run("add-script-blocked", ["add", "--exact", "fixture-script@1.0.0"], main);
  check(
    blocked.exitCode === 0 && /blocked \d+ postinstall/i.test(blocked.stdout + blocked.stderr),
    "add-script-blocked: exit 0 with 'Blocked N postinstall'",
  );

  const outdated = await run("outdated", ["outdated"], main);
  const table = outdated.stdout + outdated.stderr;
  check(
    outdated.exitCode === 0 &&
      /Package/.test(table) &&
      /Current/.test(table) &&
      /Latest/.test(table) &&
      /fixture-outdated/.test(table) &&
      /1\.1\.0/.test(table),
    "outdated: exit 0 with a Package/Current/Latest table listing fixture-outdated 1.1.0",
  );

  const notFound = await run("add-not-found", ["add", "--exact", "jslab-fixture-missing"], main);
  check(
    notFound.exitCode !== 0 && /404|not found/i.test(notFound.stdout + notFound.stderr),
    "add-not-found: non-zero with 404 or 'not found'",
  );

  const noVersion = await run("add-no-matching-version", ["add", "--exact", "fixture-outdated@9.9.9"], main);
  check(
    noVersion.exitCode !== 0 && /no version matching|etarget/i.test(noVersion.stdout + noVersion.stderr),
    "add-no-matching-version: non-zero with 'No version matching' or ETARGET",
  );

  const removeOk = await run("remove-ok", ["remove", "fixture-outdated"], main);
  check(removeOk.exitCode === 0, "remove-ok: exit 0");
  await run("remove-missing", ["remove", "jslab-not-installed"], main);

  const dead = await project("dead", "registry=http://127.0.0.1:9/");
  const network = await run("add-network", ["add", "--exact", "fixture-outdated@1.0.0"], dead);
  check(
    network.exitCode !== 0 && /connectionrefused|econnrefused|unable to connect/i.test(network.stdout + network.stderr),
    "add-network: non-zero with ConnectionRefused",
  );

  // Which folder Bun uses as its package cache for each environment (checks resolveBunCacheDir's order). Read-only:
  // every folder is under the temp root.
  const fake = (name: string) => join(root, "cache-order", name);
  const cases: Record<string, string>[] = [
    { BUN_INSTALL_CACHE_DIR: fake("explicit") },
    { XDG_CACHE_HOME: fake("xdg") },
    { BUN_INSTALL: fake("bun-install") },
    { XDG_CACHE_HOME: fake("xdg"), BUN_INSTALL: fake("bun-install") },
    {},
  ];
  const expected = [
    fake("explicit"),
    `${fake("xdg")}/.bun/install/cache`,
    `${fake("bun-install")}/install/cache`,
    `${fake("bun-install")}/install/cache`,
    `${fake("home")}/.bun/install/cache`,
  ];
  const printed: { env: Record<string, string>; printed: string }[] = [];
  for (const [index, extra] of cases.entries()) {
    const proc = Bun.spawnSync([process.execPath, "pm", "cache"], {
      cwd: main.cwd,
      env: { PATH: process.env.PATH ?? "", HOME: fake("home"), TMPDIR: tmpdir(), NO_COLOR: "1", ...extra },
    });
    const line = proc.stdout.toString().trim();
    printed.push({
      env: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, normalizeOutput(v, replacements)])),
      printed: normalizeOutput(line, replacements),
    });
    check(line === expected[index], `pm cache case ${index}: expected ${expected[index]}, Bun printed ${line}`);
  }
  await writeFile(
    join(OUT, "pm-cache.json"),
    `${JSON.stringify({ bunVersion: Bun.version, cases: printed }, null, 2)}\n`,
  );
} finally {
  await registry.stop();
  await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`Capture assumptions failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Captured bun ${Bun.version} output into ${OUT}`);
