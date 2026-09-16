import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishStandardFixtures, startTestRegistry, type TestRegistry } from "@jslab/test-registry";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

const NL = String.fromCharCode(10);

let registry: TestRegistry;
let work = "";
let apps: LaunchedApp[] = [];

beforeAll(async () => {
  registry = await startTestRegistry();
  work = await mkdtemp(join(tmpdir(), "jl-npm-"));
  await publishStandardFixtures(registry.url, work, { zod: true });
}, 300_000);

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
interface TsDiagnostic {
  code: number;
  message: string;
}

async function launchWithRegistry(options: { settings?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const userData = await createUserData();
  await mkdir(join(userData, "packages"), { recursive: true });
  await writeFile(join(userData, "packages", ".npmrc"), `registry=${registry.url}${NL}`);
  const app = await launchApp({
    userData,
    settings: { version: 3, run: { autoRun: false }, ...options.settings },
    env: { JSLAB_E2E_BUN_CACHE_DIR: join(work, "bun-cache"), ...options.env },
  });
  apps.push(app);
  return app;
}

const npmOf = async (app: LaunchedApp) => (await app.state()).ui.npm as NpmSnapshot;

async function waitForInstalled(app: LaunchedApp, name: string, version?: string) {
  await waitFor(
    async () => {
      const npm = await npmOf(app);
      const failed = npm.operations.find((op) => op.target.startsWith(name) && op.status === "failed");
      if (failed) throw new Error(`install of ${name} failed: ${failed.errorKind}`);
      return npm.installed.some((pkg) => pkg.name === name && (!version || pkg.version === version)) || null;
    },
    { timeoutMs: 180_000, message: `${name} was never installed` },
  );
}

async function typeCode(app: LaunchedApp, code: string) {
  await app.type(code);
  await waitFor(async () => activeTab(await app.state()).code === code || null);
}

async function installActions(app: LaunchedApp, predicate: (actions: { spec: string }[]) => boolean) {
  return waitFor(
    async () => {
      const reply = await app.client.call<{ result: { actions: { title: string; spec: string }[] } }>("e2e.command", {
        id: "e2e.installActions",
      });
      return predicate(reply.result.actions) ? reply.result.actions : null;
    },
    { timeoutMs: 60_000, message: "the expected install action never appeared" },
  );
}

describe("npm packages against the local test registry (opt-in)", () => {
  test("M3 exit: install zod, import it through a working-directory file with types and autocomplete, and run it", async () => {
    const app = await launchWithRegistry();
    const wd = join(app.userData, "api");
    await mkdir(wd, { recursive: true });
    await writeFile(
      join(wd, "user.ts"),
      `import { z } from "zod";${NL}export const User = z.object({ name: z.string() });${NL}`,
    );

    await app.key("cmd+i");
    await waitFor(async () => (await app.state()).ui.modal === "npm" || null);
    await app.command("npm.install", { spec: "zod@4.6.4" });
    await waitForInstalled(app, "zod", "4.6.4");
    await app.key("escape");
    await waitFor(async () => (await app.state()).ui.modal === null || null);

    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([wd]));
    await app.command("wd.set");
    await waitFor(async () => activeTab(await app.state()).workingDirectory === wd || null);

    const code = [
      'import { User } from "./user";',
      'const parsed = User.parse({ name: "Ada" });',
      "const wrong: number = parsed.name;",
      "console.log(parsed.name);",
      "User.parse",
    ].join(NL);
    await typeCode(app, code);
    await app.command("run.start");
    await app.waitForOutput(
      (entries) => entries.some((entry) => entry.kind === "console" && entry.text === "Ada"),
      60_000,
    );

    const diagnostics = await waitFor(
      async () => {
        const found = ((await app.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[];
        return found.some((d) => d.code === 2322) ? found : null;
      },
      { timeoutMs: 60_000, message: "zod's types never reached the editor" },
    );
    expect(diagnostics.filter((d) => d.code === 2307)).toEqual([]);
    const reply = await app.client.call<{ result: { completions: string[] } }>("e2e.command", {
      id: "e2e.completions",
      args: { offset: code.lastIndexOf("parse") },
    });
    expect(reply.result.completions).toEqual(expect.arrayContaining(["parse", "safeParse"]));
  });

  test("install assist offers the package, then its @types package, and types arrive after installing it (ED-26, TL-04)", async () => {
    const app = await launchWithRegistry();
    await typeCode(app, `import fixture from "fixture-untyped";${NL}console.log(fixture.untyped);`);
    await installActions(app, (actions) => actions.some((action) => action.spec === "fixture-untyped"));
    await app.command("npm.install", { spec: "fixture-untyped" });
    await waitForInstalled(app, "fixture-untyped");
    await app.command("run.start");
    await app.waitForOutput(
      (entries) => entries.some((entry) => entry.kind === "console" && entry.text === "yes"),
      60_000,
    );
    await installActions(app, (actions) => actions.some((action) => action.spec === "@types/fixture-untyped"));
    await app.command("npm.install", { spec: "@types/fixture-untyped" });
    await waitForInstalled(app, "@types/fixture-untyped");
    await waitFor(
      async () =>
        (((await app.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[]).every((d) => d.code !== 2307) || null,
      { timeoutMs: 60_000, message: "the @types package never cleared the missing-module diagnostic" },
    );
  });

  test("allowed install scripts run with trustedDependencies, and automatic types install @types (TL-07, XT-12)", async () => {
    const app = await launchWithRegistry({ settings: { npm: { allowInstallScripts: true, autoInstallTypes: true } } });
    await app.command("npm.install", { spec: "fixture-script@1.0.0" });
    await waitForInstalled(app, "fixture-script", "1.0.0");
    expect(existsSync(join(app.userData, "packages", "node_modules", "fixture-script", "postinstall-ran.txt"))).toBe(
      true,
    );
    expect(
      JSON.parse(readFileSync(join(app.userData, "packages", "package.json"), "utf8")).trustedDependencies,
    ).toEqual(["fixture-script"]);
    await app.command("npm.install", { spec: "fixture-untyped@1.0.0" });
    await waitForInstalled(app, "@types/fixture-untyped");
  });

  test("in the app, a dead scoped registry in HOME's .npmrc never reaches npm operations (M0-S8, TL-10)", async () => {
    const fakeHome = join(work, "fake-home");
    await mkdir(fakeHome, { recursive: true });
    await writeFile(join(fakeHome, ".npmrc"), `@jslab-fixture:registry=http://127.0.0.1:9/${NL}`);
    const app = await launchWithRegistry({ env: { HOME: fakeHome } });
    await app.command("npm.install", { spec: "@jslab-fixture/scoped@1.0.0" });
    await waitForInstalled(app, "@jslab-fixture/scoped", "1.0.0");
    expect(readdirSync(join(app.userData, "npm-home"))).toEqual([]);
    expect(readFileSync(join(fakeHome, ".npmrc"), "utf8")).toBe(`@jslab-fixture:registry=http://127.0.0.1:9/${NL}`);
  });
});
