import type { RunEvent } from "@jslab/rpc-schema";
import { useCallback, useRef, useState } from "react";
import { runtimeMissingPackage, runtimeMissingRelative } from "../editor/install-assist";
import type { OutputEntry } from "../state/output";
import { strings } from "../strings";
import { ContextMenu, type MenuEntry } from "../tabs/ContextMenu";
import { copyEntry } from "./copy";
import { entryLevel } from "./filters";
import { formatPrimitive, tableModel } from "./format";
import { LinkedText } from "./LinkedText";
import { type ExpandHandle, ValueView } from "./ValueView";

interface EntryRowProps {
  entry: OutputEntry;
  stale: boolean;
  expand: ExpandHandle;
  onReveal(line: number): void;
  onHover(line: number | null): void;
  showLineNumbers?: boolean;
  onInstall?(name: string): void;
  onChangeWorkingDirectory?(): void;
  /** R24-4: a primitive selector; when false, a relative module-not-found row offers to set a WD. */
  hasWorkingDirectory?: boolean;
  /**
   * OU-10: how the entry menu's Copy / Copy as JSON report themselves. `OutputPanel` points this at the very
   * status chip Copy All already uses, so a row-level copy and a whole-panel copy say the same thing in the
   * same place instead of growing a second notification path.
   */
  onCopyStatus?(status: "copied" | "failed"): void;
  /**
   * OU-13: opens an http(s) URL the user activated in this row, in their browser. Left off by callers that have
   * no route to Main, which renders the row's URLs as ordinary text rather than as controls that do nothing.
   */
  onOpenLink?(url: string): void;
}

type ErrorEvent = Extract<RunEvent, { kind: "error" }>;
type ConsoleEvent = Extract<RunEvent, { kind: "console" }>;

function kindClass(event: OutputEntry["event"]): string {
  return event.kind === "console" ? `console-${event.level}` : event.kind;
}

export function EntryRow({
  entry,
  stale,
  expand,
  onReveal,
  onHover,
  showLineNumbers = true,
  onInstall,
  onChangeWorkingDirectory,
  hasWorkingDirectory,
  onCopyStatus,
  onOpenLink,
}: EntryRowProps) {
  const { event } = entry;
  const line = event.kind === "result" || event.kind === "console" || event.kind === "error" ? event.line : undefined;
  // OU-10. `ContextMenu` -- the tab bar's -- is the app's one context-menu mechanism, so the menu lives where
  // `TabBar` puts its own: in local state beside the thing it acts on, rendered only while open.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  // `ContextMenu` moves focus into itself on open, so closing must hand focus back to the control that opened
  // it; otherwise a keyboard user is returned to the top of the document with the row lost behind them.
  const closeMenu = useCallback(() => {
    setMenu(null);
    menuButton.current?.focus();
  }, []);
  // Anchored under the button rather than at the pointer, because this is the path with no pointer position.
  const openMenuAtButton = () => {
    const rect = menuButton.current?.getBoundingClientRect();
    setMenu({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
  };
  const menuItems: MenuEntry[] = [
    {
      id: "copy",
      label: strings.output.copyEntry,
      run: () => void copyEntry(event, "text").then((status) => onCopyStatus?.(status)),
    },
    {
      id: "copyJson",
      label: strings.output.copyEntryJson,
      run: () => void copyEntry(event, "json").then((status) => onCopyStatus?.(status)),
    },
  ];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only mirrors the source-line highlight in the editor
    <div
      data-testid="entry"
      className={`entry entry-${kindClass(event)} entry-level-${entryLevel(event)}${stale ? " entry-stale" : ""}`}
      style={{ paddingLeft: event.kind === "console" ? event.groupDepth * 16 : 0 }}
      onMouseEnter={() => onHover(line ?? null)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={(pointerEvent) => {
        pointerEvent.preventDefault();
        setMenu({ x: pointerEvent.clientX, y: pointerEvent.clientY });
      }}
      onKeyDown={(keyEvent) => {
        // Shift+F10 and the Menu key are the platform gestures for "open the context menu here". macOS keyboards
        // carry no Menu key at all, which is why the button below -- an ordinary Tab stop -- is the primary
        // keyboard path rather than the fallback.
        if (keyEvent.key !== "ContextMenu" && !(keyEvent.shiftKey && keyEvent.key === "F10")) return;
        keyEvent.preventDefault();
        openMenuAtButton();
      }}
    >
      <span className="entry-stripe" aria-hidden="true" />
      <div className="entry-body">
        {event.kind === "result" && <ValueView value={event.value} expand={expand} onOpenLink={onOpenLink} />}
        {event.kind === "console" && <ConsoleBody event={event} expand={expand} onOpenLink={onOpenLink} />}
        {(event.kind === "stdout" || event.kind === "stderr") && (
          <pre className="entry-stream">
            <LinkedText text={event.text} onOpenLink={onOpenLink} />
          </pre>
        )}
        {event.kind === "error" && (
          <ErrorBody
            event={event}
            onReveal={onReveal}
            onInstall={onInstall}
            onChangeWorkingDirectory={onChangeWorkingDirectory}
            hasWorkingDirectory={hasWorkingDirectory}
            onOpenLink={onOpenLink}
          />
        )}
      </div>
      {showLineNumbers && line !== undefined && (
        <button
          type="button"
          className="entry-line"
          aria-label={`L${line}`}
          title={strings.output.jumpToLine(line)}
          onClick={() => onReveal(line)}
          // Item 8: pointer/keyboard parity. The row reports hover on mouse enter/leave, which drives the editor's
          // .line-hover decoration; tabbing to this badge must say which editor line the row belongs to exactly as
          // the mouse does. (Since OU-10 it shares the row with the entry-menu button, which carries no line.)
          onFocus={() => onHover(line)}
          onBlur={() => onHover(null)}
        >
          :{line}
        </button>
      )}
      {/* OU-10: present on every row, including the stdout/stderr rows that have no line badge and would
          otherwise contain nothing a keyboard could reach at all. */}
      <button
        type="button"
        ref={menuButton}
        className="entry-menu-button"
        aria-label={strings.output.entryMenu}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={openMenuAtButton}
      >
        ⋯
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}

function ConsoleBody({
  event,
  expand,
  onOpenLink,
}: {
  event: ConsoleEvent;
  expand: ExpandHandle;
  onOpenLink?(url: string): void;
}) {
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
        <ValueView key={index} value={arg} expand={expand} onOpenLink={onOpenLink} />
      ))}
    </span>
  );
}

function ErrorBody({
  event,
  onReveal,
  onInstall,
  onChangeWorkingDirectory,
  hasWorkingDirectory,
  onOpenLink,
}: {
  event: ErrorEvent;
  onReveal(line: number): void;
  onInstall?(name: string): void;
  onChangeWorkingDirectory?(): void;
  hasWorkingDirectory?: boolean;
  onOpenLink?(url: string): void;
}) {
  const userFrames = event.stack.filter((frame) => frame.user && frame.line != null);
  const internal = event.stack.length - userFrames.length;
  return (
    <div className="entry-error">
      <strong>
        {event.phase === "unhandledRejection" ? strings.output.uncaughtInPromise : ""}
        {event.name}: <LinkedText text={event.message} onOpenLink={onOpenLink} />
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
          {strings.output.frame(frame.fn ?? strings.output.anonymous, frame.line as number, frame.column as number)}
        </button>
      ))}
      {internal > 0 && <span className="entry-internal">{strings.output.internalFrames(internal)}</span>}
      {event.name === "WorkingDirectoryError" && onChangeWorkingDirectory && (
        <button type="button" className="entry-action" onClick={onChangeWorkingDirectory}>
          {strings.output.changeWorkingDirectory}
        </button>
      )}
      {!hasWorkingDirectory && onChangeWorkingDirectory && runtimeMissingRelative(event.message) && (
        <button type="button" className="entry-action" onClick={onChangeWorkingDirectory}>
          {strings.output.setWorkingDirectory}
        </button>
      )}
      {(() => {
        const missing = onInstall ? runtimeMissingPackage(event.message) : null;
        return missing ? (
          <button type="button" className="entry-action" onClick={() => onInstall?.(missing)}>
            {strings.output.installPackage(missing)}
          </button>
        ) : null;
      })()}
    </div>
  );
}
