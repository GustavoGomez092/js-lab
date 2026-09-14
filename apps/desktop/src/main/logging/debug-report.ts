import type { Settings } from "@jslab/shared";
import type { Redactor } from "./redact";

export interface DebugReportInput {
  versions: { app: string; bun: string; electrobun: string };
  os: { macOS: string; arch: string };
  settings: Settings;
  logLines: string[];
  redact: Redactor;
}

/** Help → Copy Debug Log (spec §20). The whole report is redacted after serialization. */
export function buildDebugReport(input: DebugReportInput): string {
  return input.redact(
    JSON.stringify(
      {
        version: input.versions.app,
        bunVersion: input.versions.bun,
        electrobunVersion: input.versions.electrobun,
        macOS: input.os.macOS,
        arch: input.os.arch,
        settings: input.settings,
        log: input.logLines.slice(-500),
      },
      null,
      2,
    ),
  );
}
