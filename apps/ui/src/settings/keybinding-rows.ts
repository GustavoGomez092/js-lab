import type { CommandCatalogEntry } from "@jslab/rpc-schema";
import {
  type CommandCategory,
  type CommandId,
  formatChord,
  type KeybindingRule,
  type ResolvedBinding,
  resolveKeybindings,
} from "@jslab/shared";

/** One chord that currently runs the row's command. */
export interface RowChord {
  /** The chord spec ("cmd+r"). */
  key: string;
  /** The keycap text ("⌘R"). */
  label: string;
}

export interface KeybindingRow {
  command: CommandId;
  title: string;
  category: CommandCategory;
  /** The highest-precedence chord spec ("cmd+r"), or null when the command is unbound. Matches `shortcutFor`. */
  key: string | null;
  /** The highest-precedence keycap text ("⌘R"), or null when unbound. */
  keyLabel: string | null;
  /** EVERY chord that runs this command, in resolution order (R-M5d-ALIAS-1). Empty when unbound. */
  chords: RowChord[];
  when: string | null;
  source: "default" | "user" | "none";
  /** Other commands whose binding can fire on one of this row's chords in the same context. */
  conflicts: CommandId[];
  /** True when keybindings.json carries any rule for this command, so "Reset" has something to undo. */
  customized: boolean;
  registered: boolean;
}

/**
 * Two bindings on the same chord collide when either one can fire in the other's context.
 *
 * A binding with no `when` is reachable everywhere, so it shadows a context-scoped binding on the same chord:
 * `KeybindingResolver.resolve` walks the bindings last-to-first and returns the first chord match whose `when`
 * passes, and `evaluateWhen(undefined, …)` is true. Two *different* non-empty clauses are left alone -- they are
 * usually mutually exclusive (`editorFocus` vs `outputFocus`), and a false conflict is worse than a missing one.
 */
function collides(a: ResolvedBinding, b: ResolvedBinding): boolean {
  return a.when === undefined || b.when === undefined || a.when === b.when;
}

/**
 * Whether `later` takes `earlier`'s chord away from it entirely.
 *
 * Same direction as `collides`, but asymmetric, because precedence is: the resolver takes the LAST chord match whose
 * `when` passes. A later binding with no `when` wins everywhere; one with the same `when` wins in that context. A
 * later binding with a *different* non-empty clause leaves the earlier one reachable elsewhere, so it is not a
 * takeover.
 */
function takesOver(later: ResolvedBinding, earlier: ResolvedBinding): boolean {
  if (later.key !== earlier.key) return false;
  return later.when === undefined || later.when === earlier.when;
}

/** The command id a rule addresses, with the `-` that marks a removal rule stripped off. */
function ruleCommand(rule: KeybindingRule): string {
  return rule.command.startsWith("-") ? rule.command.slice(1) : rule.command;
}

/**
 * The rows Settings → Keybindings renders (spec §6.5: Command, Keybinding, When, Source).
 *
 * One row per catalogue entry, in catalogue order -- the catalogue is `COMMANDS`, so a command added by any other
 * milestone appears here automatically (R-M5D-REGISTRY-1). `resolveKeybindings` does the precedence work, so the
 * table can never disagree with what the dispatcher actually does.
 *
 * R-M5d-ALIAS-1: one row per command stays, but the row lists EVERY chord bound to that command rather than only the
 * highest-precedence one. A user rule does not delete a command's defaults -- only a `-command` removal rule or
 * another command taking the chord does -- so showing one keycap per row hid `⌥⌘→`/`⌥⌘←` on Next/Previous Tab,
 * which spec §6.5 lists as their PRIMARY bindings, leaving them impossible to discover or reset.
 */
export function keybindingRows(
  catalogue: readonly CommandCatalogEntry[],
  defaults: readonly KeybindingRule[],
  rules: readonly KeybindingRule[],
  query: string,
): KeybindingRow[] {
  const resolved = resolveKeybindings(defaults, rules);
  // The highest-precedence binding per command drives the When/Source columns and `shortcutFor`'s keycap.
  const effective = new Map<string, ResolvedBinding>();
  for (const binding of resolved) effective.set(binding.command, binding);

  // Every chord a command still answers to. A binding another command has taken over is dropped -- it can never
  // fire -- UNLESS it is the command's effective binding, because that is exactly the case the conflict warning
  // below exists to explain ("⌘R now runs Stop"), and a row that silently emptied itself would explain nothing.
  const chordsFor = new Map<string, RowChord[]>();
  const liveFor = new Map<string, ResolvedBinding[]>();
  resolved.forEach((binding, index) => {
    const lost = resolved.some(
      (later, at) => at > index && later.command !== binding.command && takesOver(later, binding),
    );
    if (lost && effective.get(binding.command) !== binding) return;
    const chords = chordsFor.get(binding.command) ?? [];
    if (chords.some((chord) => chord.key === binding.key)) return;
    chords.push({ key: binding.key, label: formatChord(binding.chord) });
    chordsFor.set(binding.command, chords);
    liveFor.set(binding.command, [...(liveFor.get(binding.command) ?? []), binding]);
  });

  // Grouped over the live bindings rather than every resolved one: a default the user has moved away from is
  // shadowed and can never fire, so it must not be counted against whoever now holds its chord.
  const byChord = new Map<string, ResolvedBinding[]>();
  for (const bindings of liveFor.values()) {
    for (const binding of bindings) byChord.set(binding.key, [...(byChord.get(binding.key) ?? []), binding]);
  }

  const customized = new Set(rules.map(ruleCommand));
  const needle = query.trim().toLowerCase();
  const rowsOut: KeybindingRow[] = [];
  for (const entry of catalogue) {
    const binding = effective.get(entry.id);
    const live = liveFor.get(entry.id) ?? [];
    const conflicts: CommandId[] = [];
    for (const held of live) {
      for (const other of byChord.get(held.key) ?? []) {
        if (other.command === entry.id || conflicts.includes(other.command)) continue;
        if (collides(other, held)) conflicts.push(other.command);
      }
    }
    const row: KeybindingRow = {
      command: entry.id,
      title: entry.title,
      category: entry.category,
      key: binding?.key ?? null,
      keyLabel: binding ? formatChord(binding.chord) : null,
      chords: chordsFor.get(entry.id) ?? [],
      when: binding?.when ?? null,
      source: binding ? binding.source : "none",
      conflicts,
      customized: customized.has(entry.id),
      registered: entry.registered,
    };
    if (needle) {
      const haystack = [row.title, row.command, ...row.chords.flatMap((chord) => [chord.label, chord.key])]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    rowsOut.push(row);
  }
  return rowsOut;
}
