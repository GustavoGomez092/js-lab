import type { EncodedValue } from "@jslab/rpc-schema";
import type { DisplayEvent } from "../state/output";
import { childrenOf, formatFrame, formatPrimitive, keyLabel, summarize } from "./format";

const MAX_TEXT_DEPTH = 3;

/** Plain-text rendering for Copy / Copy All. Deep or lazy values fall back to their summary. */
export function valueToText(value: EncodedValue, nested = false, depth = 0): string {
  const primitive = formatPrimitive(value, nested);
  if (primitive !== null) return primitive;
  const children = childrenOf(value);
  if (!children || depth >= MAX_TEXT_DEPTH) return summarize(value);
  const child = (c: { value: EncodedValue | null; label: string }) =>
    c.value ? valueToText(c.value, true, depth + 1) : c.label;
  switch (value.t) {
    case "array":
    case "set":
      return `[${children.map(child).join(", ")}]`;
    case "object": {
      const props = children.filter((c) => c.label !== "[[Prototype]]").map((c) => `${c.label}: ${child(c)}`);
      const prefix = value.ctor && value.ctor !== "Object" ? `${value.ctor} ` : "";
      return props.length > 0 ? `${prefix}{ ${props.join(", ")} }` : `${prefix}{}`;
    }
    case "map":
      return `Map(${value.size}) { ${children.map((c) => `${c.label} ${child(c)}`).join(", ")} }`;
    default:
      return summarize(value);
  }
}

export function entryToText(event: DisplayEvent): string {
  switch (event.kind) {
    case "result":
      return valueToText(event.value);
    case "console":
      return event.args.map((arg) => valueToText(arg)).join(" ");
    case "stdout":
    case "stderr":
      return event.text.replace(/\n$/, "");
    case "error": {
      const frames = event.stack
        .filter((frame) => frame.user && frame.line != null)
        .map((frame) => `    at ${frame.fn ?? "<anonymous>"} (L${frame.line}:${frame.column ?? 1})`);
      return [`${event.name}: ${event.message}`, ...frames].join("\n");
    }
  }
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * OU-10 "Copy as JSON". The one-line text `ValueView` already shows for a value, used as the JSON stand-in for
 * every value JSON cannot represent. Anchoring to `format.ts` rather than inventing placeholders means the
 * clipboard says exactly what the row on screen says.
 */
const uiText = (value: EncodedValue): string => formatPrimitive(value, true) ?? summarize(value);

/**
 * OU-10. An `EncodedValue` as JSON-representable data.
 *
 * The rule, and it is one rule rather than a table of special cases: a value with a JSON-native counterpart
 * becomes that counterpart (objects, arrays, collections, finite numbers, strings, booleans, null, dates as ISO
 * text); every other value becomes the very string the row already displays.
 *
 * Two properties follow, and both are the point rather than side effects:
 *
 * - It cannot throw. `JSON.stringify` throws on a BigInt and on a cycle; neither can reach it, because the
 *   runtime already encoded those as `bigint` (digits as text) and `circular` before the value ever crossed the
 *   RPC boundary, and both land in the `uiText` fallback here.
 * - It cannot yield `undefined`. `JSON.stringify` silently DROPS `undefined`, functions and symbols -- from an
 *   object's properties, and as a whole-document result -- which would make Copy as JSON put the literal text
 *   `undefined` on the clipboard for `console.log(undefined)`. Each of those encodes to its displayed text
 *   instead, so the key survives and the document is always valid JSON.
 *
 * What it does NOT do is re-fetch. A truncated string, a lazily-held `handle`/`getter`, or a collection page
 * beyond the first serialises as what the UI was actually sent -- the same bytes the row is rendering. Copy as
 * JSON is a copy of the output row, not a second, deeper read of a run that may already be over.
 */
export function valueToJson(value: EncodedValue): JsonValue {
  switch (value.t) {
    case "null":
      return null;
    case "boolean":
      return value.v;
    case "number": {
      // `v` is text, so `NaN`, `Infinity`, `-Infinity` and `-0` -- none of them JSON numbers -- survive as their
      // own spelling rather than being coerced to `null` the way `JSON.stringify` coerces the first three.
      const parsed = Number(value.v);
      return Number.isFinite(parsed) && String(parsed) === value.v ? parsed : value.v;
    }
    case "string":
      return value.v;
    case "date":
      return value.iso ?? "Invalid Date";
    case "url":
      return value.href;
    case "object": {
      const out: Record<string, JsonValue> = {};
      for (const [key, child] of value.props) out[keyLabel(key)] = valueToJson(child);
      return out;
    }
    case "array": {
      const out: JsonValue[] = [];
      for (const item of value.items) {
        if (Array.isArray(item)) out.push(valueToJson(item[1]));
        // A sparse array's holes are the one case JSON agrees with: `JSON.stringify([,,1])` writes nulls too.
        else for (let i = 0; i < item.hole; i += 1) out.push(null);
      }
      return out;
    }
    case "set":
      return value.items.map(valueToJson);
    // Pairs, not an object: a Map's keys are arbitrary values, and folding them into property names would
    // collapse the distinct keys `1` and `"1"` onto each other.
    case "map":
      return value.entries.map(([key, child]) => [valueToJson(key), valueToJson(child)]);
    case "typedArray":
      // Already numbers, or text for the bigint views and for NaN/±Infinity/-0 -- `childrenOf`'s own rule.
      return [...value.items];
    case "arrayBuffer":
      return { byteLength: value.byteLength, bytes: [...value.preview] };
    case "headers":
      return Object.fromEntries(value.entries);
    case "response":
      return {
        status: value.status,
        statusText: value.statusText,
        url: value.url,
        headers: Object.fromEntries(value.headers),
      };
    case "error":
      return errorToJson(value.name, value.message, value.stack.map(formatFrame), value.cause);
    default:
      return uiText(value);
  }
}

function errorToJson(name: string, message: string, stack: string[], cause?: EncodedValue): JsonValue {
  const out: Record<string, JsonValue> = { name, message, stack };
  if (cause !== undefined) out.cause = valueToJson(cause);
  return out;
}

/** OU-10: one output row as JSON-representable data, mirroring `entryToText`'s per-kind split. */
export function entryToJson(event: DisplayEvent): JsonValue {
  switch (event.kind) {
    case "result":
      return valueToJson(event.value);
    // A lone argument copies as itself; several copy as the list they were logged as, so `console.log(a, b)`
    // round-trips rather than being joined into one string the way the plain-text path joins it.
    case "console":
      return event.args.length === 1 ? valueToJson(event.args[0] as EncodedValue) : event.args.map(valueToJson);
    case "stdout":
    case "stderr":
      return event.text.replace(/\n$/, "");
    case "error":
      return errorToJson(
        event.name,
        event.message,
        event.stack.filter((frame) => frame.user && frame.line != null).map(formatFrame),
      );
  }
}

/** OU-10: the exact text Copy as JSON puts on the clipboard. Indented, because a human is about to read it. */
export function entryToJsonText(event: DisplayEvent): string {
  return JSON.stringify(entryToJson(event), null, 2);
}
