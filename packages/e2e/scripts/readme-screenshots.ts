/**
 * Captures the README screenshots from a dev build: `bun run readme:screenshots` from the repo root.
 *
 * It drives JSLab through the E2E harness (`launchApp`), so the usual launch rules apply: an internal-disk working
 * directory, a private temp data folder and PID-scoped teardown. Each capture is window-only (`e2e.screenshot`) and
 * needs Screen Recording access for the JSLab dev app, which this script never requests. PNGs land in `docs/images/`,
 * resized with `sips` to at most MAX_WIDTH pixels wide.
 *
 * Not a test: it lives outside `scenarios/` and `test/`, so `bun test` and `bun run e2e` never pick it up.
 */
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type LaunchedApp, launchApp, type OutputEntry, REPO_ROOT, waitFor } from "../src";

const OUT_DIR = join(REPO_ROOT, "docs/images");
const MAX_WIDTH = 1600;
const RUN_TIMEOUT_MS = 30_000;

const FIRST_TAB = `// Format a relative date
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

rtf.format(-1, "day")
rtf.format(3, "week")
`;

const SECOND_TAB = `// Retry with backoff
const delays = Array.from({ length: 5 }, (_, attempt) => 2 ** attempt * 100);
delays //?
`;

const HERO = `// Order totals by region
interface Order {
  region: string;
  total: number;
  paid: boolean;
}

const orders: Order[] = [
  { region: "EU", total: 120, paid: true },
  { region: "US", total: 80, paid: false },
  { region: "EU", total: 45.5, paid: true },
  { region: "APAC", total: 210, paid: true },
];

const paid = orders.filter((o) => o.paid);
paid.length //?

const byRegion: Record<string, number> = {};
for (const { region, total } of paid) {
  byRegion[region] = (byRegion[region] ?? 0) + total;
}
byRegion

const revenue = paid.reduce((s, o) => s + o.total, 0);
console.log("Revenue:", revenue);

const [top] = Object.entries(byRegion)
  .sort(([, a], [, b]) => b - a)[0] ?? [];
\`Top region: \${top}\`
`;

const ERRORS = `// Read nested config
const config: any = { theme: "graphite", fontSize: 15 };
console.log("Loaded keys:", Object.keys(config));
console.warn("No editor section, using defaults");

function tabWidth(settings: any) {
  return settings.editor.tabWidth;
}

tabWidth(config);
`;

class ScreenRecordingUnavailable extends Error {}

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} exited with ${code}: ${err.trim()}`);
  return out;
}

async function pixelWidth(file: string): Promise<number> {
  const match = /pixelWidth:\s*(\d+)/.exec(await run(["sips", "-g", "pixelWidth", file]));
  if (!match?.[1]) throw new Error(`sips reported no width for ${file}`);
  return Number(match[1]);
}

/** Captures one window and writes `docs/images/<name>.png`, downscaled when wider than MAX_WIDTH. */
async function capture(app: LaunchedApp, name: string, window: "main" | "settings" = "main"): Promise<void> {
  const reply = await app.client.call<{ path?: string; skipped?: string }>("e2e.screenshot", { name, window });
  if (reply.skipped) throw new ScreenRecordingUnavailable(reply.skipped);
  if (!reply.path) throw new Error(`e2e.screenshot returned no path for ${name}`);
  const target = join(OUT_DIR, `${name}.png`);
  if ((await pixelWidth(reply.path)) > MAX_WIDTH) {
    await run(["sips", "--resampleWidth", String(MAX_WIDTH), reply.path, "--out", target]);
  } else {
    await copyFile(reply.path, target);
  }
  const { size } = await stat(target);
  console.log(`  ${name}.png  ${await pixelWidth(target)} px wide, ${Math.round(size / 1024)} KB`);
}

async function typeAndRun(app: LaunchedApp, code: string, done: (entries: OutputEntry[]) => boolean) {
  await app.type(code);
  await waitFor(async () => activeTab(await app.state()).code === code || null, { message: "The code never landed" });
  try {
    await app.waitForOutput(done, RUN_TIMEOUT_MS);
    await app.waitForRunState(["settled", "idle", "failed"], RUN_TIMEOUT_MS);
  } catch (error) {
    const tab = activeTab(await app.state());
    console.error(`Tab "${tab.title}": run state ${tab.runState}, output ${JSON.stringify(await app.output())}`);
    throw error;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const userData = await createUserData();
  // A fixed window frame and a neutral installed-fonts list, so every capture has the same size and shows nothing
  // from this machine.
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({ version: 2, window: { x: 120, y: 80, width: 1280, height: 820 } }),
  );
  await mkdir(join(userData, "cache"), { recursive: true });
  await writeFile(
    join(userData, "cache", "system-fonts.json"),
    JSON.stringify({ at: Date.now(), fonts: { monospace: ["Menlo", "SF Mono"], other: ["Helvetica Neue"] } }),
  );

  const app = await launchApp({
    userData,
    settings: { version: 2, appearance: { theme: "graphite", fontSize: 15 }, view: { layout: "horizontal" } },
  });
  try {
    console.log("Capturing README screenshots:");

    // 1. Hero: three scratch tabs, the active one a TypeScript transform with line-anchored results and logs.
    await typeAndRun(app, FIRST_TAB, (entries) => entries.length >= 2);
    await app.newTab();
    await typeAndRun(app, SECOND_TAB, (entries) => entries.length >= 1);
    await app.newTab();
    await typeAndRun(app, HERO, (entries) =>
      entries.some((entry) => entry.kind === "result" && entry.text === "Top region: APAC"),
    );
    await capture(app, "hero-editor-output");

    // 2. Command palette with a query, showing highlights, sections and keycaps.
    await app.key("cmd+shift+p");
    await waitFor(async () => (await app.state()).ui.modal === "palette" || null);
    await app.type("tog");
    await capture(app, "command-palette");
    await app.key("escape");
    await waitFor(async () => (await app.state()).ui.modal === null || null);

    // 3. The hero scene in Graphite Light.
    await app.command("theme.select", { themeId: "graphite-light" });
    await waitFor(async () => (await app.state()).ui.themeId === "graphite-light" || null);
    await capture(app, "graphite-light");
    await app.command("theme.select", { themeId: "graphite" });
    await waitFor(async () => (await app.state()).ui.themeId === "graphite" || null);

    // 4. A runtime error after a few logs, then the Errors filter chip.
    await app.newTab();
    await typeAndRun(app, ERRORS, (entries) => entries.some((entry) => entry.kind === "error"));
    await capture(app, "output-errors");
    await app.command("output.showErrors");
    await waitFor(async () => (await app.state()).ui.outputFilter === "errors" || null);
    await capture(app, "output-errors-filter");
    await app.command("output.showAll");
    await waitFor(async () => (await app.state()).ui.outputFilter === "all" || null);

    // 5. Settings → Appearance.
    await app.key("cmd+,");
    await waitFor(async () => (await app.settingsState())?.ready || null, { timeoutMs: 45_000 });
    await app.settingsCommand("settings.tab", { tab: "appearance" });
    await waitFor(async () => (await app.settingsState())?.tab === "appearance" || null);
    await capture(app, "settings-appearance", "settings");

    console.log(`Done. Images are in ${OUT_DIR}`);
  } finally {
    await app.dispose();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ScreenRecordingUnavailable) {
    console.error(
      `Screenshot skipped (${error.message}). Grant Screen Recording to the JSLab dev app in System Settings → ` +
        "Privacy & Security → Screen Recording, then rerun `bun run readme:screenshots`.",
    );
    process.exit(2);
  }
  throw error;
}
