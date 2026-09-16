import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { copyInstalledPackage, publishPackage, startTestRegistry, type TestRegistry } from "@jslab/test-registry";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * The browser guides that need third-party packages -- React and Three.js -- and the WV-04 exit that runs every
 * guide at once (canvas + `requestAnimationFrame`, React, Three.js and Web Audio in one `browser` tab).
 *
 * **Every package is installed from the loopback test registry, never the public npm registry**, and every version
 * is pinned below. React, React DOM and Scheduler are republished out of this repo's own installed copies; Three.js
 * is not a dependency of this repo, so it is republished from a local package folder -- Bun's on-disk install cache
 * by default, or `JSLAB_E2E_THREE_DIR` if you have the folder somewhere else. Nothing here ever reaches the network
 * beyond 127.0.0.1.
 */

const REACT_VERSION = "19.3.0";
const REACT_DOM_VERSION = "19.3.0";
const THREE_VERSION = "0.184.0";

let registry: TestRegistry;
let work = "";
let apps: LaunchedApp[] = [];

/** The local Three.js package folder to republish, pinned to THREE_VERSION. Never a network fetch. */
function threeSourceDir(): string {
  const override = process.env.JSLAB_E2E_THREE_DIR;
  if (override) return override;
  return join(homedir(), ".bun", "install", "cache", `three@${THREE_VERSION}@@@1`);
}

async function publishThree(src: string): Promise<void> {
  const from = threeSourceDir();
  const manifest = Bun.file(join(from, "package.json"));
  if (!(await manifest.exists())) {
    throw new Error(
      `No local three@${THREE_VERSION} to republish at ${from}. This suite never uses the public npm registry, so ` +
        `point JSLAB_E2E_THREE_DIR at a local three@${THREE_VERSION} package folder (one with package.json and build/).`,
    );
  }
  const version = (JSON.parse(await manifest.text()) as { version: string }).version;
  if (version !== THREE_VERSION) throw new Error(`Expected three@${THREE_VERSION} at ${from}, found ${version}`);
  // Only what the bundler actually needs: the manifest, the build outputs (`build/three.module.js` and the
  // `build/three.core.js` it imports) and the licence. `examples/` and `src/` are tens of megabytes of material no
  // guide here imports.
  const dir = join(src, `three@${THREE_VERSION}`);
  await mkdir(join(dir, "build"), { recursive: true });
  await cp(join(from, "package.json"), join(dir, "package.json"));
  await cp(join(from, "build"), join(dir, "build"), { recursive: true });
  await cp(join(from, "LICENSE"), join(dir, "LICENSE")).catch(() => {});
  await publishPackage(registry.url, dir, work);
}

beforeAll(async () => {
  registry = await startTestRegistry();
  work = await mkdtemp(join(tmpdir(), "jl-web-pkg-"));
  const src = join(work, "fixtures");
  await mkdir(src, { recursive: true });
  // This repo's own installed copies, republished into the loopback registry at their pinned versions.
  const uiPackage = resolve(import.meta.dir, "../../../apps/ui");
  for (const name of ["react", "react-dom"]) {
    await publishPackage(registry.url, await copyInstalledPackage(name, uiPackage, src), work);
  }
  // React DOM depends on Scheduler, so the registry has to carry it too -- but nothing in this repo depends on
  // Scheduler directly, so it resolves from React DOM's own package folder rather than from the app.
  const reactDom = dirname(Bun.resolveSync("react-dom/package.json", uiPackage));
  await publishPackage(registry.url, await copyInstalledPackage("scheduler", reactDom, src), work);
  await publishThree(src);
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

async function install(app: LaunchedApp, spec: string) {
  const [name, version] = spec.split("@") as [string, string];
  await app.command("npm.install", { spec });
  await waitFor(
    async () => {
      const npm = (await app.state()).ui.npm as NpmSnapshot;
      const failed = npm.operations.find((op) => op.target.startsWith(name) && op.status === "failed");
      if (failed) throw new Error(`install of ${spec} failed: ${failed.errorKind}`);
      return npm.installed.some((pkg) => pkg.name === name && pkg.version === version) || null;
    },
    { timeoutMs: 300_000, message: `${spec} was never installed` },
  );
}

/** A `browser` tab with the given packages installed from the loopback registry. */
async function browserTabWith(specs: string[]) {
  const app = await launchWithRegistry();
  for (const spec of specs) await install(app, spec);
  await app.command("runtime.browser");
  await waitFor(async () => activeTab(await app.state()).runtime === "browser" || null, {
    message: "the tab never switched to browser",
  });
  return app;
}

async function runCode(target: LaunchedApp, lines: string[]) {
  const code = lines.join("\n");
  await target.type(code);
  await waitFor(async () => activeTab(await target.state()).code === code || null, {
    message: "the editor never took the typed code",
  });
  await target.command("run.start");
}

async function waitForConsole(target: LaunchedApp, prefix: string, timeoutMs = 300_000) {
  const entries = await target.waitForOutput(
    (all) => all.some((entry) => entry.kind === "console" && entry.text.startsWith(prefix)),
    timeoutMs,
  );
  return entries.filter((entry) => entry.kind === "console").find((entry) => entry.text.startsWith(prefix))
    ?.text as string;
}

const CANVAS_GUIDE = [
  'const canvas = document.createElement("canvas");',
  "canvas.width = 64;",
  "canvas.height = 64;",
  "document.body.appendChild(canvas);",
  'const ctx2d = canvas.getContext("2d");',
  "let frames = 0;",
  "await new Promise((done) => {",
  "  function draw() {",
  "    frames += 1;",
  '    ctx2d.fillStyle = "rgb(255, 0, 0)";',
  "    ctx2d.fillRect(0, 0, 64, 64);",
  "    if (frames >= 10) { done(); return; }",
  "    requestAnimationFrame(draw);",
  "  }",
  "  requestAnimationFrame(draw);",
  "});",
  "const painted = ctx2d.getImageData(1, 1, 1, 1).data;",
  'console.log("canvas:" + frames + ":" + painted[0] + "," + painted[1] + "," + painted[2]);',
];

const REACT_GUIDE = [
  'import { createElement, useEffect, useState } from "react";',
  'import { createRoot } from "react-dom/client";',
  'const mount = document.createElement("div");',
  'mount.id = "root";',
  "document.body.appendChild(mount);",
  "function App() {",
  "  const [count, setCount] = useState(0);",
  "  useEffect(() => setCount(41), []);",
  '  return createElement("h1", { id: "headline" }, "count:" + count);',
  "}",
  "createRoot(mount).render(createElement(App));",
  "await new Promise((done) => setTimeout(done, 500));",
  'console.log("react:" + document.querySelector("#headline").textContent);',
];

const THREE_GUIDE = [
  'import * as THREE from "three";',
  "const renderer = new THREE.WebGLRenderer({ antialias: false });",
  "renderer.setSize(64, 64);",
  "document.body.appendChild(renderer.domElement);",
  "const scene = new THREE.Scene();",
  "const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);",
  "camera.position.z = 3;",
  "const cube = new THREE.Mesh(",
  "  new THREE.BoxGeometry(1, 1, 1),",
  "  new THREE.MeshBasicMaterial({ color: 0xff0000 }),",
  ");",
  "scene.add(cube);",
  "await new Promise((done) => requestAnimationFrame(() => { renderer.render(scene, camera); done(); }));",
  "const gl = renderer.getContext();",
  "const rgba = new Uint8Array(4);",
  "gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);",
  'console.log("three:" + THREE.REVISION + ":" + renderer.info.render.triangles + ":" + rgba[0] + "," + rgba[1] + "," + rgba[2]);',
];

const AUDIO_GUIDE = [
  "const offline = new OfflineAudioContext(1, 4096, 44100);",
  "const tone = offline.createOscillator();",
  "tone.connect(offline.destination);",
  "tone.start();",
  "const rendered = await offline.startRendering();",
  "const samples = rendered.getChannelData(0);",
  "let loudest = 0;",
  // A bounded window, not every sample: loop protection stops a run at 2,000 iterations by default and this
  // buffer holds 4,096. Two hundred samples span two full periods of the default 440 Hz tone.
  "for (let i = 1000; i < 1200; i += 1) loudest = Math.max(loudest, Math.abs(samples[i]));",
  'console.log("audio:" + rendered.length + ":" + (loudest > 0.1));',
];

describe("browser guides that need packages, installed from the loopback registry (WV-04)", () => {
  test("the React guide renders into the page from a browser tab (WV-03)", async () => {
    const app = await browserTabWith([`react@${REACT_VERSION}`, `react-dom@${REACT_DOM_VERSION}`]);
    await runCode(app, REACT_GUIDE);
    // React mounted, ran an effect, re-rendered, and the result is in the page's own DOM.
    expect(await waitForConsole(app, "react:")).toBe("react:count:41");
    await app.screenshot("web-guide-react");
  });

  test("the Three.js guide renders a WebGL frame from a browser tab", async () => {
    const app = await browserTabWith([`three@${THREE_VERSION}`]);
    await runCode(app, THREE_GUIDE);
    const line = await waitForConsole(app, "three:");
    const [, revision, triangles, rgb] = line.split(":") as [string, string, string, string];
    // The pinned build really loaded, and it really rasterized: a cube is 12 triangles, and the centre pixel of a
    // red cube on a transparent clear colour comes back red-dominant.
    expect(revision).toBe("184");
    expect(triangles).toBe("12");
    const [red, green, blue] = rgb.split(",").map(Number) as [number, number, number];
    expect(red).toBeGreaterThan(100);
    expect(Math.max(green, blue)).toBeLessThan(red);
    await app.screenshot("web-guide-three");
  });

  test("WV-04 exit: canvas + requestAnimationFrame, React, Three.js and Web Audio all run in one browser tab", async () => {
    const app = await browserTabWith([
      `react@${REACT_VERSION}`,
      `react-dom@${REACT_DOM_VERSION}`,
      `three@${THREE_VERSION}`,
    ]);
    await runCode(app, [...REACT_GUIDE, ...THREE_GUIDE, ...CANVAS_GUIDE, ...AUDIO_GUIDE]);

    // All four guides, in one run, in one tab -- the milestone's stated exit criterion.
    expect(await waitForConsole(app, "react:")).toBe("react:count:41");
    const three = await waitForConsole(app, "three:");
    expect(three).toStartWith("three:184:12:");
    expect(await waitForConsole(app, "canvas:")).toBe("canvas:10:255,0,0");
    expect(await waitForConsole(app, "audio:")).toBe("audio:4096:true");
    await app.waitForRunState(["idle", "settled"], 60_000);
    await app.screenshot("web-guides-wv04");
  });
});
