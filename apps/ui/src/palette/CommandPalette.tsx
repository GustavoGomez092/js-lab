import { chordFromEvent, chordsEqual, type ResolvedBinding, shortcutFor } from "@jslab/shared";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { CommandRegistry } from "../commands/registry";
import { getEditorHandle } from "../editor/editor-handle";
import { useOverlayPresence } from "../shell/overlay-presence";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { paletteItems } from "./items";
import { buildSections, firstEnabledIndex, type RankedItem, stepEnabledIndex } from "./match";

export function CommandPalette(props: {
  store: AppStore;
  registry: CommandRegistry;
  bindings: readonly ResolvedBinding[];
}) {
  const modal = useStore(props.store, (s) => s.modal);
  if (modal?.kind !== "palette") return null;
  return <PaletteBody {...props} context={modal.context} />;
}

function highlight(title: string, ranges: [number, number][]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) nodes.push(title.slice(cursor, start));
    nodes.push(<mark key={start}>{title.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < title.length) nodes.push(title.slice(cursor));
  return nodes;
}

function PaletteBody(props: {
  store: AppStore;
  registry: CommandRegistry;
  bindings: readonly ResolvedBinding[];
  context: "editor" | "output";
}) {
  const { store, registry, bindings, context } = props;
  // M4 T9c: this component only ever mounts while the palette is open (`CommandPalette` above returns null
  // otherwise), so its whole mount lifetime IS the open window -- see `overlay-presence.ts`. This is the
  // deliverable Task 9a's screenshot caught occluded by a docked Web View: see WebViewHosts.tsx.
  useOverlayPresence(true);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

  const items = useMemo(() => paletteItems(registry, bindings, store.getState().themeId), [registry, bindings, store]);
  const sections = useMemo(() => buildSections(items, query, context), [items, query, context]);
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  // R-M4-PALETTE-HIDE-1: `active` is the raw index the user last moved to; `selected` normalises it onto an
  // enabled row, and is the SINGLE owner of "the selection is never a disabled row". Normalising during render
  // rather than in an effect covers every way the raw index lands on a disabled row -- the initial 0, the
  // setActive(0) on every keystroke, and hovering a disabled row -- so none of those needs its own guard.
  // -1 means nothing listed can run, and Enter is then a genuine no-op.
  const selected = flat[active]?.enabled ? active : firstEnabledIndex(flat);
  // Fix round 1 (m-2): the close chord follows a rebound view.commandPalette keybinding, not a hard-coded ⌘⇧P.
  const closeChord = useMemo(() => shortcutFor(bindings, "view.commandPalette"), [bindings]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scrolls whenever the selected index changes, even though `active` isn't read directly (the DOM query finds the element by its aria-selected attribute).
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const close = () => {
    store.getState().closeModal();
    // Fix round 1 (m-4): mirrors RenameDialog's guard — a detached or removed opener falls back to the editor
    // instead of stranding focus (or throwing on a stale ref).
    const previous = previousFocus.current;
    if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    else getEditorHandle()?.focus();
  };

  const run = (item: RankedItem | undefined) => {
    // R-M4-PALETTE-HIDE-1: a disabled row is inert on both paths -- it must not close the palette either, or a
    // click would dismiss the very explanation the user just went looking for.
    if (!item?.enabled) return;
    close();
    registry.execute(item.id, item.args);
  };

  const optionId = (index: number) => `palette-option-${index}`;
  let index = -1;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: clicking the scrim is a pointer shortcut for Escape */}
      <div
        className="palette-scrim"
        onMouseDown={(event) => {
          // Fix round 1 (m-1): default mousedown focus handling on the (about to be unmounted) scrim can blur
          // whatever close() just refocused; prevent it so the restored focus sticks.
          event.preventDefault();
          close();
        }}
      />
      {/* Fix round 1 (I-1): a mousedown anywhere in the panel other than the input (the input row padding, the
          badge, a section label, the footer, "No matching commands") would otherwise blur the input to body,
          leaving Escape/⌘⇧P/↑↓/Enter unreachable (only a scrim click could close it). Rows keep their own
          onClick; this only blocks the browser's default focus-follows-mousedown. */}
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={strings.palette.label}
        onMouseDown={(event) => {
          if (event.target !== input.current) event.preventDefault();
        }}
      >
        <div className="palette-input">
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={selected >= 0 ? optionId(selected) : undefined}
            aria-label={strings.palette.label}
            placeholder={strings.palette.placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive(stepEnabledIndex(flat, selected, 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(stepEnabledIndex(flat, selected, -1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(flat[selected]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              } else {
                // Fix round 1 (m-2): the resolver ignores view.commandPalette entirely while a modal is open
                // (keybindings/resolver.ts), so this is the only place a rebound close chord can be honored.
                const chord = chordFromEvent(event);
                if (chord && closeChord && chordsEqual(chord, closeChord)) {
                  event.preventDefault();
                  close();
                }
              }
            }}
          />
          <span className="palette-context" data-testid="palette-context">
            {strings.palette.context[context]}
          </span>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {flat.length === 0 && <div className="palette-empty">{strings.palette.empty}</div>}
          {sections.map((section) => (
            <div className="palette-group" key={section.category} role="presentation">
              <div className="palette-label" role="presentation">
                {section.label}
              </div>
              {section.items.map((item) => {
                index += 1;
                const position = index;
                return (
                  <div
                    key={`${item.id}:${JSON.stringify(item.args ?? null)}`}
                    id={optionId(position)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={position === selected}
                    aria-disabled={item.enabled ? undefined : true}
                    className="palette-item"
                    onMouseMove={() => setActive(position)}
                    onClick={() => run(item)}
                    onKeyDown={() => {}}
                  >
                    <span className="palette-title">{highlight(item.title, item.ranges)}</span>
                    {item.description && <span className="palette-desc">{item.description}</span>}
                    {!item.enabled && <span className="palette-unavailable">{strings.palette.unavailable}</span>}
                    {item.keys.length > 0 && (
                      <span className="palette-keys">
                        {item.keys.map((key) => (
                          <Fragment key={key}>
                            <b>{key}</b>
                          </Fragment>
                        ))}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <b>{strings.palette.footer.keys.run}</b>
            {strings.palette.footer.run}
          </span>
          <span>
            <b>{strings.palette.footer.keys.move}</b>
            {strings.palette.footer.move}
          </span>
          <span>
            <b>{strings.palette.footer.keys.close}</b>
            {strings.palette.footer.close}
          </span>
        </div>
      </div>
    </>
  );
}
