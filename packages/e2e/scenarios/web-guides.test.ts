import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * The browser guides that need no third-party package: canvas + `requestAnimationFrame`, and Web Audio (parity
 * WV-04). The two guides that do need packages -- React and Three.js -- live in the opt-in `e2e:npm` suite
 * (`../npm-scenarios/web-package-guides.test.ts`), which installs them from the loopback registry.
 *
 * Each guide proves it actually *ran in a real engine* rather than merely evaluating: the canvas guide reads a
 * pixel back after animating, and the audio guide renders a buffer and inspects its samples.
 */

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;

async function browserTab(settings: Record<string, unknown> = {}) {
  const launched = await launchApp({ settings: { version: 3, run: { autoRun: false }, ...settings } });
  app = launched;
  await launched.command("runtime.browser");
  await waitFor(async () => activeTab(await launched.state()).runtime === "browser" || null, {
    message: "the tab never switched to browser",
  });
  return launched;
}

async function runCode(target: LaunchedApp, lines: string[]) {
  const code = lines.join("\n");
  await target.type(code);
  await waitFor(async () => activeTab(await target.state()).code === code || null, {
    message: "the editor never took the typed code",
  });
  await target.command("run.start");
}

async function waitForConsole(target: LaunchedApp, prefix: string, timeoutMs = 90_000) {
  const entries = await target.waitForOutput(
    (all) => all.some((entry) => entry.kind === "console" && entry.text.startsWith(prefix)),
    timeoutMs,
  );
  return entries.filter((entry) => entry.kind === "console").find((entry) => entry.text.startsWith(prefix))
    ?.text as string;
}

describe("browser guides without packages (WV-04)", () => {
  test("the canvas + requestAnimationFrame guide animates frames and paints real pixels", async () => {
    const target = await browserTab();
    await runCode(target, [
      'const canvas = document.createElement("canvas");',
      "canvas.width = 64;",
      "canvas.height = 64;",
      "document.body.appendChild(canvas);",
      'const ctx = canvas.getContext("2d");',
      "let frames = 0;",
      // A real rAF loop: the page has to actually tick a compositor for this to resolve at all.
      "await new Promise((resolve) => {",
      "  function draw() {",
      "    frames += 1;",
      '    ctx.fillStyle = "rgb(255, 0, 0)";',
      "    ctx.fillRect(0, 0, 64, 64);",
      "    if (frames >= 10) { resolve(); return; }",
      "    requestAnimationFrame(draw);",
      "  }",
      "  requestAnimationFrame(draw);",
      "});",
      "const pixel = ctx.getImageData(1, 1, 1, 1).data;",
      'console.log("canvas:" + frames + ":" + pixel[0] + "," + pixel[1] + "," + pixel[2] + "," + pixel[3]);',
    ]);

    // Ten real animation frames, and the pixel that came back is the one the guide painted.
    expect(await waitForConsole(target, "canvas:")).toBe("canvas:10:255,0,0,255");
    await target.waitForRunState(["idle", "settled"], 30_000);
    await target.screenshot("web-guide-canvas");
  });

  test("the Web Audio guide builds a graph, renders samples and reports its context state (EX-35)", async () => {
    const target = await browserTab();
    await runCode(target, [
      // OfflineAudioContext renders deterministically and needs no user gesture, so the samples below are proof
      // that Web Audio really processed the graph rather than merely constructing it.
      "const offline = new OfflineAudioContext(1, 4096, 44100);",
      "const tone = offline.createOscillator();",
      "const gain = offline.createGain();",
      "gain.gain.value = 0.5;",
      "tone.connect(gain).connect(offline.destination);",
      "tone.start();",
      "const rendered = await offline.startRendering();",
      "const samples = rendered.getChannelData(0);",
      "let loudest = 0;",
      // A bounded window, not every sample: JSLab's loop protection stops a run at 2,000 iterations by default,
      // and this buffer holds 4,096. Two hundred samples span two full periods of the default 440 Hz tone, so
      // the peak below is a real one.
      "for (let i = 1000; i < 1200; i += 1) loudest = Math.max(loudest, Math.abs(samples[i]));",
      'console.log("offline:" + rendered.length + ":" + (loudest > 0.1));',
      // A live context as well: this is the one the tab's speaker indicator tracks (spec §5.12, parity EX-35).
      "const live = new AudioContext();",
      "const osc = live.createOscillator();",
      "osc.connect(live.destination);",
      "osc.start();",
      "await new Promise((resolve) => setTimeout(resolve, 250));",
      "osc.stop();",
      'console.log("live:" + live.state);',
    ]);

    // The rendered buffer is the full requested length and actually carries a signal.
    expect(await waitForConsole(target, "offline:")).toBe("offline:4096:true");
    // The live context reaches a real state (a webview may start it suspended until a gesture; either is a
    // genuine Web Audio context, and the run must not fail either way).
    expect(["live:running", "live:suspended"]).toContain(await waitForConsole(target, "live:"));
    await target.screenshot("web-guide-audio");
  });
});
