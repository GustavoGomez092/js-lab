import type { RunEvent } from "@jslab/rpc-schema";
import type { OutputEntry } from "../state/output";
import { strings } from "../strings";
import { entryLevel } from "./filters";
import { formatPrimitive, tableModel } from "./format";
import { type ExpandHandle, ValueView } from "./ValueView";

interface EntryRowProps {
  entry: OutputEntry;
  stale: boolean;
  expand: ExpandHandle;
  onReveal(line: number): void;
  onHover(line: number | null): void;
  showLineNumbers?: boolean;
}

type ErrorEvent = Extract<RunEvent, { kind: "error" }>;
type ConsoleEvent = Extract<RunEvent, { kind: "console" }>;

function kindClass(event: OutputEntry["event"]): string {
  return event.kind === "console" ? `console-${event.level}` : event.kind;
}

export function EntryRow({ entry, stale, expand, onReveal, onHover, showLineNumbers = true }: EntryRowProps) {
  const { event } = entry;
  const line = event.kind === "result" || event.kind === "console" || event.kind === "error" ? event.line : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only mirrors the source-line highlight in the editor
    <div
      data-testid="entry"
      className={`entry entry-${kindClass(event)} entry-level-${entryLevel(event)}${stale ? " entry-stale" : ""}`}
      style={{ paddingLeft: event.kind === "console" ? event.groupDepth * 16 : 0 }}
      onMouseEnter={() => onHover(line ?? null)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="entry-stripe" aria-hidden="true" />
      <div className="entry-body">
        {event.kind === "result" && <ValueView value={event.value} expand={expand} />}
        {event.kind === "console" && <ConsoleBody event={event} expand={expand} />}
        {(event.kind === "stdout" || event.kind === "stderr") && <pre className="entry-stream">{event.text}</pre>}
        {event.kind === "error" && <ErrorBody event={event} onReveal={onReveal} />}
      </div>
      {showLineNumbers && line !== undefined && (
        <button
          type="button"
          className="entry-line"
          aria-label={`L${line}`}
          title={strings.output.jumpToLine(line)}
          onClick={() => onReveal(line)}
        >
          :{line}
        </button>
      )}
    </div>
  );
}

function ConsoleBody({ event, expand }: { event: ConsoleEvent; expand: ExpandHandle }) {
  const first = event.args[0];
  const table = event.level === "table" && first ? tableModel(first) : null;
  if (table) {
    return (
      <table className="entry-table">
        <thead>
          <tr>
            <th>{strings.output.tableIndex}</th>
            {table.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.key}>
              <td>{row.key}</td>
              {table.columns.map((column) => {
                const cell = row.cells.get(column);
                return <td key={column}>{cell ? (formatPrimitive(cell, true) ?? "…") : ""}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <span className="entry-args">
      {event.args.map((arg, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: console arguments have no identity
        <ValueView key={index} value={arg} expand={expand} />
      ))}
    </span>
  );
}

function ErrorBody({ event, onReveal }: { event: ErrorEvent; onReveal(line: number): void }) {
  const userFrames = event.stack.filter((frame) => frame.user && frame.line != null);
  const internal = event.stack.length - userFrames.length;
  return (
    <div className="entry-error">
      <strong>
        {event.phase === "unhandledRejection" ? strings.output.uncaughtInPromise : ""}
        {event.name}: {event.message}
      </strong>
      {event.codeFrame && <pre className="entry-codeframe">{event.codeFrame}</pre>}
      {userFrames.map((frame, index) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: stack frames can repeat
          key={index}
          type="button"
          className="entry-frame"
          onClick={() => onReveal(frame.line as number)}
        >
          at {frame.fn ?? "<anonymous>"} (L{frame.line}:{frame.column})
        </button>
      ))}
      {internal > 0 && <span className="entry-internal">{strings.output.internalFrames(internal)}</span>}
    </div>
  );
}
