import { useEffect, useRef } from "react";
import { rpc } from "./rpc";
import type { WebviewTagElement } from "electrobun/view";

type Ticks = { intervalTicks: number; rafTicks: number; at: number };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const EXPECTED_INTERVAL = 100;
const EXPECTED_RAF = 600;
const WINDOW_MS = 10_000;

// S4: does the embedded <electrobun-webview> block on native alert/confirm/prompt
// and return real values, and do its timers/rAF keep running when it is collapsed
// to zero size? Runs automatically on mount (ruling R1: no GUI clicks available to
// this harness) and reports every phase via rpc.send.viewReport.
export function WebviewProbe() {
  const ref = useRef<HTMLElement>(null);
  const latestTicks = useRef<Ticks | null>(null);
  const dialogResult = useRef<(Record<string, unknown> & { type: string }) | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const webview = ref.current as WebviewTagElement | null;
    if (!webview || startedRef.current) return;
    startedRef.current = true;

    const onHostMessage = (event: CustomEvent) => {
      const detail = event.detail as (Record<string, unknown> & { type: string }) | undefined;
      if (!detail) return;
      if (detail.type === "ticks") {
        latestTicks.current = detail as unknown as Ticks;
      } else if (detail.type === "dialog-result") {
        dialogResult.current = detail;
      }
    };
    webview.on("host-message", onHostMessage);

    let cancelled = false;

    // Forces a fresh reading via the documented executeJavascript() host->embedded
    // call, then waits (briefly) for the corresponding host-message reply. Falls
    // back to whatever was last received if the collapsed view doesn't answer.
    const forceRead = (): Promise<Ticks | null> => {
      const before = latestTicks.current?.at ?? 0;
      webview.executeJavascript("window.sendTicksNow && window.sendTicksNow()");
      return new Promise((resolve) => {
        const deadline = Date.now() + 1500;
        const poll = () => {
          if (cancelled) return resolve(latestTicks.current);
          if (latestTicks.current && latestTicks.current.at > before) return resolve(latestTicks.current);
          if (Date.now() > deadline) return resolve(latestTicks.current);
          setTimeout(poll, 50);
        };
        poll();
      });
    };

    const delta = (a: Ticks | null, b: Ticks | null) => ({
      intervalTicks: (b?.intervalTicks ?? 0) - (a?.intervalTicks ?? 0),
      rafTicks: (b?.rafTicks ?? 0) - (a?.rafTicks ?? 0),
    });

    // Ticks-per-second, normalized by the *embedded page's own* elapsed clock
    // (end.at - start.at) rather than the nominal WINDOW_MS, since the host-side
    // wall clock includes executeJavascript()/host-message round-trip latency
    // that the embedded page's timestamps do not.
    const rates = (start: Ticks | null, end: Ticks | null) => {
      const elapsedMs = (end?.at ?? 0) - (start?.at ?? 0);
      const d = delta(start, end);
      return {
        elapsedMs,
        intervalTicks: d.intervalTicks,
        rafTicks: d.rafTicks,
        intervalRatePerSec: elapsedMs > 0 ? (d.intervalTicks / elapsedMs) * 1000 : 0,
        rafRatePerSec: elapsedMs > 0 ? (d.rafTicks / elapsedMs) * 1000 : 0,
      };
    };

    const measureWindow = async (variant: "zero-size" | "1x1-offscreen", collapse: () => void, restore: () => void) => {
      const start = await forceRead();
      collapse();
      rpc.send.viewReport({ section: "S4-collapse", data: { startedAt: Date.now(), variant } });
      // Mid-window diagnostic read only (not used for the metric below) to show
      // ticks progressing smoothly throughout the collapse, not just catching up
      // once restored.
      await wait(WINDOW_MS / 2);
      let midCollapseAttempt: Ticks | null = null;
      if (!cancelled) midCollapseAttempt = await forceRead();
      await wait(WINDOW_MS / 2);
      if (cancelled) return null;
      // `end` is read WHILE STILL COLLAPSED, immediately before restore() runs, so
      // the delta never includes post-restore full-rate ticks (fix round 1: the
      // previous version read `end` after restore + settle + round-trip, which
      // folded ~500-600ms of full-rate ticks into the "during collapse" count and
      // let intervalKeptPct exceed 100%).
      const end = await forceRead();
      restore();
      await wait(500); // settle before the webview is used again (dialogs probe, or the fallback window)
      return { start, end, midCollapseAttempt, ...rates(start, end) };
    };

    const run = async () => {
      // Let the embedded page's counters run for a moment before the baseline read.
      await wait(1000);
      if (cancelled) return;

      const baselineStart = await forceRead();
      await wait(WINDOW_MS);
      if (cancelled) return;
      const baselineEnd = await forceRead();
      const baseline = rates(baselineStart, baselineEnd);

      if (cancelled) return;
      const zero = await measureWindow(
        "zero-size",
        () => {
          webview.style.width = "0px";
          webview.style.height = "0px";
        },
        () => {
          webview.style.width = "480px";
          webview.style.height = "200px";
        },
      );
      if (!zero) return;
      const pctOfBaselineIntervalRate =
        baseline.intervalRatePerSec > 0 ? Math.round((zero.intervalRatePerSec / baseline.intervalRatePerSec) * 100) : 0;
      const pctOfBaselineRafRate =
        baseline.rafRatePerSec > 0 ? Math.round((zero.rafRatePerSec / baseline.rafRatePerSec) * 100) : 0;
      rpc.send.viewReport({
        section: "S4-timers",
        data: {
          variant: "zero-size",
          expectedInterval: EXPECTED_INTERVAL,
          expectedRaf: EXPECTED_RAF,
          baselineElapsedMs: baseline.elapsedMs,
          baselineIntervalTicks: baseline.intervalTicks,
          baselineRafTicks: baseline.rafTicks,
          baselineIntervalRatePerSec: baseline.intervalRatePerSec,
          baselineRafRatePerSec: baseline.rafRatePerSec,
          collapseElapsedMs: zero.elapsedMs,
          intervalTicksDuringCollapse: zero.intervalTicks,
          rafTicksDuringCollapse: zero.rafTicks,
          intervalRatePerSecDuringCollapse: zero.intervalRatePerSec,
          rafRatePerSecDuringCollapse: zero.rafRatePerSec,
          pctOfBaselineIntervalRate,
          pctOfBaselineRafRate,
          midCollapseAttempt: zero.midCollapseAttempt,
          collapseStart: zero.start,
          collapseEnd: zero.end,
        },
      });

      if (cancelled) return;

      // Fallback per the brief's Step 5: only exercised if zero-size throttled the
      // interval below the 80% pass threshold, now measured against the baseline's
      // own elapsed-time-normalized rate rather than a nominal ~100 constant.
      if (pctOfBaselineIntervalRate < 80) {
        const offscreen = await measureWindow(
          "1x1-offscreen",
          () => {
            webview.style.position = "fixed";
            webview.style.left = "-9999px";
            webview.style.top = "-9999px";
            webview.style.width = "1px";
            webview.style.height = "1px";
          },
          () => {
            webview.style.position = "";
            webview.style.left = "";
            webview.style.top = "";
            webview.style.width = "480px";
            webview.style.height = "200px";
          },
        );
        if (offscreen) {
          const offscreenPctOfBaselineIntervalRate =
            baseline.intervalRatePerSec > 0 ? Math.round((offscreen.intervalRatePerSec / baseline.intervalRatePerSec) * 100) : 0;
          const offscreenPctOfBaselineRafRate =
            baseline.rafRatePerSec > 0 ? Math.round((offscreen.rafRatePerSec / baseline.rafRatePerSec) * 100) : 0;
          rpc.send.viewReport({
            section: "S4-timers-1x1",
            data: {
              variant: "1x1-offscreen",
              expectedInterval: EXPECTED_INTERVAL,
              expectedRaf: EXPECTED_RAF,
              baselineElapsedMs: baseline.elapsedMs,
              baselineIntervalRatePerSec: baseline.intervalRatePerSec,
              baselineRafRatePerSec: baseline.rafRatePerSec,
              collapseElapsedMs: offscreen.elapsedMs,
              intervalTicksDuringCollapse: offscreen.intervalTicks,
              rafTicksDuringCollapse: offscreen.rafTicks,
              intervalRatePerSecDuringCollapse: offscreen.intervalRatePerSec,
              rafRatePerSecDuringCollapse: offscreen.rafRatePerSec,
              pctOfBaselineIntervalRate: offscreenPctOfBaselineIntervalRate,
              pctOfBaselineRafRate: offscreenPctOfBaselineRafRate,
              midCollapseAttempt: offscreen.midCollapseAttempt,
              collapseStart: offscreen.start,
              collapseEnd: offscreen.end,
            },
          });
        }
      }

      if (cancelled) return;

      // Dialogs probe. Triggered via executeJavascript (no GUI click available to
      // this harness, ruling R1) only after the timer probe finishes, so a blocking
      // native dialog can't stall the interval/rAF measurement above. The host's own
      // JS keeps running regardless of whether the embedded page's alert() blocks,
      // so this polling loop itself is "a timer started before the call in a place
      // a blocked page cannot run."
      const beforeDialog = await forceRead();
      const dialogTriggerAt = Date.now();
      rpc.send.viewReport({ section: "S4-dialogs-trigger", data: { at: dialogTriggerAt, beforeDialog } });
      webview.executeJavascript("window.runDialogsTest && window.runDialogsTest()");

      const dialogDeadline = Date.now() + 8000;
      while (!dialogResult.current && Date.now() < dialogDeadline && !cancelled) {
        await wait(200);
      }
      if (cancelled) return;

      if (dialogResult.current) {
        rpc.send.viewReport({
          section: "S4-dialogs",
          data: { resumedAutomatically: true, dialogTriggerAt, ...dialogResult.current },
        });
      } else {
        // No result within 8s: the embedded page's ticks heartbeat (host-message
        // pushes every 200ms) is the independent signal that its JS thread is
        // stalled behind a real, still-open native dialog awaiting a human click.
        const heartbeatStalled = !latestTicks.current || latestTicks.current.at < dialogTriggerAt;
        rpc.send.viewReport({
          section: "S4-dialogs",
          data: {
            resumedAutomatically: false,
            heartbeatStalled,
            dialogTriggerAt,
            latestTicksAt: latestTicks.current?.at ?? null,
            note: "No dialog-result within 8s of triggering alert/confirm/prompt; native dialog presumed still open, blocking the embedded page's JS thread, and awaiting a human click or an app quit.",
          },
        });
      }
    };

    void run();

    return () => {
      cancelled = true;
      webview.off("host-message", onHostMessage);
    };
  }, []);

  return (
    <section>
      <h2>Webview probe (S4)</h2>
      {/* @ts-expect-error custom element provided by Electrobun's preload */}
      <electrobun-webview ref={ref} src="views://webview-probe/index.html" style={{ display: "block", width: 480, height: 200 }} />
    </section>
  );
}
