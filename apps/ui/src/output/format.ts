import type { EncodedValue, PropKey, StackFrame } from "@jslab/rpc-schema";

/** Text for values that render inline without a tree. Returns null for structured values. */
export function formatPrimitive(value: EncodedValue, nested: boolean): string | null {
  switch (value.t) {
    case "undefined":
      return "undefined";
    case "null":
      return "null";
    case "boolean":
      return String(value.v);
    case "number":
      return value.v;
    case "bigint":
      return `${value.v}n`;
    case "symbol":
      return `Symbol(${value.desc})`;
    case "string":
      // Strings print verbatim at the top level and quoted when nested (spec §7.2).
      return nested ? JSON.stringify(value.v) : value.v;
    case "date":
      return value.iso ?? "Invalid Date";
    case "regexp":
      return `/${value.source}/${value.flags}`;
    case "url":
      return value.href;
    case "circular":
      return "[Circular]";
    case "weak":
      return `${value.kind} { <items unknown> }`;
    default:
      return null;
  }
}

/** One-line summary for a structured value (used for collapsed nodes and map keys). */
export function summarize(value: EncodedValue): string {
  switch (value.t) {
    case "object":
      return `${value.proxy ? "Proxy " : ""}${value.ctor ?? "[Object: null prototype]"} {${value.props.length > 0 || value.more ? "…" : ""}}`;
    case "array":
      return `${value.ctor}(${value.length})`;
    case "map":
      return `Map(${value.size})`;
    case "set":
      return `Set(${value.size})`;
    case "promise":
      return `Promise { <${value.state}> }`;
    case "error":
      return `${value.name}: ${value.message}`;
    case "function":
      return value.kind === "class" ? `class ${value.name || "(anonymous)"}` : `ƒ ${value.name || "(anonymous)"}()`;
    case "typedArray":
      return `${value.ctor}(${value.length})`;
    case "arrayBuffer":
      return `ArrayBuffer(${value.byteLength})`;
    case "headers":
      return `Headers(${value.entries.length})`;
    case "response":
      return `Response { status: ${value.status} }`;
    case "getter":
      return "(...)";
    case "handle":
      return value.preview;
    default:
      return formatPrimitive(value, true) ?? "";
  }
}

// Unicode identifiers such as `café` or `π` print bare, as JavaScript prints them (final review T15).
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

export function keyLabel(key: PropKey): string {
  if (!("k" in key)) return `[Symbol(${key.sym})]`;
  return IDENTIFIER.test(key.k) ? key.k : JSON.stringify(key.k);
}

export type Child = { label: string; value: EncodedValue } | { label: string; value: null };

const text = (v: string): EncodedValue => ({ t: "string", v });

export function formatFrame(frame: StackFrame): string {
  const where =
    frame.line != null ? `${frame.user ? "L" : `${frame.file ?? "?"}:`}${frame.line}:${frame.column ?? 0}` : "native";
  return `at ${frame.fn ?? "<anonymous>"} (${where})`;
}

/** Child rows shown when a node is expanded; null when the value has no children. */
export function childrenOf(value: EncodedValue): Child[] | null {
  switch (value.t) {
    case "object":
      return [
        ...value.props.map(([key, v]) => ({ label: keyLabel(key), value: v })),
        ...(value.proto ? [{ label: "[[Prototype]]", value: value.proto }] : []),
      ];
    case "array":
      return value.items.map((item) =>
        Array.isArray(item)
          ? { label: String(item[0]), value: item[1] }
          : { label: `<${item.hole} empty items>`, value: null },
      );
    case "map":
      return value.entries.map(([k, v]) => ({ label: `${summarize(k)} =>`, value: v }));
    case "set":
      return value.items.map((v, i) => ({ label: String(i), value: v }));
    case "promise":
      return value.value ? [{ label: "[[PromiseResult]]", value: value.value }] : null;
    case "error":
      return [
        ...(value.stack.length > 0 ? [{ label: "stack", value: text(value.stack.map(formatFrame).join("\n")) }] : []),
        ...(value.cause ? [{ label: "[cause]", value: value.cause }] : []),
      ];
    case "typedArray": {
      // Items are numbers, or strings for bigints and for NaN, ±Infinity and -0; the constructor decides the type.
      // Only these two hold bigints; a subclass such as `class BigData extends Uint8Array` holds numbers.
      const bigint = /^Big(Int|Uint)64Array$/.test(value.ctor);
      return value.items.map((v, i) => ({
        label: String(i),
        value: bigint ? { t: "bigint", v: String(v) } : { t: "number", v: String(v) },
      }));
    }
    case "arrayBuffer":
      return [{ label: "[[Bytes]]", value: text(value.preview.join(" ")) }];
    case "headers":
      return value.entries.map(([k, v]) => ({ label: k, value: text(v) }));
    case "response":
      return [
        { label: "status", value: { t: "number", v: String(value.status) } },
        { label: "statusText", value: text(value.statusText) },
        { label: "url", value: text(value.url) },
      ];
    default:
      return null;
  }
}

/** Rows and columns for console.table: union of keys across rows, capped at 1000 rows (spec §5.10). */
export function tableModel(
  value: EncodedValue,
): { columns: string[]; rows: { key: string; cells: Map<string, EncodedValue> }[] } | null {
  const rows = childrenOf(value);
  if (!rows || (value.t !== "array" && value.t !== "object")) return null;
  const columns: string[] = [];
  const out: { key: string; cells: Map<string, EncodedValue> }[] = [];
  for (const row of rows.slice(0, 1000)) {
    if (!row.value || row.label === "[[Prototype]]") continue;
    const cells = new Map<string, EncodedValue>();
    const nested = row.value.t === "object" || row.value.t === "array" ? childrenOf(row.value) : null;
    if (nested) {
      for (const cell of nested) {
        if (!cell.value || cell.label === "[[Prototype]]") continue;
        if (!columns.includes(cell.label)) columns.push(cell.label);
        cells.set(cell.label, cell.value);
      }
    } else {
      if (!columns.includes("Values")) columns.push("Values");
      cells.set("Values", row.value);
    }
    out.push({ key: row.label, cells });
  }
  return { columns, rows: out };
}
