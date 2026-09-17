import type { EncodedValue, PropKey, StackFrame } from "@jslab/rpc-schema";

export interface EncodeLimits {
  maxDepth: number;
  maxProps: number;
  maxEntries: number;
  maxString: number;
  maxFullString: number;
  maxFunctionSource: number;
  /**
   * Exact budget, in JSON UTF-8 bytes, for the values of one event (spec §5.9: 256 KB), summaries and the overflow
   * marker included. A value that doesn't fit becomes a short summary (a handle with a preview).
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
 * request answered on its own (not a run event), so the per-event budget doesn't apply; MAX_EXPAND_BYTES bounds it.
 */
export const EXPANDED_LIMITS: EncodeLimits = {
  ...DEFAULT_LIMITS,
  maxDepth: 1,
  maxProps: 1000,
  maxEntries: 10_000,
  maxEncodedBytes: Number.POSITIVE_INFINITY,
};

/** Largest reply to one expand request, in JSON UTF-8 bytes (R-M1-17(b)). */
export const MAX_EXPAND_BYTES = 4 * 1024 * 1024;
/** A smaller event budget is raised to this, so a summary and the overflow marker always fit. */
export const MIN_EVENT_BYTES = 1024;
/** Upper bound on the JSON size of the overflow marker plus its separator. */
const MARKER_BYTES = 64;
const MIN_EXPAND_STRING = 100;

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

/** Runs `read`, swallowing any throw (a hostile or cross-realm accessor) and returning `fallback` instead. */
function readSafely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** `Node.ELEMENT_NODE`. Hardcoded, never read from the node: only Elements are encoded as `dom` (spec §5.9). */
const ELEMENT_NODE = 1;

/**
 * True for anything duck-typed as a DOM Element: `nodeType === 1` and a string `tagName`. No `instanceof` (a node
 * from another document or realm has a different prototype chain) and no throw (either accessor may be hostile).
 */
function isDomElement(obj: object): obj is { tagName: string } {
  return readSafely(() => {
    const candidate = obj as { nodeType?: unknown; tagName?: unknown };
    return candidate.nodeType === ELEMENT_NODE && typeof candidate.tagName === "string";
  }, false);
}

/** `text.slice(0, end)`, one unit shorter when the cut would keep only the high half of a surrogate pair. */
function slicePairSafe(text: string, end: number): string {
  if (end >= text.length) return text;
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/** Inspects `obj`, so it can run Proxy traps and throw: never call it with a Proxy. */
function preview(obj: object): string {
  if (Array.isArray(obj)) return `Array(${obj.length})`;
  if (obj instanceof Map) return `Map(${obj.size})`;
  if (obj instanceof Set) return `Set(${obj.size})`;
  return `${slicePairSafe(ctorName(obj) ?? "Object", MAX_PREVIEW)} {…}`;
}

/** Exact UTF-8 size of `text` as a JSON string body (without the quotes), as JSON.stringify writes it. */
export function jsonStringBytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20)
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 6; // a lone surrogate is written as \uXXXX
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/** The longest prefix of `text` whose JSON string body fits in `maxBytes`. A surrogate pair is never split. */
export function clipToJsonBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    const size = pair ? 4 : jsonStringBytes(text.charAt(i));
    if (bytes + size > maxBytes) return text.slice(0, i);
    bytes += size;
    if (pair) i++;
  }
  return text;
}

// M4 Task 9b: this module runs in a **webview** as well as in Bun -- `packages/runner-web` imports it to encode
// every `console.log` argument and every `__jl.log` value -- and a webview has no `Buffer`. `TextEncoder` is the
// standard API both realms have, exactly as `EventBuffer` (`packages/runner-shared`) already does its own byte
// accounting. One instance is reused rather than constructed per call.
const textEncoder = new TextEncoder();

/** Exact size of `value` serialized with JSON.stringify, in UTF-8 bytes. */
export function jsonBytes(value: unknown): number {
  // Exact: JSON.stringify already escapes lone surrogates, so its UTF-8 length is the wire size (FA-m13).
  return textEncoder.encode(JSON.stringify(value) ?? "").length;
}

/** Replaces the values of an event that no longer fit even as summaries. */
export function moreValuesMarker(count: number): EncodedValue {
  return { t: "string", v: `[${count} more values not shown]` };
}

/** Thrown (and caught inside the Encoder) when a value exceeds the remaining budget. */
const BUDGET_EXCEEDED = Symbol("budget exceeded");

// Estimated JSON overhead of one encoded node, e.g. `[12,{"t":"number","v":"-1.2345678901234567e+308"}]`. The
// estimate only aborts early; the exact size of every accepted value is measured with jsonBytes.
const NODE_BYTES = 48;

export class Encoder {
  #nextId = 1;
  readonly #ids = new WeakMap<object, number>();
  #remaining = Number.POSITIVE_INFINITY;
  /** OU-02: where this expansion's root collection starts. Non-zero only inside `#encodeAt`. */
  #rootOffset = 0;

  constructor(
    readonly registry: HandleRegistry,
    readonly limits: EncodeLimits = DEFAULT_LIMITS,
    readonly hooks: EncodeHooks = {},
  ) {}

  encode(value: unknown): EncodedValue {
    return this.encodeMany([value])[0] as EncodedValue;
  }

  /**
   * Encodes the values of one event (for example console arguments) so that JSON.stringify of the result is at most
   * max(limits.maxEncodedBytes, MIN_EVENT_BYTES) UTF-8 bytes (spec §5.9; R-M1-17(a), R-M1-18). Each value is encoded
   * in full when it fits, otherwise as a summary; when a summary doesn't fit either, one marker replaces the rest.
   * Never throws the internal budget sentinel.
   */
  encodeMany(values: unknown[]): EncodedValue[] {
    if (this.limits.maxEncodedBytes === Number.POSITIVE_INFINITY) {
      return values.map((value) => this.#encode(value, 0, new Set()));
    }
    const limit = Math.max(this.limits.maxEncodedBytes, MIN_EVENT_BYTES);
    // An object that didn't fit with some room won't fit with less: it goes straight to its summary.
    const tooLarge = new WeakMap<object, number>();
    const out: EncodedValue[] = [];
    let used = 2; // "[" and "]"
    for (let index = 0; index < values.length; index++) {
      const separator = out.length > 0 ? 1 : 0;
      const fitted = this.#fit(values[index], limit - used - separator - MARKER_BYTES, tooLarge);
      if (!fitted) {
        out.push(moreValuesMarker(values.length - index));
        break;
      }
      out.push(fitted.value);
      used += fitted.bytes + separator;
    }
    return out;
  }

  /**
   * Returns null when the handle is unknown (for example after the registry was cleared).
   *
   * `offset` (OU-02) is the index of the first collection entry to encode; the default, 0, is exactly the
   * behaviour every caller had before this parameter existed. A `string` or `function` handle ignores it —
   * neither has entries to page. A `getter` handle honours it, because the value a getter returns is a
   * perfectly ordinary collection.
   */
  expand(handle: string, offset = 0): EncodedValue | null {
    const target = this.registry.get(handle);
    if (!target) return null;
    switch (target.kind) {
      case "string": {
        const full = target.value;
        const shown = clipToJsonBytes(
          slicePairSafe(full, this.limits.maxFullString),
          MAX_EXPAND_BYTES - 2 * MARKER_BYTES,
        );
        return shown.length < full.length
          ? { t: "string", v: shown, truncated: { total: full.length, handle } }
          : { t: "string", v: shown };
      }
      case "getter": {
        let value: unknown;
        try {
          value = Reflect.get(target.owner, target.key, target.receiver);
        } catch (error) {
          value = error;
        }
        return this.#expandValue(value, offset);
      }
      case "value":
        if (typeof target.value === "function") {
          let source = "";
          try {
            source = Function.prototype.toString.call(target.value);
          } catch {}
          return { t: "string", v: slicePairSafe(source, this.limits.maxFunctionSource) };
        }
        return this.#expandValue(target.value, offset);
    }
  }

  /** The full encoding when it fits in `available` bytes, else a summary when that fits, else null. */
  #fit(
    value: unknown,
    available: number,
    tooLarge: WeakMap<object, number>,
  ): { value: EncodedValue; bytes: number } | null {
    if (available <= 0) return null;
    const isObject = (typeof value === "object" && value !== null) || typeof value === "function";
    const failedWith = isObject ? tooLarge.get(value as object) : undefined;
    const mark = this.registry.mark();
    if (failedWith === undefined || failedWith < available) {
      this.#remaining = available;
      try {
        const full = this.#encode(value, 0, new Set());
        const bytes = jsonBytes(full);
        if (bytes <= available) return { value: full, bytes };
      } catch (error) {
        if (error !== BUDGET_EXCEEDED) throw error;
      } finally {
        this.#remaining = Number.POSITIVE_INFINITY;
      }
      this.registry.rollback(mark);
      if (isObject) tooLarge.set(value as object, available);
    }
    let summary: EncodedValue;
    try {
      summary = this.#summary(value);
    } catch (error) {
      // Round-2 containment: the budget sentinel never leaves the Encoder (it would reach user code via console.log).
      if (error !== BUDGET_EXCEEDED) throw error;
      summary = { t: "string", v: "[Value too large to show]" };
    }
    const bytes = jsonBytes(summary);
    if (bytes <= available) return { value: summary, bytes };
    this.registry.rollback(mark);
    return null;
  }

  /** A short stand-in for a value too large for its event: a lazy handle, or a cut primitive (spec §5.9). */
  #summary(value: unknown): EncodedValue {
    switch (typeof value) {
      case "string":
        return {
          t: "string",
          v: slicePairSafe(value, MAX_PREVIEW),
          truncated: { total: value.length, handle: this.registry.register({ kind: "string", value }) },
        };
      case "bigint": {
        // A huge bigint shows its first digits as text; expanding the handle returns the whole digit string.
        const digits = value.toString();
        if (digits.length <= MAX_PREVIEW) return { t: "bigint", v: digits };
        return {
          t: "string",
          v: digits.slice(0, MAX_PREVIEW),
          truncated: { total: digits.length, handle: this.registry.register({ kind: "string", value: digits }) },
        };
      }
      case "symbol":
        return { t: "symbol", desc: slicePairSafe(value.description ?? "", MAX_PREVIEW) };
      case "object":
      case "function":
        if (value !== null) {
          const shown = this.#summaryPreview(value);
          return { t: "handle", handle: this.registry.register({ kind: "value", value }), preview: shown };
        }
    }
    // undefined, null, booleans and numbers encode to at most 45 bytes.
    return this.#encode(value, 0, new Set());
  }

  /**
   * A summary's preview. A Proxy is named without touching its target, so none of its traps run (final review M6), and
   * a value whose inspection throws gets a generic preview: a summary never throws into user code.
   */
  #summaryPreview(obj: object): string {
    if (this.hooks.isProxy?.(obj)) return "Proxy";
    try {
      return preview(obj);
    } catch {
      return "Object {…}";
    }
  }

  /** OU-02: the offset applies to the root value of one expansion only, never to nested children. */
  #encodeAt(value: unknown, offset: number): EncodedValue {
    this.#rootOffset = offset;
    try {
      return this.#encode(value, 0, new Set());
    } finally {
      this.#rootOffset = 0;
    }
  }

  /** One expansion level, halving the collection and string limits until the reply fits MAX_EXPAND_BYTES. */
  #expandValue(value: unknown, offset = 0): EncodedValue {
    let limits: EncodeLimits = EXPANDED_LIMITS;
    for (;;) {
      const mark = this.registry.mark();
      const child = new Encoder(this.registry, limits, this.hooks);
      child.#remaining = MAX_EXPAND_BYTES;
      try {
        const encoded = child.#encodeAt(value, offset);
        if (jsonBytes(encoded) <= MAX_EXPAND_BYTES) return encoded;
      } catch (error) {
        if (error !== BUDGET_EXCEEDED) throw error;
      }
      this.registry.rollback(mark);
      if (limits.maxEntries === 1 && limits.maxProps === 1 && limits.maxString === MIN_EXPAND_STRING) {
        return { t: "string", v: "[Value too large to show]" };
      }
      limits = {
        ...limits,
        maxEntries: Math.max(1, Math.floor(limits.maxEntries / 2)),
        maxProps: Math.max(1, Math.floor(limits.maxProps / 2)),
        maxString: Math.max(MIN_EXPAND_STRING, Math.floor(limits.maxString / 2)),
      };
    }
  }

  #charge(bytes: number): void {
    this.#remaining -= bytes;
    if (this.#remaining < 0) throw BUDGET_EXCEEDED;
  }

  /** Charges user-controlled text by its exact JSON size. Characters are a lower bound, so huge text aborts first. */
  #chargeText(text: string, overhead = 0): void {
    if (text.length + overhead > this.#remaining) throw BUDGET_EXCEEDED;
    this.#charge(overhead + jsonStringBytes(text));
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
        this.#chargeText(desc);
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
      this.#chargeText(v);
      return { t: "string", v };
    }
    const shown = slicePairSafe(v, maxString);
    this.#chargeText(shown);
    return {
      t: "string",
      v: shown,
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
    this.#chargeText(fn.name);
    return { t: "function", name: fn.name, kind, handle: this.registry.register({ kind: "value", value: fn }) };
  }

  #object(obj: object, depth: number, ancestors: Set<object>): EncodedValue {
    if (this.hooks.isProxy?.(obj)) return { t: "object", id: this.#id(obj), ctor: "Proxy", props: [], proxy: true };
    if (obj instanceof Date) return { t: "date", iso: Number.isNaN(obj.getTime()) ? null : obj.toISOString() };
    if (obj instanceof RegExp) {
      this.#chargeText(obj.source);
      return { t: "regexp", source: obj.source, flags: obj.flags };
    }
    if (typeof URL !== "undefined" && obj instanceof URL) {
      this.#chargeText(obj.href);
      return { t: "url", href: obj.href };
    }
    // A DOM node never recurses (its children aren't walked, only counted), so — like Date/RegExp/URL above — it
    // is encoded in full at any depth rather than turned into a depth handle.
    if (isDomElement(obj)) return this.#dom(obj);
    if (obj instanceof WeakMap) return { t: "weak", kind: "WeakMap" };
    if (obj instanceof WeakSet) return { t: "weak", kind: "WeakSet" };
    if (typeof WeakRef !== "undefined" && obj instanceof WeakRef) return { t: "weak", kind: "WeakRef" };
    if (obj instanceof Error) {
      this.#chargeText(String(obj.name));
      this.#chargeText(String(obj.message));
      const stack = parseStack(obj.stack ?? "");
      for (const frame of stack) {
        this.#chargeText(frame.fn ?? "", NODE_BYTES);
        this.#chargeText(frame.file ?? "");
      }
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
      return this.#typedArray(obj as unknown as ArrayLike<number | bigint> & object, depth);
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
      this.#chargeText(obj.url);
      this.#chargeText(obj.statusText);
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
    for (const [k, v] of entries) {
      this.#chargeText(k, 16);
      this.#chargeText(v);
    }
  }

  /**
   * A DOM Element as tag, attributes, child count and an outerHTML preview (spec §5.9). Reads exactly those four
   * things, each individually guarded: a detached node, one from an exotic document, or one whose accessors throw
   * all encode without throwing, at worst with empty fields. Children are counted (`childNodes.length`), never
   * walked, so a node with many children costs the same as one with none.
   */
  #dom(obj: { tagName: string }): EncodedValue {
    const el = obj as { tagName?: unknown; attributes?: unknown; childNodes?: unknown; outerHTML?: unknown };

    const tag = readSafely(() => String(el.tagName ?? ""), "");
    this.#chargeText(tag);

    const attrs: [string, string][] = [];
    const attributes = readSafely(
      () => el.attributes as ArrayLike<{ name?: unknown; value?: unknown }> | null | undefined,
      undefined,
    );
    const attrCount = readSafely(() => {
      const length = attributes?.length;
      return typeof length === "number" ? length : 0;
    }, 0);
    const attrLimit = Math.min(attrCount, this.limits.maxEntries);
    for (let i = 0; i < attrLimit; i++) {
      const attr = readSafely(() => attributes?.[i], undefined);
      if (!attr) continue;
      attrs.push([readSafely(() => String(attr.name ?? ""), ""), readSafely(() => String(attr.value ?? ""), "")]);
    }
    this.#chargeEntries(attrs);

    const childCount = readSafely(() => {
      const n = Number((el.childNodes as { length?: unknown } | null | undefined)?.length ?? 0);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }, 0);

    const rawOuterHTML = readSafely(() => String(el.outerHTML ?? ""), "");
    const { maxString } = this.limits;
    if (rawOuterHTML.length <= maxString) {
      this.#chargeText(rawOuterHTML);
      return { t: "dom", nodeType: ELEMENT_NODE, tag, attrs, childCount, outerHTML: rawOuterHTML };
    }
    // The preview is bounded like any string preview (spec §5.9); the full markup is available through a handle.
    const shown = slicePairSafe(rawOuterHTML, maxString);
    this.#chargeText(shown);
    return {
      t: "dom",
      nodeType: ELEMENT_NODE,
      tag,
      attrs,
      childCount,
      outerHTML: shown,
      truncated: {
        total: rawOuterHTML.length,
        handle: this.registry.register({ kind: "string", value: rawOuterHTML }),
      },
    };
  }

  /**
   * OU-02: the half-open range of this collection to encode, and the paging fields to attach.
   *
   * Only the root of an expansion is ever offset. `#encode` recurses at depth > 0, so a nested collection inside
   * the page starts at 0, exactly as it always has. (`#encodeAt`'s `finally` is what clears `#rootOffset`;
   * clearing it here as well would be a second, unpinnable copy of the same guarantee.)
   *
   * `end` is never below `start`: an offset past the end must be an empty page, not a negative range — which
   * would loop backwards here and *credit* the byte budget in `#typedArray`'s `#charge`.
   */
  #take(
    total: number,
    depth: number,
  ): { start: number; end: number; page: { from?: number; next?: number; more?: number } } {
    const start = depth === 0 ? this.#rootOffset : 0;
    const end = Math.max(start, Math.min(total, start + this.limits.maxEntries));
    const more = Math.max(0, total - end);
    return {
      start,
      end,
      page: { ...(start > 0 ? { from: start } : {}), ...(more > 0 ? { more, next: end } : {}) },
    };
  }

  #array(arr: unknown[], depth: number, ancestors: Set<object>): EncodedValue {
    const { start, end, page } = this.#take(arr.length, depth);
    const items: ([number, EncodedValue] | { hole: number })[] = [];
    let holes = 0;
    for (let i = start; i < end; i++) {
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
    this.#chargeText(ctor);
    return {
      t: "array",
      id: this.#id(arr),
      ctor,
      length: arr.length,
      items,
      ...page,
      ...(page.more ? { handle: this.registry.register({ kind: "value", value: arr }) } : {}),
    };
  }

  #typedArray(view: ArrayLike<number | bigint> & object, depth: number): EncodedValue {
    const { start, end, page } = this.#take(view.length, depth);
    const items: (number | string)[] = [];
    for (let i = start; i < end; i++) {
      const x = view[i] as number | bigint;
      // JSON has no NaN, ±Infinity or -0, so those items are strings, like scalar numbers. The UI reads the
      // item type from `ctor` (Big* arrays hold bigints), never from typeof.
      if (typeof x === "bigint") items.push(x.toString());
      else if (Number.isFinite(x) && !Object.is(x, -0)) items.push(x);
      else items.push(Object.is(x, -0) ? "-0" : String(x));
    }
    this.#charge((end - start) * 24);
    return {
      t: "typedArray",
      ctor: ctorName(view) ?? "TypedArray",
      length: view.length,
      items,
      ...page,
      ...(page.more ? { handle: this.registry.register({ kind: "value", value: view }) } : {}),
    };
  }

  #map(map: Map<unknown, unknown>, depth: number, ancestors: Set<object>): EncodedValue {
    const { start, end, page } = this.#take(map.size, depth);
    const entries: [EncodedValue, EncodedValue][] = [];
    let index = 0;
    for (const [k, v] of map) {
      if (index >= end) break;
      if (index++ < start) continue;
      entries.push([this.#encode(k, depth + 1, ancestors), this.#encode(v, depth + 1, ancestors)]);
    }
    return {
      t: "map",
      id: this.#id(map),
      size: map.size,
      entries,
      ...page,
      ...(page.more ? { handle: this.registry.register({ kind: "value", value: map }) } : {}),
    };
  }

  #set(set: Set<unknown>, depth: number, ancestors: Set<object>): EncodedValue {
    const { start, end, page } = this.#take(set.size, depth);
    const items: EncodedValue[] = [];
    let index = 0;
    for (const v of set) {
      if (index >= end) break;
      if (index++ < start) continue;
      items.push(this.#encode(v, depth + 1, ancestors));
    }
    return {
      t: "set",
      id: this.#id(set),
      size: set.size,
      items,
      ...page,
      ...(page.more ? { handle: this.registry.register({ kind: "value", value: set }) } : {}),
    };
  }

  #plain(obj: object, depth: number, ancestors: Set<object>): EncodedValue {
    const keys = Reflect.ownKeys(obj);
    const props: [PropKey, EncodedValue][] = [];
    const toKey = (key: PropertyKey): PropKey => {
      const propKey: PropKey = typeof key === "symbol" ? { sym: key.description ?? "" } : { k: String(key) };
      this.#chargeText("k" in propKey ? propKey.k : propKey.sym, 16);
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
    this.#chargeText(ctor ?? "", NODE_BYTES);
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
