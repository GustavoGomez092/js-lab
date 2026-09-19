import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type E2EState, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * EX-35, end to end: the per-tab audio indicator, on screen in a built app.
 *
 * What was already covered, and why it was not enough. `apps/ui/test/audio-indicator.test.tsx` drives the
 * component through props in happy-dom, and `packages/e2e/scenarios/web-guides.test.ts` proves Web Audio really
 * runs in a browser tab. Neither says the control reaches the screen: the component test never renders a tab bar,
 * and the Web Audio test never looks at one. This scenario closes that gap, and only that gap.
 *
 * **The readings here come from the rendered element's own attributes** (`audioIndicators`, see
 * `apps/ui/src/e2e/agent.ts`), never from `runtimes[].audioActive` or `tabs[].layout.muted`. A reporter that
 * echoed the store would agree with itself whatever the tab bar drew -- including if it drew nothing -- which is
 * the same reason `editorOptions` returns what Monaco reports rather than what the settings say.
 *
 * The audio source is a **live** `AudioContext`, not the `OfflineAudioContext` the Web Audio guide renders with:
 * `handles.ts` registers a context with `AudioController` only while its state is `running`, so an offline render
 * drives no indicator at all.
 */

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

/** One tab audio indicator, exactly as `reportAudioIndicators` read it off the DOM. */
interface AudioIndicator {
  tabTitle: string;
  tabSelected: string | null;
  tagName: string;
  ariaPressed: string | null;
  ariaLabel: string | null;
  className: string;
  glyph: string;
  width: number;
  height: number;
}

const indicators = (state: E2EState): AudioIndicator[] => (state.ui.audioIndicators ?? []) as AudioIndicator[];

async function browserTab() {
  const launched = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
  app = launched;
  await launched.command("runtime.browser");
  await waitFor(async () => activeTab(await launched.state()).runtime === "browser" || null, {
    message: "the tab never switched to browser",
  });
  return launched;
}

/**
 * Starts a live oscillator and leaves it running: the context is never closed, so the tab stays audio-active
 * after the run settles and the indicator is still there to be clicked. The gain is low because this really does
 * make noise on the machine running the suite.
 *
 * `resume()` is attempted because a context built without a user gesture starts `suspended` under autoplay
 * policy, and a suspended context is not "running" (`handles.ts`). The state is logged either way, so a webview
 * that refuses to resume reports that instead of timing out silently.
 */
const AUDIO_CODE = [
  "const live = new AudioContext();",
  "const osc = live.createOscillator();",
  "const gain = live.createGain();",
  "gain.gain.value = 0.02;",
  "osc.connect(gain).connect(live.destination);",
  "osc.start();",
  'if (live.state !== "running") { try { await live.resume(); } catch {} }',
  'console.log("audio-state:" + live.state);',
];

async function runAudio(target: LaunchedApp) {
  const code = AUDIO_CODE.join("\n");
  await target.type(code);
  await waitFor(async () => activeTab(await target.state()).code === code || null, {
    message: "the editor never took the typed code",
  });
  await target.command("run.start");
}

/**
 * Waits for the tab bar to show audio indicators, racing the two ways this legitimately fails fast: the run
 * erroring, and the context settling at anything other than `running` (after which no indicator can ever
 * appear). Without the race both present as one opaque timeout.
 *
 * The probe returns the failure rather than throwing it, because this project's `waitFor` swallows a throwing
 * predicate as "not yet" -- a thrown error here would be indistinguishable from "keep polling".
 */
async function waitForIndicators(target: LaunchedApp, count: number, timeoutMs = 90_000): Promise<AudioIndicator[]> {
  const seen = await waitFor<{ found: AudioIndicator[] } | { error: string }>(
    async () => {
      const [state, output] = await Promise.all([target.state(), target.output()]);
      const failure = output.find((entry) => entry.kind === "error");
      if (failure) return { error: `the run errored before the indicator appeared: ${failure.text}` };
      const found = indicators(state);
      if (found.length === count) return { found };
      const reported = output.find((entry) => entry.kind === "console" && entry.text.startsWith("audio-state:"));
      if (reported && reported.text !== "audio-state:running")
        return {
          error: `the AudioContext never reached "running" (${reported.text}), so the tab can never be audio-active`,
        };
      return null;
    },
    { timeoutMs, message: `the tab bar never showed ${count} audio indicator(s)` },
  );
  if ("error" in seen) throw new Error(seen.error);
  return seen.found;
}

/** Waits for the one indicator's `aria-pressed` to reach `expected`, racing its disappearance. */
async function waitForPressed(target: LaunchedApp, expected: string): Promise<AudioIndicator> {
  const seen = await waitFor<{ found: AudioIndicator } | { error: string }>(
    async () => {
      const found = indicators(await target.state());
      if (found.length === 0) return { error: "the indicator unmounted instead of changing its pressed state" };
      const [only] = found;
      return only?.ariaPressed === expected ? { found: only } : null;
    },
    { timeoutMs: 15_000, message: `the indicator's aria-pressed never became ${expected}` },
  );
  if ("error" in seen) throw new Error(seen.error);
  return seen.found;
}

describe("tab audio indicator (EX-35)", () => {
  test("a tab making noise shows a speaker control, and clicking it flips the control to muted", async () => {
    const target = await browserTab();
    await runAudio(target);

    const [playing] = await waitForIndicators(target, 1);
    const title = activeTab(await target.state()).title;
    expect(playing).toBeDefined();
    // A real control, at a real size, announcing that it is playing rather than muted. Every value below was
    // read off the rendered element; none of it is the store's opinion of the tab.
    expect(playing?.tagName).toBe("BUTTON");
    expect(playing?.ariaPressed).toBe("false");
    expect(playing?.className).toBe("tab-audio");
    expect(playing?.glyph).toBe("🔊");
    expect(playing?.width).toBeGreaterThan(0);
    expect(playing?.height).toBeGreaterThan(0);
    // The accessible name names THIS tab -- the spec's own motivation for the feature. Asserted as the literal
    // English rather than a `strings` lookup, which would agree with the catalogue whatever it said.
    expect(playing?.ariaLabel).toBe(`Mute ${title} (currently playing audio)`);
    await target.screenshot("tab-audio-playing");

    // Clicks the real button (see `e2e.toggleTabAudio`), which also asserts it can take focus first.
    await target.command("e2e.toggleTabAudio");
    const muted = await waitForPressed(target, "true");
    expect(muted.ariaLabel).toBe(`Unmute ${title} (currently muted)`);
    expect(muted.className).toBe("tab-audio muted");
    expect(muted.glyph).toBe("🔇");
    await target.screenshot("tab-audio-muted");

    // Still a real control afterwards: mute is undoable from the same button (CodeRabbit finding 7's concern).
    expect(muted.tagName).toBe("BUTTON");
    expect(muted.width).toBeGreaterThan(0);
  });

  test("the indicator marks a background tab, and muting it does not also switch to it", async () => {
    const target = await browserTab();
    await runAudio(target);
    const [playing] = await waitForIndicators(target, 1);
    const noisyTab = playing?.tabTitle ?? "";
    expect(noisyTab.length, "the indicator must report which tab row it sits in").toBeGreaterThan(0);
    expect(playing?.tabSelected).toBe("true");

    // Open a second tab, which takes the foreground. This is the situation the feature exists for: the noise is
    // coming from a tab you are no longer looking at.
    const foreground = await target.newTab();
    const background = await waitFor<{ found: AudioIndicator } | { error: string }>(
      async () => {
        const state = await target.state();
        if (state.ui.activeTabId !== foreground) return null;
        const found = indicators(state);
        if (found.length === 0) return { error: "the indicator vanished when its tab went to the background" };
        const [only] = found;
        return only?.tabSelected === "false" ? { found: only } : null;
      },
      { timeoutMs: 20_000, message: "the background tab never kept a deselected indicator" },
    );
    if ("error" in background) throw new Error(background.error);
    expect(background.found.tabTitle).toBe(noisyTab);
    expect(background.found.ariaPressed).toBe("false");
    await target.screenshot("tab-audio-background");

    // Click the background tab's indicator. The dispatched click bubbles, so the tab row underneath would
    // activate that tab if `AudioIndicator` ever stopped calling `stopPropagation`.
    await target.command("e2e.toggleTabAudio", { title: noisyTab });
    const muted = await waitForPressed(target, "true");
    expect(muted.tabTitle).toBe(noisyTab);
    expect(muted.tabSelected).toBe("false");
    // The whole point: the noisy tab is silenced without being switched to.
    expect((await target.state()).ui.activeTabId).toBe(foreground);
  });
});
