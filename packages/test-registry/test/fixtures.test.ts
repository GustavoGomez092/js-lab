import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPublishBody, packDirectory, writeFixturePackage } from "../src/fixtures";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-fixture-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fixture packages", () => {
  test("packs a package folder as package/… and builds an npm publish body with integrity", async () => {
    const pkg = await writeFixturePackage(
      join(dir, "src"),
      { name: "@jslab-fixture/scoped", version: "1.0.0" },
      {
        "index.js": "export const scoped = 'ok';\n",
      },
    );
    const { tarball, manifest } = await packDirectory(pkg, join(dir, "out"));
    const listing = Bun.spawnSync(["tar", "-tzf", "-"], { stdin: tarball })
      .stdout.toString()
      .split("\n")
      .filter(Boolean);
    expect(listing.sort()).toEqual(["package/index.js", "package/package.json"]);
    const body = buildPublishBody("http://127.0.0.1:4873/", manifest, tarball) as {
      name: string;
      "dist-tags": Record<string, string>;
      versions: Record<string, { dist: { tarball: string; integrity: string } }>;
      _attachments: Record<string, { length: number }>;
    };
    expect(body.name).toBe("@jslab-fixture/scoped");
    expect(body["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(body.versions["1.0.0"]?.dist.tarball).toBe("http://127.0.0.1:4873/@jslab-fixture/scoped/-/scoped-1.0.0.tgz");
    expect(body.versions["1.0.0"]?.dist.integrity).toStartWith("sha512-");
    expect(body._attachments["scoped-1.0.0.tgz"]?.length).toBe(tarball.byteLength);
  });
});
