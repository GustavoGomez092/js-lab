import type { E2EUiMethod } from "@jslab/rpc-schema";
import { z } from "zod";
import type { CaptureResult } from "../platform/window-capture";
import type { E2EBridge } from "./e2e-bridge";
import type { SocketMethod } from "./ndjson";

export interface SocketMethodDeps {
  e2eEnabled: boolean;
  bridge: Pick<E2EBridge, "request">;
  mainState(): Record<string, unknown>;
  /** Resolves `{ path }`, or `{ skipped }` when JSLab has no Screen Recording access (never prompts). */
  screenshot(name: string): Promise<CaptureResult>;
  quit(): void;
  /** False while the main window is closed (spec §10.3). */
  uiAvailable(): boolean;
  reopenWindow(): void;
}

const typeParams = z.object({ text: z.string().max(1_000_000), replace: z.boolean().optional() });
const keyParams = z.object({ key: z.string().min(1).max(64) });
const commandParams = z.object({ id: z.string().min(1).max(100), args: z.unknown().optional() });
const outputParams = z.object({ tabId: z.string().min(1).max(100).optional() });
const screenshotParams = z.object({ name: z.string().regex(/^[\w.-]{1,64}$/) });

/**
 * The socket method table. `e2e.*` exists only for `JSLAB_E2E=1` launches (spec §16.3, §18).
 * M5 adds the CLI's always-available `open` method before the e2e guard.
 */
export function createSocketMethods(deps: SocketMethodDeps): Record<string, SocketMethod> {
  const methods: Record<string, SocketMethod> = {};
  if (!deps.e2eEnabled) return methods;

  const requireUi = () => {
    if (!deps.uiAvailable()) throw new Error("The JSLab window is closed");
  };
  const forward =
    (method: E2EUiMethod, schema: z.ZodType): SocketMethod =>
    async (params) => {
      requireUi();
      return { result: await deps.bridge.request(method, schema.parse(params ?? {})) };
    };

  methods["e2e.type"] = forward("type", typeParams);
  methods["e2e.key"] = forward("key", keyParams);
  methods["e2e.command"] = forward("command", commandParams);
  methods["e2e.output"] = forward("output", outputParams);
  methods["e2e.state"] = async () => {
    let ui: unknown = null;
    if (deps.uiAvailable()) {
      try {
        ui = await deps.bridge.request("state", {});
      } catch (error) {
        // The window closed while the request was in flight (the bridge rejects every pending request): report the
        // closed window like any other state, rather than failing the call (m-7).
        if (deps.uiAvailable()) throw error;
      }
    }
    return { ui, main: deps.mainState() };
  };
  methods["e2e.reopen"] = async () => {
    deps.reopenWindow();
    return {};
  };
  methods["e2e.screenshot"] = async (params) => {
    requireUi();
    return { ...(await deps.screenshot(screenshotParams.parse(params ?? {}).name)) };
  };
  methods["e2e.quit"] = async () => {
    setTimeout(() => deps.quit(), 50);
    return {};
  };
  return methods;
}
