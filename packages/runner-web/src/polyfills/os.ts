/**
 * Task 10 (spec §5.13): the `browser-node` `os` polyfill -- "snapshot values (sync)", nothing live.
 *
 * Mirrors `process.ts`'s split exactly: this file exports only the pure `createOsPolyfill(snapshot)` factory (so
 * `bun test` can call it directly with a fixture), and `apps/desktop/src/main/bundling/polyfill-plugin.ts` appends
 * `export default createOsPolyfill(<snapshot>);` after this file's text when it serves the bundled `os` module,
 * using values read from Main's own `node:os` at that same bundle-build moment.
 */

export interface OsCpuSnapshot {
  model: string;
  speed: number;
}

export interface OsSnapshot {
  arch: string;
  platform: string;
  release: string;
  type: string;
  version: string;
  homedir: string;
  tmpdir: string;
  hostname: string;
  endianness: "BE" | "LE";
  eol: string;
  cpus: OsCpuSnapshot[];
  totalmem: number;
  freemem: number;
}

export interface OsPolyfill {
  arch(): string;
  platform(): string;
  release(): string;
  type(): string;
  version(): string;
  homedir(): string;
  tmpdir(): string;
  hostname(): string;
  endianness(): "BE" | "LE";
  EOL: string;
  cpus(): OsCpuSnapshot[];
  totalmem(): number;
  freemem(): number;
}

export function createOsPolyfill(snapshot: OsSnapshot): OsPolyfill {
  return {
    arch: () => snapshot.arch,
    platform: () => snapshot.platform,
    release: () => snapshot.release,
    type: () => snapshot.type,
    version: () => snapshot.version,
    homedir: () => snapshot.homedir,
    tmpdir: () => snapshot.tmpdir,
    hostname: () => snapshot.hostname,
    endianness: () => snapshot.endianness,
    EOL: snapshot.eol,
    cpus: () => snapshot.cpus.map((cpu) => ({ ...cpu })),
    totalmem: () => snapshot.totalmem,
    freemem: () => snapshot.freemem,
  };
}
