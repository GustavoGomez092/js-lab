import type { EncodedValue } from "@jslab/rpc-schema";
import type { DisplayEvent } from "../state/output";
import { childrenOf, formatPrimitive, summarize } from "./format";

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
