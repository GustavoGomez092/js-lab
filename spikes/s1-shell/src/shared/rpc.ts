import type { RPCSchema } from "electrobun/view";

export type SpikeRPC = {
  bun: RPCSchema<{
    requests: {
      probes: { params: {}; response: Record<string, unknown> };
    };
    messages: {
      viewReport: { section: string; data: unknown };
      saveDialog: { defaultName: string };
      startThroughput: { seconds: number; batchSize: number };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      saveDialogResult: { path: string | null; error?: string; ms: number };
      throughputBatch: { sentAt: number; events: { seq: number; text: string }[] };
      // batchSize added beyond the brief's snippet (Deviation) so the S7 report
      // line self-identifies which run (200 vs 1000/batch) it belongs to,
      // per controller ruling R1 ("each writing its own S7 line, include
      // batchSize in the data").
      throughputDone: { sent: number; batchSize: number };
    };
  }>;
};
