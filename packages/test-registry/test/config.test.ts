import { describe, expect, test } from "bun:test";
import { verdaccioConfig } from "../src/config";
import { findFreePort } from "../src/free-port";

describe("test registry config", () => {
  test("stores packages under the given folder, listens on loopback and has no uplinks", () => {
    const yaml = verdaccioConfig({ storage: "/tmp-x/storage dir", port: 4999 });
    expect(yaml).toContain('storage: "/tmp-x/storage dir"');
    expect(yaml).toContain("listen: 127.0.0.1:4999");
    expect(yaml).toContain("uplinks: {}");
    expect(yaml).not.toContain("proxy:");
    expect(yaml).toContain("enable: false");
  });

  test("finds a loopback port that can be bound", () => {
    const port = findFreePort();
    expect(port).toBeGreaterThan(1024);
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    expect(server.port).toBe(port);
    server.stop(true);
  });
});
