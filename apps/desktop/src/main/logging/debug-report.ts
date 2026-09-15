import type { Settings } from "@jslab/shared";
import type { Redactor } from "./redact";

export interface DebugReportInput {
  versions: { app: string; bun: string; electrobun: string };
  os: { macOS: string; arch: string };
  settings: Settings;
  logLines: string[];
  redact: Redactor;
}

/**
 * Help → Copy Debug Log (spec §20). Redaction runs on each free-text field (the log tail) BEFORE JSON.stringify,
 * not on the finished JSON text: a pattern that eats trailing characters (I-1) could otherwise consume the quote,
 * comma or brace that JSON.stringify placed around it and corrupt the report.
 */
export function buildDebugReport(input: DebugReportInput): string {
  return JSON.stringify(
    {
      version: input.versions.app,
      bunVersion: input.versions.bun,
      electrobunVersion: input.versions.electrobun,
      macOS: input.os.macOS,
      arch: input.os.arch,
      settings: input.settings,
      log: input.logLines.slice(-500).map((line) => input.redact(line)),
    },
    null,
    2,
  );
}
