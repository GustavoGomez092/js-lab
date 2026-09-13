import { Electroview } from "electrobun/view";
import type { SpikeRPC } from "../shared/rpc";

// Defined outside App.tsx so later probe components can import `rpc`
// without creating an App.tsx <-> component import cycle.
export const rpc = Electroview.defineRPC<SpikeRPC>({
  maxRequestTime: 10_000,
  handlers: {
    requests: {},
    messages: {
      saveDialogResult: (payload) => rpc.send.viewReport({ section: "S6", data: payload }),
      throughputBatch: () => {},
      throughputDone: () => {},
    },
  },
});
new Electroview({ rpc });
