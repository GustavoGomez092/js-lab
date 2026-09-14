import { describe, expect, test } from "bun:test";
import { BUILT_VIEW_URL, DEV_SERVER_URL, resolveMainViewUrl } from "../src/main/main-view-url";

describe("resolveMainViewUrl (final review M2)", () => {
  test("only an opted-in dev channel uses the dev server, and a probe that never answers falls back in time", async () => {
    const ok = async () => new Response(null);
    const hang = () => new Promise<never>(() => {});
    expect(await resolveMainViewUrl({ channel: "dev", env: {}, probe: ok })).toBe(BUILT_VIEW_URL);
    expect(await resolveMainViewUrl({ channel: "canary", env: { JSLAB_DEV_SERVER: "1" }, probe: ok })).toBe(
      BUILT_VIEW_URL,
    );
    expect(await resolveMainViewUrl({ channel: "dev", env: { JSLAB_DEV_SERVER: "1" }, probe: ok })).toBe(
      DEV_SERVER_URL,
    );
    const started = Date.now();
    expect(
      await resolveMainViewUrl({ channel: "dev", env: { JSLAB_DEV_SERVER: "1" }, probe: hang, timeoutMs: 30 }),
    ).toBe(BUILT_VIEW_URL);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
