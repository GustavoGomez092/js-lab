import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  collectTypeLibPack,
  jslabTypeLibs,
  MAX_TYPE_LIB_BYTES,
  resolvePackageDir,
  TYPE_LIB_PACKS,
} from "../vite-plugins/type-libs-plugin";

const uiRoot = join(import.meta.dir, "..");
const pack = (name: "node" | "bun") =>
  collectTypeLibPack(TYPE_LIB_PACKS[name].map((pkg) => ({ name: pkg, dir: resolvePackageDir(pkg, uiRoot) })));
/** Rollup's virtual-module marker: a resolved id that starts with a NUL byte. */
const NUL = String.fromCharCode(0);

describe("bundled type libraries (spec §6.2)", () => {
  test("the node and bun packs hold every declaration file and package.json of the pinned packages, within budget", () => {
    const node = pack("node");
    const bun = pack("bun");
    const paths = [...node, ...bun].map((file) => file.path);
    expect(paths).toContain("file:///node_modules/@types/node/package.json");
    expect(paths).toContain("file:///node_modules/@types/node/globals.d.ts");
    expect(paths).toContain("file:///node_modules/undici-types/package.json");
    expect(paths).toContain("file:///node_modules/bun-types/package.json");
    expect(paths.some((path) => path.startsWith("file:///node_modules/bun-types/") && path.endsWith(".d.ts"))).toBe(
      true,
    );
    expect(paths.every((path) => path.endsWith(".d.ts") || path.endsWith("/package.json"))).toBe(true);
    const bytes = [...node, ...bun].reduce((sum, file) => sum + file.content.length, 0);
    expect(bytes).toBeLessThan(MAX_TYPE_LIB_BYTES);
    expect(
      JSON.parse(node.find((file) => file.path.endsWith("@types/node/package.json"))?.content ?? "{}").version,
    ).toBe("22.20.2");
  });

  test("the Vite plugin serves each pack as a virtual module and ignores other ids", async () => {
    const plugin = jslabTypeLibs(uiRoot);
    const resolveId = plugin.resolveId as (id: string) => string | null;
    const load = plugin.load as (id: string) => string | null;
    expect(resolveId("virtual:jslab-type-libs/bun")).toBe(`${NUL}virtual:jslab-type-libs/bun`);
    expect(resolveId("./other")).toBeNull();
    const code = load(`${NUL}virtual:jslab-type-libs/bun`) ?? "";
    expect(code.startsWith("export default [")).toBe(true);
    expect(load(`${NUL}something-else`)).toBeNull();
  });
});
