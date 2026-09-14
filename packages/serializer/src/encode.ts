import type { EncodedValue, PropKey, StackFrame } from "@jslab/rpc-schema";

export interface EncodeLimits {
  maxDepth: number;
  maxProps: number;
  maxEntries: number;
  maxString: number;
  maxFullString: number;
  maxFunctionSource: number;
  /**
   * Estimated JSON size budget shared by the values of one event (spec §5.9: 256 KB). A root value that would
   * exceed it becomes a handle with a short preview instead.
   */
  maxEncodedBytes: number;
}

export const DEFAULT_LIMITS: EncodeLimits = {
  maxDepth: 3,
  maxProps: 100,
  maxEntries: 1000,
  maxString: 10_000,
  maxFullString: 1_000_000,
  maxFunctionSource: 2_000,
  maxEncodedBytes: 256 * 1024,
};

/**
 * Limits used when the user expands a handle: one level at a time, larger collections. An expansion is an explicit
 * request answered on its own (not a run event), so the per-event size budget doesn't apply: expanding an oversized
 * root must return its contents, not the same handle again.
 */
export const EXPANDED_LIMITS: EncodeLimits = {
  ...DEFAULT_LIMITS,
  maxDepth: 1,
  maxProps: 1000,
  maxEntries: 10_000,
  maxEncodedBytes: Number.POSITIVE_INFINITY,
};

export interface EncodeHooks {
  peekPromise?(promise: Promise<unknown>): { state: "pending" | "fulfilled" | "rejected"; value?: unknown };
  isProxy?(value: object): boolean;
}

export type HandleTarget =
  | { kind: "value"; value: unknown }
  | { kind: "string"; value: string }
  | { kind: "getter"; owner: object; receiver: object; key: PropertyKey };

export class HandleRegistry {
  #next = 1;
  readonly #targets = new Map<string, HandleTarget>();

  register(target: HandleTarget): string {
    const id = `h${this.#next++}`;
    this.#targets.set(id, target);
    return id;
  }

  get(id: string): HandleTarget | undefined {
    return this.#targets.get(id);
  }

  get size(): number {
    return this.#targets.size;
  }

  clear(): void {
    this.#targets.clear();
  }

  /** The id the next registration will get; pass it to rollback() to release everything registered after it. */
  mark(): number {
    return this.#next;
  }

  /** Releases handles registered since `mark`. Only valid for ids that were never sent anywhere. */
  rollback(mark: number): void {
    for (let n = mark; n < this.#next; n++) this.#targets.delete(`h${n}`);
    this.#next = mark;
  }
}

const FRAME = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?\s*$/;

export function parseStack(stack: string): StackFrame[] {
  return stack.split("\n").flatMap((line) => {
    const m = FRAME.exec(line);
    if (!m) return [];
    const [, fn, file, l, c] = m;
    return [{ ...(fn ? { fn } : {}), file, line: Number(l), column: Number(c), user: false }];
  });
}

function ctorName(obj: object): string | null {
  try {
    const proto = Object.getPrototypeOf(obj);
    if (proto === null) return null;
    const ctor = proto.constructor;
    return typeof ctor === "function" && ctor.name ? ctor.name : "Object";
  } catch {
    return "Object";
  }
}

const MAX_PREVIEW = 100;

function preview(obj: object): string {
  if (Array.isArray(obj)) return `Array(${obj.length})`;
  if (obj instanceof Map) return `Map(${obj.size})`;
  if (obj instanceof Set) return `Set(${obj.size})`;
  return `${(ctorName(obj) ?? "Object").slice(0, MAX_PREVIEW)} {…}`;
}

/** Thrown (and caught in encodeMany) when a root value exceeds the remaining size budget. */
const BUDGET_EXCEEDED = Symbol("budget exceeded");

// Estimated JSON overhead of one encoded node, e.g. `[12,{"t":"number","v":"-1.2345678901234567e+308"}]`.
const NODE_BYTES = 48;

export class Encoder {
  #nextId = 1;
  readonly #ids = new WeakMap<object, number>();
  #remaining = Number.POSITIVE_INFINITY;

  constructor(
    readonly registry: HandleRegistry,
    readonly limits: EncodeLimits = DEFAULT_LIMITS,
    readonly hooks: EncodeHooks = {},
  ) {}

  encode(value: unknown): EncodedValue {
    return this.encodeMany([value])[0] as EncodedValue;
  }

  /** Encodes the values of one event (e.g. console arguments) against one shared size budget. */
  encodeMany(values: unknown[]): EncodedValue[] {
    let remaining = this.limits.maxEncodedBytes;
    return values.map((value) => {
      const mark = this.registry.mark();
      this.#remaining = remaining;
      try {
        const encoded = this.#encode(value, 0, new Set());
        remaining = this.#remaining;
        return encoded;
      } catch (error) {
        if (error !== BUDGET_EXCEEDED) throw error;
        this.registry.rollback(mark);
        remaining = Math.max(0, remaining - NODE_BYTES - MAX_PREVIEW);
        // The fallback must not charge the exhausted budget: `finally` only resets it after this returns, and a
        // charge here would throw the sentinel out of encodeMany and into user code (console.log).
        this.#remaining = Number.POSITIVE_INFINITY;
        try {
          return this.#oversized(value);
        } catch (fallbackError) {
          if (fallbackError !== BUDGET_EXCEEDED) throw fallbackError;
          return { t: "string", v: "[Value too large to show]" };
        }
      } finally {
        this.#remaining = Number.POSITIVE_INFINITY;
      }
    });
  }

  /** Returns null when the handle is unknown (for example after the registry was cleared). */
  expand(handle: string): EncodedValue | null {
    const target = this.registry.get(handle);
    if (!target) return null;
    const child = new Encoder(this.registry, EXPANDED_LIMITS, this.hooks);
    switch (target.kind) {
      case "string": {
        const { maxFullString } = this.limits;
        const v = target.value;
        return v.length > maxFullString
          ? { t: "string", v: v.slice(0, maxFullString), truncated: { total: v.length, handle } }
          : { t: "string", v };
      }
      case "getter":
        try {
          return child.encode(Reflect.get(target.owner, target.key, target.receiver));
        } catch (error) {
          return child.encode(error);
        }
      case "value":
        if (typeof target.value === "function") {
          let source = "";
          try {
            source = Function.prototype.toString.call(target.value);
          } catch {}
          return { t: "string", v: source.slice(0, this.limits.maxFunctionSource) };
        }
        return child.encode(target.value);
    }
  }

  #charge(bytes: number): void {
    this.#remaining -= bytes;
    if (this.#remaining < 0) throw BUDGET_EXCEEDED;
  }

  /** A root value too large for one event: a lazy handle with a short preview (spec §5.9). */
  #oversized(value: unknown): EncodedValue {
    if (typeof value === "string") {
      return {
        t: "string",
        v: value.slice(0, MAX_PREVIEW),
        truncated: { total: value.length, handle: this.registry.register({ kind: "string", value }) },
      };
    }
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      return { t: "handle", handle: this.registry.register({ kind: "value", value }), preview: preview(value) };
    }
    // Other primitives are small; encode them without a budget.
    return this.#encode(value, 0, new Set());
  }

  #id(obj: object): number {
    let id = this.#ids.get(obj);
    if (id === undefined) {
      id = this.#nextId++;
      this.#ids.set(obj, id);
    }
    return id;
  }

  #encode(value: unknown, depth: number, ancestors: Set<object>): EncodedValue {
    this.#charge(NODE_BYTES);
    // A Proxy around a function would run its get/getOwnPropertyDescriptor traps in #function (final review M6).
    if (typeof value === "function" && this.hooks.isProxy?.(value)) {
      return { t: "object", id: this.#id(value), ctor: "Proxy", props: [], proxy: true };
    }
    switch (typeof value) {
      case "undefined":
        return { t: "undefined" };
      case "boolean":
        return { t: "boolean", v: value };
      case "number":
        return { t: "number", v: Object.is(value, -0) ? "-0" : String(value) };
      case "bigint": {
        const v = value.toString();
        this.#charge(v.length);
        return { t: "bigint", v };
      }
      case "symbol": {
        const desc = value.description ?? "";
        this.#charge(desc.length);
        return { t: "symbol", desc };
      }
      case "string":
        return this.#string(value);
      case "function":
        return this.#function(value as (...args: unknown[]) => unknown);
    }
    if (value === null) return { t: "null" };
    const obj = value as object;
    if (ancestors.has(obj)) return { t: "circular", ref: this.#id(obj) };
    try {
      ancestors.add(obj);
      return this.#object(obj, depth, ancestors);
    } catch (error) {
      if (error === BUDGET_EXCEEDED) throw error;
      return { t: "string", v: `[Uninspectable: ${String(error)}]` };
    } finally {
      ancestors.delete(obj);
    }
  }

  #string(v: string): EncodedValue {
    const { maxString } = this.limits;
    if (v.length <= maxString) {
      this.#charge(v.length);
      return { t: "string", v };
    }
    this.#charge(maxString);
    return {
      t: "string",
      v: v.slice(0, maxString),
      truncated: { total: v.length, handle: this.registry.register({ kind: "string", value: v }) },
    };
  }

  #function(fn: (...args: unknown[]) => unknown): EncodedValue {
    let source = "";
    try {
      source = Function.prototype.toString.call(fn);
    } catch {}
    const ctor = (fn as { constructor?: { name?: string } }).constructor?.name;
    const kind = /^class[\s{]/.test(source)
      ? "class"
      : ctor === "AsyncGeneratorFunction"
        ? "asyncGenerator"
        : ctor === "GeneratorFunction"
          ? "generator"
          : ctor === "AsyncFunction"
            ? "async"
            : fn.name.startsWith("bound ")
              ? "bound"
              : /\{\s*\[native code\]\s*\}\s*$/.test(source)
                ? "native"
                : Object.hasOwn(fn, "prototype")
                  ? "function"
                  : "arrow";
    this.#charge(fn.name.length);
    return { t: "function", name: fn.name, kind, handle: this.registry.register({ kind: "value", value: fn }) };
  }

  #object(obj: object, depth: number, ancestors: Set<object>): EncodedValue {
    if (this.hooks.isProxy?.(obj)) return { t: "object", id: this.#id(obj), ctor: "Proxy", props: [], proxy: true };
    if (obj instanceof Date) return { t: "date", iso: Number.isNaN(obj.getTime()) ? null : obj.toISOString() };
    if (obj instanceof RegExp) {
      this.#charge(obj.source.length);
      return { t: "regexp", source: obj.source, flags: obj.flags };
    }
    if (typeof URL !== "undefined" && obj instanceof URL) {
      this.#charge(obj.href.length);
      return { t: "url", href: obj.href };
    }
    if (obj instanceof WeakMap) return { t: "weak", kind: "WeakMap" };
    if (obj instanceof WeakSet) return { t: "weak", kind: "WeakSet" };
    if (typeof WeakRef !== "undefined" && obj instanceof WeakRef) return { t: "weak", kind: "WeakRef" };
    if (obj instanceof Error) {
      this.#charge(obj.name.length + obj.message.length);
      const stack = parseStack(obj.stack ?? "");
      for (const frame of stack) this.#charge(NODE_BYTES + (frame.fn?.length ?? 0) + (frame.file?.length ?? 0));
      const cause = "cause" in obj ? { cause: this.#encode(obj.cause, depth + 1, ancestors) } : {};
      return { t: "error", name: obj.name, message: obj.message, stack, ...cause };
    }
    if (obj instanceof Promise) {
      const peek = this.hooks.peekPromise?.(obj) ?? { state: "pending" as const };
      return {
        t: "promise",
        id: this.#id(obj),
        state: peek.state,
        ...(peek.state === "pending" ? {} : { value: this.#encode(peek.value, depth + 1, ancestors) }),
      };
    }
    if (depth >= this.limits.maxDepth) {
      return { t: "handle", handle: this.registry.register({ kind: "value", value: obj }), preview: preview(obj) };
    }
    if (Array.isArray(obj)) return this.#array(obj, depth, ancestors);
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView))
      return this.#typedArray(obj as unknown as ArrayLike<number | bigint> & object);
    if (obj instanceof ArrayBuffer) {
      this.#charge(4 * 32);
      return {
        t: "arrayBuffer",
        byteLength: obj.byteLength,
        preview: Array.from(new Uint8Array(obj, 0, Math.min(32, obj.byteLength))),
      };
    }
    if (obj instanceof Map) return this.#map(obj, depth, ancestors);
    if (obj instanceof Set) return this.#set(obj, depth, ancestors);
    if (typeof Headers !== "undefined" && obj instanceof Headers) {
      const entries = [...obj.entries()];
      this.#chargeEntries(entries);
      return { t: "headers", entries };
    }
    if (typeof Response !== "undefined" && obj instanceof Response) {
      const headers = [...obj.headers.entries()];
      this.#chargeEntries(headers);
      this.#charge(obj.url.length + obj.statusText.length);
      return {
        t: "response",
        status: obj.status,
        statusText: obj.statusText,
        url: obj.url,
        headers,
      };
    }
    return this.#plain(obj, depth, ancestors);
  }

  #chargeEntries(entries: [string, string][]): void {
    for (const [k, v] of entries) this.#charge(16 + k.length + v.length);
  }

  #array(arr: unknown[], depth: number, ancestors: Set<object>): EncodedValue {
    const limit = Math.min(arr.length, this.limits.maxEntries);
    const items: ([number, EncodedValue] | { hole: number })[] = [];
    let holes = 0;
    for (let i = 0; i < limit; i++) {
      if (!Object.hasOwn(arr, i)) {
        holes++;
        continue;
      }
      if (holes > 0) {
        items.push({ hole: holes });
        holes = 0;
      }
      items.push([i, this.#encode(arr[i], depth + 1, ancestors)]);
    }
    if (holes > 0) items.push({ hole: holes });
    const ctor = ctorName(arr) ?? "Array";
    this.#charge(ctor.length);
    return {
      t: "array",
      id: this.#id(arr),
      ctor,
      length: arr.length,
      items,
      ...(arr.length > limit
        ? { more: arr.length - limit, handle: this.registry.register({ kind: "value", value: arr }) }
        : {}),
    };
  }

  #typedArray(view: ArrayLike<number | bigint> & object): EncodedValue {
    const limit = Math.min(view.length, this.limits.maxEntries);
    const items: (number | string)[] = [];
    for (let i = 0; i < limit; i++) {
      const x = view[i] as number | bigint;
      // JSON has no NaN, ±Infinity or -0, so those items are strings, like scalar numbers. The UI reads the
      // item type from `ctor` (Big* arrays hold bigints), never from typeof.
      if (typeof x === "bigint") items.push(x.toString());
      else if (Number.isFinite(x) && !Object.is(x, -0)) items.push(x);
      else items.push(Object.is(x, -0) ? "-0" : String(x));
    }
    this.#charge(limit * 24);
    return {
      t: "typedArray",
      ctor: ctorName(view) ?? "TypedArray",
      length: view.length,
      items,
      ...(view.length > limit
        ? { more: view.length - limit, handle: this.registry.register({ kind: "value", value: view }) }
        : {}),
    };
  }

  #map(map: Map<unknown, unknown>, depth: number, ancestors: Set<object>): EncodedValue {
    const entries: [EncodedValue, EncodedValue][] = [];
    for (const [k, v] of map) {
      if (entries.length >= this.limits.maxEntries) break;
      entries.push([this.#encode(k, depth + 1, ancestors), this.#encode(v, depth + 1, ancestors)]);
    }
    return {
      t: "map",
      id: this.#id(map),
      size: map.size,
      entries,
      ...(map.size > entries.length
        ? { more: map.size - entries.length, handle: this.registry.register({ kind: "value", value: map }) }
        : {}),
    };
  }

  #set(set: Set<unknown>, depth: number, ancestors: Set<object>): EncodedValue {
    const items: EncodedValue[] = [];
    for (const v of set) {
      if (items.length >= this.limits.maxEntries) break;
      items.push(this.#encode(v, depth + 1, ancestors));
    }
    return {
      t: "set",
      id: this.#id(set),
      size: set.size,
      items,
      ...(set.size > items.length
        ? { more: set.size - items.length, handle: this.registry.register({ kind: "value", value: set }) }
        : {}),
    };
  }

  #plain(obj: object, depth: number, ancestors: Set<object>): EncodedValue {
    const keys = Reflect.ownKeys(obj);
    const props: [PropKey, EncodedValue][] = [];
    const toKey = (key: PropertyKey): PropKey => {
      const propKey: PropKey = typeof key === "symbol" ? { sym: key.description ?? "" } : { k: String(key) };
      this.#charge(16 + ("k" in propKey ? propKey.k.length : propKey.sym.length));
      return propKey;
    };
    let total = keys.length;

    for (const key of keys) {
      if (props.length >= this.limits.maxProps) break;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc) continue;
      if (desc.get || desc.set) {
        props.push([
          toKey(key),
          desc.get
            ? { t: "getter", handle: this.registry.register({ kind: "getter", owner: obj, receiver: obj, key }) }
            : { t: "undefined" },
        ]);
        continue;
      }
      props.push([toKey(key), this.#encode(desc.value, depth + 1, ancestors)]);
    }

    // Accessors inherited from class prototypes (not Object.prototype), evaluated against the instance.
    const own = new Set<PropertyKey>(keys);
    for (
      let proto = Object.getPrototypeOf(obj);
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const key of Reflect.ownKeys(proto)) {
        if (own.has(key) || key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (!desc?.get) continue;
        own.add(key);
        total++;
        if (props.length >= this.limits.maxProps) continue;
        props.push([
          toKey(key),
          { t: "getter", handle: this.registry.register({ kind: "getter", owner: proto, receiver: obj, key }) },
        ]);
      }
    }

    const ctor = ctorName(obj);
    this.#charge(NODE_BYTES + (ctor?.length ?? 0));
    const proto = Object.getPrototypeOf(obj);
    return {
      t: "object",
      id: this.#id(obj),
      ctor,
      props,
      ...(total > props.length
        ? { more: total - props.length, handle: this.registry.register({ kind: "value", value: obj }) }
        : {}),
      ...(proto && proto !== Object.prototype
        ? {
            proto: {
              t: "handle",
              handle: this.registry.register({ kind: "value", value: proto }),
              preview: `${ctor ?? "Object"}.prototype`,
            },
          }
        : {}),
      ...(keys.length > 0 && Object.isFrozen(obj) ? { frozen: true } : {}),
    };
  }
}
