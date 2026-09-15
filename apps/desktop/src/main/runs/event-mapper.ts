import type { RawRunEvent, RunEvent, StackFrame } from "@jslab/rpc-schema";
import type { RawSourceMap } from "@jslab/transform";
import { SourceMapConsumer } from "source-map-js";

/** Maps runner events (generated positions) back to the user's original source lines. */
export function createEventMapper(map: RawSourceMap, entryBase: string, logpointLines: ReadonlySet<number>) {
  const consumer = new SourceMapConsumer(map as never);

  const original = (line: number, column: number) => {
    const pos = consumer.originalPositionFor({ line, column: Math.max(0, column - 1) });
    return pos.line == null ? null : { line: pos.line, column: (pos.column ?? 0) + 1 };
  };

  const mapFrames = (frames: StackFrame[]): StackFrame[] =>
    frames.map((frame) => {
      if (!frame.file?.endsWith(entryBase) || frame.line == null) return frame;
      const pos = original(frame.line, frame.column ?? 1);
      const { file: _file, ...rest } = frame;
      return pos ? { ...rest, line: pos.line, column: pos.column, user: true } : { ...rest, user: true };
    });

  return (event: RawRunEvent): RunEvent => {
    switch (event.kind) {
      case "result":
        return event.source === "magic" && logpointLines.has(event.line) ? { ...event, source: "logpoint" } : event;
      case "console": {
        const { at, stack, ...rest } = event;
        const pos = at ? original(at.line, at.column) : null;
        return { ...rest, ...(pos ? { line: pos.line } : {}), ...(stack ? { stack: mapFrames(stack) } : {}) };
      }
      case "error": {
        const stack = mapFrames(event.stack);
        const top = stack.find((frame) => frame.user && frame.line != null);
        return { ...event, stack, ...(top ? { line: top.line, column: top.column } : {}) };
      }
      default:
        return event;
    }
  };
}
