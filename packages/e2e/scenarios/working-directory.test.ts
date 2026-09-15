import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

async function pickFolder(target: LaunchedApp, folder: string) {
  await writeFile(join(target.userData, "e2e-open-dialog.json"), JSON.stringify([folder]));
  await target.command("wd.set");
  await waitFor(async () => activeTab(await target.state()).workingDirectory === folder || null, {
    message: "the working directory was never set",
  });
}

describe("working directory (spec §5.3, §12.2)", () => {
  test("picking a folder sets the chip and label, and runs resolve imports, globals, .env, env.json and node_modules there (EX-30..33)", async () => {
    const userData = await createUserData();
    const wd = join(userData, "api");
    await mkdir(join(wd, "node_modules", "wd-dep"), { recursive: true });
    await writeFile(join(wd, "util.ts"), "export const shout = (text: string): string => text.toUpperCase();\n");
    await writeFile(join(wd, ".env"), "GREETING=from-dotenv\n");
    await writeFile(
      join(wd, "node_modules", "wd-dep", "package.json"),
      JSON.stringify({ name: "wd-dep", main: "index.js" }),
    );
    await writeFile(join(wd, "node_modules", "wd-dep", "index.js"), 'module.exports = { from: "wd" };\n');
    await writeFile(join(userData, "env.json"), JSON.stringify({ version: 1, variables: { FROM_ENV_JSON: "yes" } }));
    await chmod(join(userData, "env.json"), 0o600);
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    const current = app;
    await pickFolder(current, wd);
    expect(activeTab(await current.state()).label).toEndWith(" · api");
    const code = [
      'import { shout } from "./util";',
      'import dep from "wd-dep";',
      'console.log(JSON.stringify({ shout: shout("hi"), dir: __dirname, dotenv: process.env.GREETING, envJson: process.env.FROM_ENV_JSON, dep: dep.from }));',
    ].join("\n");
    await current.type(code);
    await waitFor(async () => activeTab(await current.state()).code === code || null);
    await current.command("run.start");
    const entries = await current.waitForOutput((list) => list.some((entry) => entry.kind === "console"), 30_000);
    expect(JSON.parse(entries.find((entry) => entry.kind === "console")?.text ?? "{}")).toEqual({
      shout: "HI",
      dir: wd,
      dotenv: "from-dotenv",
      envJson: "yes",
      dep: "wd",
    });
  });

  test("a working directory that disappears fails the run with Working directory not found, and clearing it runs again", async () => {
    const userData = await createUserData();
    const wd = join(userData, "gone");
    await mkdir(wd, { recursive: true });
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    const current = app;
    await pickFolder(current, wd);
    await rm(wd, { recursive: true, force: true });
    await current.type("40 + 2");
    await waitFor(async () => activeTab(await current.state()).code === "40 + 2" || null);
    await current.command("run.start");
    await current.waitForOutput((list) =>
      list.some((entry) => entry.kind === "error" && entry.text.includes(`Working directory not found: ${wd}`)),
    );
    await current.command("wd.clear");
    await waitFor(async () => activeTab(await current.state()).workingDirectory === null || null);
    await current.command("run.start");
    await current.waitForOutput((list) => list.some((entry) => entry.kind === "result" && entry.text === "42"));
  });
});
