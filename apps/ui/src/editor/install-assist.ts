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

export function installActionsFor(
  markers: readonly { code: number | string; message: string }[],
  untyped: ReadonlyMap<string, string | null>,
): InstallAction[] {
  const actions = new Map<string, InstallAction>();
  for (const marker of markers) {
    if (Number(marker.code) !== MISSING_MODULE_CODE) continue;
    const specifier = missingModuleFromMessage(marker.message);
    const name = specifier ? packageNameFromSpecifier(specifier) : null;
    if (!name) continue;
    if (untyped.has(name)) {
      const types = untyped.get(name) ?? typesPackageName(name);
      if (types) actions.set(types, { title: strings.install.types(types), spec: types });
    } else {
      actions.set(name, { title: strings.install.package(name), spec: name });
    }
  }
  return [...actions.values()];
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
    provideCodeActions: (_model, _range, context) => ({
      actions: installActionsFor(
        context.markers.map((marker) => ({
          code: typeof marker.code === "object" ? marker.code.value : (marker.code ?? ""),
          message: marker.message,
        })),
        deps.untyped(),
      ).map((action) => ({
        title: action.title,
        kind: "quickfix",
        isPreferred: true,
        diagnostics: [...context.markers],
        command: { id: INSTALL_COMMAND, title: action.title, arguments: [action.spec] },
      })),
      dispose: () => {},
    }),
  });
  return {
    dispose: () => {
      command.dispose();
      provider.dispose();
    },
  };
}
