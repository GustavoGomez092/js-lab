import { COMMANDS, commandTitleKey, formatChordParts, type ResolvedBinding, shortcutFor } from "@jslab/shared";
import { listThemes } from "@jslab/themes";
import type { CommandRegistry } from "../commands/registry";
import { t } from "../i18n";
import { strings } from "../strings";
import type { PaletteItem } from "./match";

export function paletteItems(
  registry: CommandRegistry,
  bindings: readonly ResolvedBinding[],
  themeId: string,
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const meta of COMMANDS) {
    if ("palette" in meta && meta.palette === false) continue;
    const spec = registry.get(meta.id);
    if (!spec) continue;
    const chord = shortcutFor(bindings, meta.id);
    items.push({
      id: meta.id,
      title: t(commandTitleKey(meta.id)),
      category: meta.category,
      context: "context" in meta ? meta.context : "any",
      description: spec.description?.() ?? null,
      keys: chord ? formatChordParts(chord) : [],
      enabled: spec.isEnabled?.() ?? true,
    });
  }
  if (registry.has("theme.select")) {
    for (const theme of listThemes()) {
      items.push({
        id: "theme.select",
        args: { themeId: theme.id },
        title: strings.palette.themeItem(theme.name),
        category: "theme",
        context: "any",
        description: theme.id === themeId ? strings.commands.current : null,
        keys: [],
        enabled: true,
      });
    }
  }
  return items;
}
