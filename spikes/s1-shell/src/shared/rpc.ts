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
      throughputDone: { sent: number };
    };
  }>;
};
