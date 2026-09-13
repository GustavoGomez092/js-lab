import { Electroview } from "electrobun/view";
import type { SpikeRPC } from "../shared/rpc";

// Defined outside App.tsx so later probe components can import `rpc`
// without creating an App.tsx <-> component import cycle.

// S7 (task-7 brief Step 2 fallback): `rpc.setMessageHandlers` does not exist
// on the object Electroview.defineRPC returns in Electrobun 2.0.1 — confirmed
// by reading .hutch/devkit/api/shared/rpc.ts: defineElectrobunRPC's return
// value only exposes setTransport/setRequestHandler/request/requestProxy/
// send/sendProxy/addMessageListener/removeMessageListener/proxy, none named
// setMessageHandlers. Per the brief's fallback, the throughputBatch/
// throughputDone handlers are therefore registered statically in the
// `messages` object below (the API that worked), and the module-level meter
// state lives in this file instead of in ThroughputProbe.tsx.
type ThroughputVisibility = { visibilityState: string; hasFocus: boolean };
type ThroughputState = {
  latencies: number[];
  received: number;
  lastSeq: number;
  gaps: number;
  worstFrameMs: number;
  lastFrame: number;
  rafHandle: number;
  running: boolean;
  doneResolver: (() => void) | null;
  visibilityAtStart: ThroughputVisibility | null;
};

const throughput: ThroughputState = {
  latencies: [],
  received: 0,
  lastSeq: 0,
  gaps: 0,
  worstFrameMs: 0,
  lastFrame: 0,
  rafHandle: 0,
  running: false,
  doneResolver: null,
  visibilityAtStart: null,
};

function readVisibility(): ThroughputVisibility {
  return { visibilityState: document.visibilityState, hasFocus: document.hasFocus() };
}

function throughputFrame(now: number) {
  throughput.worstFrameMs = Math.max(throughput.worstFrameMs, now - throughput.lastFrame);
  throughput.lastFrame = now;
  throughput.rafHandle = requestAnimationFrame(throughputFrame);
}

// Resets the meter, starts the rAF-based frame-time watch, and asks main to
// start sending batches. Returns a promise that resolves once `throughputDone`
// has been received and its S7 report line written, so the S7 automated
// sequence (200/batch then 1000/batch, ruling R1) can run them back to back
// without overlap.
export function startThroughputProbe(batchSize: number, seconds = 10): Promise<void> {
  if (throughput.running) {
    console.warn("[S7] throughput probe already running; ignoring overlapping start", { batchSize });
    return Promise.resolve();
  }
  throughput.running = true;
  throughput.latencies.length = 0;
  throughput.received = 0;
  throughput.lastSeq = 0;
  throughput.gaps = 0;
  throughput.worstFrameMs = 0;
  throughput.lastFrame = performance.now();
  throughput.visibilityAtStart = readVisibility();
  cancelAnimationFrame(throughput.rafHandle);
  throughput.rafHandle = requestAnimationFrame(throughputFrame);
  return new Promise((resolve) => {
    throughput.doneResolver = resolve;
    rpc.send.startThroughput({ seconds, batchSize });
  });
}

export const rpc = Electroview.defineRPC<SpikeRPC>({
  maxRequestTime: 10_000,
  handlers: {
    requests: {},
    messages: {
      saveDialogResult: (payload) => rpc.send.viewReport({ section: "S6", data: payload }),
      throughputBatch: ({ sentAt, events }) => {
        throughput.latencies.push(Date.now() - sentAt);
        for (const e of events) {
          if (e.seq !== throughput.lastSeq + 1) throughput.gaps++;
          throughput.lastSeq = e.seq;
        }
        throughput.received += events.length;
      },
      throughputDone: ({ sent, batchSize }) => {
        cancelAnimationFrame(throughput.rafHandle);
        const sorted = [...throughput.latencies].sort((a, b) => a - b);
        const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : null;
        const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null;
        rpc.send.viewReport({
          section: "S7",
          data: {
            batchSize,
            sent,
            received: throughput.received,
            gaps: throughput.gaps,
            p50,
            p95,
            worstFrameMs: Math.round(throughput.worstFrameMs),
            // Visibility context (follow-up controller ruling): worstFrameMs is
            // only meaningful while the window is actually rendering frames.
            visibilityAtStart: throughput.visibilityAtStart,
            visibilityAtEnd: readVisibility(),
          },
        });
        throughput.running = false;
        const resolve = throughput.doneResolver;
        throughput.doneResolver = null;
        resolve?.();
      },
    },
  },
});
new Electroview({ rpc });
