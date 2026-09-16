import { z } from "zod";

/**
 * Task 11 (spec §5.13): the payload schemas for `browser-node`'s async Node bridge.
 *
 * These validate the **page → Main** direction only, which is the untrusted one: `host-bridge.ts` documents the
 * relay as forgeable by the page it belongs to, so every bridged call is parsed here before Main acts on it
 * (`apps/desktop/src/main/rpc/web-node-handlers.ts`, via `createValidators`). The Main → page direction is built by
 * Main itself and never re-enters it, so it carries types only -- the same split `ui-rpc.ts` makes for
 * `ViewMessages`.
 *
 * Note what is deliberately *not* here: a `tabId`. Which tab a call belongs to is derived from the webview
 * connection it arrived on (`WebRunSession`, `apps/desktop/src/main/runtimes/web-adapter.ts`), never from a field
 * the page supplies -- the same structural-identity rule Task 13's fix round 1 established for `fetchRequest`.
 */

/** Call ids are page-generated and monotonic; a repeat means a misbehaving page or relay. */
const callId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * One path argument. Length-bounded, and control characters (a NUL in particular) are refused outright: a NUL can
 * truncate a path inside a syscall, so a path carrying one is never legitimate however it is later resolved.
 *
 * This is the one path-shaped refusal that survived the ruling on §5.13 line 509. It is about the path being
 * well-formed, not about where it points: these calls carry the user's own permissions, the same as a `bun` tab.
 */
const filePath = z
  .string()
  .min(1)
  .max(4096)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the class intentionally excludes control characters
  .regex(/^[^\0-\x1f]+$/);

/** base64 file contents. Bounded so one call cannot hand Main an unbounded write. */
const fileBody = z.string().max(64 * 1024 * 1024);

const mkdirOptions = z.object({ recursive: z.boolean() });
const rmOptions = z.object({ recursive: z.boolean(), force: z.boolean() });

/**
 * The `fs` calls Main performs, each with its exact argument tuple. A discriminated union rather than
 * `{ method, args: unknown[] }` so that validation actually constrains the arguments -- a schema that accepted any
 * array would satisfy "every bridged call is validated" in name only.
 */
export const webNodeFsCallSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("readFile"), args: z.tuple([filePath]) }),
  z.object({ method: z.literal("writeFile"), args: z.tuple([filePath, fileBody]) }),
  z.object({ method: z.literal("appendFile"), args: z.tuple([filePath, fileBody]) }),
  z.object({ method: z.literal("readdir"), args: z.tuple([filePath]) }),
  z.object({ method: z.literal("mkdir"), args: z.tuple([filePath, mkdirOptions]) }),
  z.object({ method: z.literal("rm"), args: z.tuple([filePath, rmOptions]) }),
  z.object({ method: z.literal("rename"), args: z.tuple([filePath, filePath]) }),
  z.object({ method: z.literal("copyFile"), args: z.tuple([filePath, filePath]) }),
  z.object({ method: z.literal("stat"), args: z.tuple([filePath]) }),
  z.object({ method: z.literal("access"), args: z.tuple([filePath]) }),
]);

/** One command argument vector. Bounded in both count and size. */
const commandArgv = z.array(z.string().max(4096)).max(256);

/**
 * The options a page may pass to a command. `cwd`, `env` and `shell` are all **honoured** -- `exec(cmd, { cwd })`
 * is ordinary Node, and dropping it would be a parity bug against the `bun` runtime. An earlier draft refused them
 * to protect a working-directory confinement that the ruling on §5.13 line 509 removed; with the confinement gone,
 * so is the reason.
 */
const commandOptions = z.object({
  cwd: filePath.optional(),
  env: z.record(z.string().max(1024), z.string().max(131_072)).optional(),
  shell: z.union([z.boolean(), z.string().max(4096)]).optional(),
});

/**
 * `exec` takes a whole command line (a shell parses it); `execFile` and `spawn` take a file plus an argument
 * vector. Exact tuples, not an open `unknown[]`: the page normalizes every call to this fixed arity before sending
 * it (`packages/runner-web/src/node-bridge.ts`'s `startChild`) precisely so that validation here constrains the
 * arguments rather than waving them through. The options object is always present, empty when the caller passed
 * none, so the tuple stays fixed-length.
 */
export const webNodeChildProcessCallSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("exec"), args: z.tuple([z.string().min(1).max(8192), commandOptions]) }),
  z.object({
    method: z.literal("execFile"),
    args: z.tuple([z.string().min(1).max(4096), commandArgv, commandOptions]),
  }),
  z.object({ method: z.literal("spawn"), args: z.tuple([z.string().min(1).max(4096), commandArgv, commandOptions]) }),
]);

/** The envelope Main validates before routing a bridged call. */
export const webNodeCallSchema = z.union([
  z.object({ id: callId, module: z.literal("fs") }).and(webNodeFsCallSchema),
  z.object({ id: callId, module: z.literal("child_process") }).and(webNodeChildProcessCallSchema),
]);

export const webNodeAbortSchema = z.object({ id: callId });

export type WebNodeCall = z.infer<typeof webNodeCallSchema>;
export type WebNodeAbort = z.infer<typeof webNodeAbortSchema>;

/** What Main reports for `fs.stat`. Plain data: the page rebuilds `isFile()`/`isDirectory()` from it. */
export interface WebNodeStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}
