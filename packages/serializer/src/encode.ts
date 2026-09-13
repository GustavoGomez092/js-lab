import type { EncodedValue, PropKey, StackFrame } from "@jslab/rpc-schema";

export interface EncodeLimits {
  maxDepth: number;
  maxProps: number;
  maxEntries: number;
  maxString: number;
  maxFullString: number;
  maxFunctionSource: number;
}

export const DEFAULT_LIMITS: EncodeLimits = {
  maxDepth: 3,
  maxProps: 100,
  maxEntries: 1000,
  maxString: 10_000,
  maxFullString: 1_000_000,
  maxFunctionSource: 2_000,
};

/** Limits used when the user expands a handle: one level at a time, larger collections. */
export const EXPANDED_LIMITS: EncodeLimits = { ...DEFAULT_LIMITS, maxDepth: 1, maxProps: 1000, maxEntries: 10_000 };

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

function preview(obj: object): string {
  if (Array.isArray(obj)) return `Array(${obj.length})`;
  if (obj instanceof Map) return `Map(${obj.size})`;
  if (obj instanceof Set) return `Set(${obj.size})`;
  return `${ctorName(obj) ?? "Object"} {…}`;
}

export class Encoder {
  #nextId = 1;
  readonly #ids = new WeakMap<object, number>();

  constructor(
    readonly registry: HandleRegistry,
    readonly limits: EncodeLimits = DEFAULT_LIMITS,
    readonly hooks: EncodeHooks = {},
  ) {}

  encode(value: unknown): EncodedValue {
    return this.#encode(value, 0, new Set());
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

  #id(obj: object): number {
    let id = this.#ids.get(obj);
    if (id === undefined) {
      id = this.#nextId++;
      this.#ids.set(obj, id);
    }
    return id;
  }

  #encode(value: unknown, depth: number, ancestors: Set<object>): EncodedValue {
    switch (typeof value) {
      case "undefined":
        return { t: "undefined" };
      case "boolean":
        return { t: "boolean", v: value };
      case "number":
        return { t: "number", v: Object.is(value, -0) ? "-0" : String(value) };
      case "bigint":
        return { t: "bigint", v: value.toString() };
      case "symbol":
        return { t: "symbol", desc: value.description ?? "" };
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
      return { t: "string", v: `[Uninspectable: ${String(error)}]` };
    } finally {
      ancestors.delete(obj);
    }
  }

  #string(v: string): EncodedValue {
    const { maxString } = this.limits;
    if (v.length <= maxString) return { t: "string", v };
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
    return { t: "function", name: fn.name, kind, handle: this.registry.register({ kind: "value", value: fn }) };
  }

  #object(obj: object, depth: number, ancestors: Set<object>): EncodedValue {
    if (obj instanceof Date) return { t: "date", iso: Number.isNaN(obj.getTime()) ? null : obj.toISOString() };
    if (obj instanceof RegExp) return { t: "regexp", source: obj.source, flags: obj.flags };
    if (typeof URL !== "undefined" && obj instanceof URL) return { t: "url", href: obj.href };
    if (obj instanceof WeakMap) return { t: "weak", kind: "WeakMap" };
    if (obj instanceof WeakSet) return { t: "weak", kind: "WeakSet" };
    if (typeof WeakRef !== "undefined" && obj instanceof WeakRef) return { t: "weak", kind: "WeakRef" };
    if (this.hooks.isProxy?.(obj)) return { t: "object", id: this.#id(obj), ctor: "Proxy", props: [], proxy: true };
    if (obj instanceof Error) {
      const cause = "cause" in obj ? { cause: this.#encode(obj.cause, depth + 1, ancestors) } : {};
      return { t: "error", name: obj.name, message: obj.message, stack: parseStack(obj.stack ?? ""), ...cause };
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
      return {
        t: "arrayBuffer",
        byteLength: obj.byteLength,
        preview: Array.from(new Uint8Array(obj, 0, Math.min(32, obj.byteLength))),
      };
    }
    if (obj instanceof Map) return this.#map(obj, depth, ancestors);
    if (obj instanceof Set) return this.#set(obj, depth, ancestors);
    if (typeof Headers !== "undefined" && obj instanceof Headers) return { t: "headers", entries: [...obj.entries()] };
    if (typeof Response !== "undefined" && obj instanceof Response) {
      return {
        t: "response",
        status: obj.status,
        statusText: obj.statusText,
        url: obj.url,
        headers: [...obj.headers.entries()],
      };
    }
    return this.#plain(obj, depth, ancestors);
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
    return {
      t: "array",
      id: this.#id(arr),
      ctor: ctorName(arr) ?? "Array",
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
    const toKey = (key: PropertyKey): PropKey =>
      typeof key === "symbol" ? { sym: key.description ?? "" } : { k: String(key) };
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
