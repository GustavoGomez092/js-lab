import { packageNameFromSpecifier, typesPackageName } from "@jslab/npm/specifiers";
import type * as Monaco from "monaco-editor";
import { strings } from "../strings";

/** TypeScript's "Cannot find module" diagnostic (spec §6.1: shown with the install code action). */
export const MISSING_MODULE_CODE = 2307;

export interface InstallAction {
  title: string;
  spec: string;
}

export function missingModuleFromMessage(message: string): string | null {
  return /Cannot find module ['"]([^'"]+)['"]/.exec(message)?.[1] ?? null;
}

/** The package a Bun module-not-found runtime error names (spec §6.3), or null. */
export function runtimeMissingPackage(message: string): string | null {
  const specifier = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message)?.[1];
  return specifier ? packageNameFromSpecifier(specifier) : null;
}

/**
 * Groups 2307 markers into install actions, keeping each action's own originating marker (Task 23 fix round 2,
 * M-8) — so the provider can attach only that one marker to `diagnostics`, instead of every marker in range.
 * `installActionsFor` is a thin wrapper over this that drops the marker, keeping its own signature and result shape
 * exactly as Task 28 and `e2e.installActions` pin them.
 */
function installActionsWithMarkers<TMarker extends { code: number | string; message: string }>(
  markers: readonly TMarker[],
  untyped: ReadonlyMap<string, string | null>,
): (InstallAction & { marker: TMarker })[] {
  const actions = new Map<string, InstallAction & { marker: TMarker }>();
  for (const marker of markers) {
    if (Number(marker.code) !== MISSING_MODULE_CODE) continue;
    const specifier = missingModuleFromMessage(marker.message);
    const name = specifier ? packageNameFromSpecifier(specifier) : null;
    if (!name) continue;
    if (untyped.has(name)) {
      const types = untyped.get(name) ?? typesPackageName(name);
      if (types) actions.set(types, { title: strings.install.types(types), spec: types, marker });
    } else {
      actions.set(name, { title: strings.install.package(name), spec: name, marker });
    }
  }
  return [...actions.values()];
}

export function installActionsFor(
  markers: readonly { code: number | string; message: string }[],
  untyped: ReadonlyMap<string, string | null>,
): InstallAction[] {
  return installActionsWithMarkers(markers, untyped).map(({ title, spec }) => ({ title, spec }));
}

const INSTALL_COMMAND = "jslab.installPackage";

/** Quick fixes on TS 2307 markers that dispatch npm.install (spec §6.3, §11.4). */
export function registerInstallAssist(
  monaco: typeof Monaco,
  deps: { untyped(): ReadonlyMap<string, string | null>; install(spec: string): void },
): { dispose(): void } {
  const command = monaco.editor.registerCommand(INSTALL_COMMAND, (_accessor, spec: unknown) => {
    if (typeof spec === "string") deps.install(spec);
  });
  const provider = monaco.languages.registerCodeActionProvider(["typescript", "javascript"], {
    provideCodeActions: (_model, _range, context) => {
      const actions = installActionsWithMarkers(
        context.markers.map((marker) => ({
          code: typeof marker.code === "object" ? marker.code.value : (marker.code ?? ""),
          message: marker.message,
          original: marker,
        })),
        deps.untyped(),
      );
      // M-8: preferred only when it's the single fix on offer — never when two unresolved imports (or an
      // unrelated marker on the same line) would otherwise both claim the auto-fix keybinding.
      const isPreferred = actions.length === 1;
      return {
        actions: actions.map((action) => ({
          title: action.title,
          kind: "quickfix",
          isPreferred,
          // Only this action's own originating marker — not every marker Monaco passed in range (M-8).
          diagnostics: [action.marker.original],
          command: { id: INSTALL_COMMAND, title: action.title, arguments: [action.spec] },
        })),
        dispose: () => {},
      };
    },
  });
  return {
    dispose: () => {
      command.dispose();
      provider.dispose();
    },
  };
}
