import type { CommandCatalogEntry } from "@jslab/rpc-schema";
import {
  type CommandCategory,
  type CommandId,
  formatChord,
  type KeybindingRule,
  type ResolvedBinding,
  resolveKeybindings,
} from "@jslab/shared";

export interface KeybindingRow {
  command: CommandId;
  title: string;
  category: CommandCategory;
  /** The chord spec ("cmd+r"), or null when the command is unbound. */
  key: string | null;
  /** The keycap text ("⌘R"), or null when unbound. */
  keyLabel: string | null;
  when: string | null;
  source: "default" | "user" | "none";
  /** Other commands whose binding can fire on the same chord in the same context. */
  conflicts: CommandId[];
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
 * The rows Settings → Keybindings renders (spec §6.5: Command, Keybinding, When, Source).
 *
 * One row per catalogue entry, in catalogue order -- the catalogue is `COMMANDS`, so a command added by any other
 * milestone appears here automatically (R-M5D-REGISTRY-1). `resolveKeybindings` does the precedence work, so the
 * table can never disagree with what the dispatcher actually does.
 */
export function keybindingRows(
  catalogue: readonly CommandCatalogEntry[],
  defaults: readonly KeybindingRule[],
  rules: readonly KeybindingRule[],
  query: string,
): KeybindingRow[] {
  const resolved = resolveKeybindings(defaults, rules);
  // The highest-precedence binding per command is the one the user sees, matching `shortcutFor`'s rule. A command
  // with two default chords (Next Tab) therefore shows one of them; the other is real but not listed.
  const effective = new Map<string, ResolvedBinding>();
  for (const binding of resolved) effective.set(binding.command, binding);

  // Only a binding a command actually uses can collide, so this groups the effective bindings, not every resolved
  // one: a default that the user has since moved away from is shadowed and can never fire.
  const byChord = new Map<string, ResolvedBinding[]>();
  for (const binding of effective.values()) {
    byChord.set(binding.key, [...(byChord.get(binding.key) ?? []), binding]);
  }

  const needle = query.trim().toLowerCase();
  const rowsOut: KeybindingRow[] = [];
  for (const entry of catalogue) {
    const binding = effective.get(entry.id);
    const row: KeybindingRow = {
      command: entry.id,
      title: entry.title,
      category: entry.category,
      key: binding?.key ?? null,
      keyLabel: binding ? formatChord(binding.chord) : null,
      when: binding?.when ?? null,
      source: binding ? binding.source : "none",
      conflicts: binding
        ? (byChord.get(binding.key) ?? [])
            .filter((other) => other.command !== entry.id && collides(other, binding))
            .map((other) => other.command)
        : [],
      registered: entry.registered,
    };
    if (needle) {
      const haystack = [row.title, row.command, row.keyLabel ?? "", row.key ?? ""].join(" ").toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    rowsOut.push(row);
  }
  return rowsOut;
}
