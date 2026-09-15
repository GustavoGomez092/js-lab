import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface FixtureManifest {
  name: string;
  version: string;
  [key: string]: unknown;
}

const folderName = (manifest: FixtureManifest) => `${manifest.name.replace("/", "__")}@${manifest.version}`;
const unscoped = (name: string) => name.split("/").pop() as string;

/** Writes `<root>/<name>@<version>/` with a package.json and the given files; returns that folder. */
export async function writeFixturePackage(
  root: string,
  manifest: FixtureManifest,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(root, folderName(manifest));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Packs a folder like `npm pack`: every file under `package/`, gzipped (system tar, no AppleDouble files). */
export async function packDirectory(
  dir: string,
  outDir: string,
): Promise<{ tarball: Uint8Array; manifest: FixtureManifest }> {
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as FixtureManifest;
  await mkdir(outDir, { recursive: true });
  // A sibling of outDir (`<outDir>-stage-XXXXXX`, whose parent exists), so staging never lands inside the tarball folder.
  const staging = await mkdtemp(`${outDir.replace(/\/$/, "")}-stage-`);
  await cp(dir, join(staging, "package"), {
    recursive: true,
    dereference: true,
    // Relative to the package folder: the folder itself may sit inside a node_modules store.
    filter: (source) => !source.slice(dir.length).includes("/node_modules"),
  });
  const file = join(outDir, `${unscoped(manifest.name)}-${manifest.version}.tgz`);
  // List files explicitly (no bare "package" argument): bsdtar otherwise emits a "package/" directory entry that
  // real `npm pack` tarballs don't have.
  const find = Bun.spawnSync(["find", "package", "-type", "f"], {
    cwd: staging,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (find.exitCode !== 0) throw new Error(`find failed: ${find.stderr.toString()}`);
  const entries = find.stdout.toString().split("\n").filter(Boolean).sort();
  const tar = Bun.spawnSync(["tar", "-czf", file, "-C", staging, ...entries], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
  });
  await rm(staging, { recursive: true, force: true });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return { tarball: new Uint8Array(await Bun.file(file).arrayBuffer()), manifest };
}

/** The npm registry publish document (`PUT /<name>`). */
export function buildPublishBody(
  registryUrl: string,
  manifest: FixtureManifest,
  tarball: Uint8Array,
  tag = "latest",
): Record<string, unknown> {
  const file = `${unscoped(manifest.name)}-${manifest.version}.tgz`;
  const shasum = new Bun.CryptoHasher("sha1").update(tarball).digest("hex");
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(tarball).digest("base64")}`;
  return {
    _id: manifest.name,
    name: manifest.name,
    description: typeof manifest.description === "string" ? manifest.description : "",
    "dist-tags": { [tag]: manifest.version },
    versions: {
      [manifest.version]: {
        ...manifest,
        _id: `${manifest.name}@${manifest.version}`,
        dist: { shasum, integrity, tarball: `${registryUrl}${manifest.name}/-/${file}` },
      },
    },
    _attachments: {
      [file]: {
        content_type: "application/octet-stream",
        data: Buffer.from(tarball).toString("base64"),
        length: tarball.byteLength,
      },
    },
  };
}

export async function publishPackage(registryUrl: string, dir: string, workDir: string, tag = "latest"): Promise<void> {
  const { tarball, manifest } = await packDirectory(dir, join(workDir, "tarballs"));
  const response = await fetch(`${registryUrl}${manifest.name.replace("/", "%2f")}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildPublishBody(registryUrl, manifest, tarball, tag)),
  });
  if (!response.ok)
    throw new Error(`publish ${manifest.name}@${manifest.version} failed: ${response.status} ${await response.text()}`);
}

/** Copies an installed package (resolved from `fromDir`) into `<toRoot>/<name>@<version>/`. */
export async function copyInstalledPackage(name: string, fromDir: string, toRoot: string): Promise<string> {
  const source = dirname(Bun.resolveSync(`${name}/package.json`, fromDir));
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as FixtureManifest;
  const target = join(toRoot, folderName(manifest));
  await cp(source, target, {
    recursive: true,
    dereference: true,
    // Relative to the package folder: an installed package lives inside node_modules/.bun/…/node_modules itself.
    filter: (path) => !path.slice(source.length).includes("/node_modules"),
  });
  return target;
}

/** The fixtures every npm integration test and npm scenario uses. */
export async function publishStandardFixtures(
  registryUrl: string,
  workRoot: string,
  options: { zod?: boolean } = {},
): Promise<void> {
  const src = join(workRoot, "fixtures");
  const packages = [
    await writeFixturePackage(
      src,
      { name: "fixture-outdated", version: "1.0.0", main: "index.js" },
      {
        "index.js": "module.exports = { version: '1.0.0' };\n",
      },
    ),
    await writeFixturePackage(
      src,
      { name: "fixture-outdated", version: "1.1.0", main: "index.js" },
      {
        "index.js": "module.exports = { version: '1.1.0' };\n",
      },
    ),
    await writeFixturePackage(
      src,
      {
        name: "fixture-script",
        version: "1.0.0",
        main: "index.js",
        scripts: { postinstall: "touch postinstall-ran.txt" },
      },
      { "index.js": "module.exports = 'script';\n" },
    ),
    await writeFixturePackage(
      src,
      { name: "@jslab-fixture/scoped", version: "1.0.0", main: "index.js" },
      {
        "index.js": "module.exports = { scoped: 'ok' };\n",
      },
    ),
    await writeFixturePackage(
      src,
      { name: "fixture-untyped", version: "1.0.0", main: "index.js" },
      {
        "index.js": "module.exports = { untyped: 'yes' };\n",
      },
    ),
    await writeFixturePackage(
      src,
      { name: "@types/fixture-untyped", version: "1.0.0", types: "index.d.ts" },
      {
        "index.d.ts": "export declare const untyped: string;\n",
      },
    ),
  ];
  if (options.zod) packages.push(await copyInstalledPackage("zod", resolve(import.meta.dir, "../../shared"), src));
  for (const dir of packages) await publishPackage(registryUrl, dir, workRoot);
}
