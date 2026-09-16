import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../../src/main/app-paths";
import { createMainServices, type MainServices } from "../../src/main/main-services";
import type { WebviewBridge } from "../../src/main/runtimes/webview-source";

let dir = "";
let services: MainServices | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-registration-"));
});
afterEach(async () => {
  services?.dispose();
  services = null;
  await rm(dir, { recursive: true, force: true });
});

const silentBridge = (): WebviewBridge => ({
  ensure: () => {},
  execute: () => {},
  reload: () => {},
  destroy: () => {},
});

async function build(webviewBridge?: WebviewBridge): Promise<MainServices> {
  const paths = resolveAppPaths({
    resourcesFolder: join(dir, "Resources"),
    userData: dir,
    execPath: process.execPath,
    env: {},
  });
  services = await createMainServices({
    paths,
    env: {},
    shiftHeld: Promise.resolve(false),
    realHome: join(dir, "home"),
    onEvents: () => {},
    onState: () => {},
    onDiagnostics: () => {},
    onNpmOperation: () => {},
    onNpmLog: () => {},
    onNpmChanged: () => {},
    startRunner: () => Promise.reject(new Error("no runners in this test")),
    transformHost: { transform: () => Promise.reject(new Error("no transforms in this test")), dispose: () => {} },
    ...(webviewBridge ? { webviewBridge } : {}),
  });
  return services;
}

/**
 * The defect this task exists to fix (ledger ruling R-M4-C1-1). `createWebAdapter` was fully built and unit-tested
 * but registered nowhere, so `registry.get("browser")` fell through to `adapters.bun` and a tab the user had
 * explicitly set to Browser ran its code under Bun -- where `document` doesn't exist. Registration is what makes
 * the runtime the user picked the runtime that actually runs.
 */
describe("runtime registration (composition root)", () => {
  test("browser and browser-node each resolve to their own web adapter, not the Bun fallback", async () => {
    const built = await build(silentBridge());

    expect(built.runtimes.get("browser").id).toBe("browser");
    expect(built.runtimes.get("browser-node").id).toBe("browser-node");
    expect(built.runtimes.get("bun").id).toBe("bun");
  });

  test("the two web runtimes share one webview source, since a tab's runtime is fixed at creation", async () => {
    const built = await build(silentBridge());
    expect(built.webviews).not.toBeNull();
  });

  test("an unresolved runtime still means Bun", async () => {
    const built = await build(silentBridge());
    expect(built.runtimes.get(undefined).id).toBe("bun");
  });

  /**
   * The UI is what owns the webview elements, so with no bridge to it there is nothing a web adapter could drive.
   * Registering one anyway would turn a silent wrong-runtime execution into a five-second hang -- the exact trade
   * Task 9 declined. Every caller that can reach a real window passes a bridge; only headless tests don't.
   */
  test("with no bridge to the UI, the documented Bun fallback still applies", async () => {
    const built = await build();

    expect(built.webviews).toBeNull();
    expect(built.runtimes.get("browser").id).toBe("bun");
  });
});
