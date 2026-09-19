import { type CliOpenParams, type CliOpenResult, cliOpenParamsSchema, type E2EUiMethod } from "@jslab/rpc-schema";
import { z } from "zod";
import type { CaptureResult } from "../platform/window-capture";
import type { E2EBridge } from "./e2e-bridge";
import type { SocketMethod } from "./ndjson";

export type E2EWindow = "main" | "settings";

export interface SocketMethodDeps {
  e2eEnabled: boolean;
  /** Spec §16.3: the CLI's method. Present in every launch, unlike everything below it. */
  open(params: CliOpenParams): Promise<CliOpenResult>;
  bridge: Pick<E2EBridge, "request">;
  settingsBridge?: Pick<E2EBridge, "request">;
  mainState(): Record<string, unknown>;
  /** `{ path }`, or `{ skipped }` without Screen Recording access (never prompts). */
  screenshot(name: string, window: E2EWindow): Promise<CaptureResult>;
  quit(): void;
  /** False while that window is closed (spec §10.3). */
  uiAvailable(window?: E2EWindow): boolean;
  reopenWindow(): void;
}

const windowParam = z.enum(["main", "settings"]).optional();
const typeParams = z.object({ text: z.string().max(1_000_000), replace: z.boolean().optional(), window: windowParam });
const keyParams = z.object({ key: z.string().min(1).max(64), window: windowParam });
const commandParams = z.object({ id: z.string().min(1).max(100), args: z.unknown().optional(), window: windowParam });
const outputParams = z.object({ tabId: z.string().min(1).max(100).optional(), window: windowParam });
const stateParams = z.object({ window: windowParam });
const screenshotParams = z.object({ name: z.string().regex(/^[\w.-]{1,64}$/), window: windowParam });

/**
 * The socket method table. `open` is the CLI's method and is always available (spec §16.3). `e2e.*` exists only for
 * `JSLAB_E2E=1` launches (spec §16.3, §18) and is registered after the guard below.
 */
export function createSocketMethods(deps: SocketMethodDeps): Record<string, SocketMethod> {
  const methods: Record<string, SocketMethod> = {};
  // Spec §16.3: `open` is the CLI's method and exists in every launch, so it is registered *before* the e2e guard
  // below. A zod failure here is already the spec's `{ id, ok: false, error }` reply — `handleLine` never throws.
  methods.open = async (params) => ({ ...(await deps.open(cliOpenParamsSchema.parse(params ?? {}))) });
  if (!deps.e2eEnabled) return methods;

  const bridgeFor = (window: E2EWindow = "main") => {
    if (!deps.uiAvailable(window)) {
      throw new Error(window === "main" ? "The JSLab window is closed" : "The Settings window is closed");
    }
    const bridge = window === "main" ? deps.bridge : deps.settingsBridge;
    if (!bridge) throw new Error("The Settings window has no automation bridge");
    return bridge;
  };

  const forward =
    (method: E2EUiMethod, schema: z.ZodType<{ window?: E2EWindow }>): SocketMethod =>
    async (params) => {
      const { window, ...rest } = schema.parse(params ?? {});
      return { result: await bridgeFor(window).request(method, rest) };
    };

  methods["e2e.type"] = forward("type", typeParams);
  methods["e2e.key"] = forward("key", keyParams);
  methods["e2e.command"] = forward("command", commandParams);
  methods["e2e.output"] = forward("output", outputParams);
  methods["e2e.state"] = async (params) => {
    const { window = "main" } = stateParams.parse(params ?? {});
    let ui: unknown = null;
    if (deps.uiAvailable(window)) {
      try {
        ui = await bridgeFor(window).request("state", {});
      } catch (error) {
        // The window closed while the request was in flight (the bridge rejects every pending request): report the
        // closed window like any other state, rather than failing the call (m-7).
        if (deps.uiAvailable(window)) throw error;
      }
    }
    return { ui, main: deps.mainState() };
  };
  methods["e2e.screenshot"] = async (params) => {
    const { name, window = "main" } = screenshotParams.parse(params ?? {});
    bridgeFor(window);
    return { ...(await deps.screenshot(name, window)) };
  };
  methods["e2e.quit"] = async () => {
    setTimeout(() => deps.quit(), 50);
    return {};
  };
  methods["e2e.reopen"] = async () => {
    deps.reopenWindow();
    return {};
  };
  return methods;
}
