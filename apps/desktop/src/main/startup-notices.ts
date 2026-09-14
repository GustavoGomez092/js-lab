import { readdirSync } from "node:fs";
import type { StartupNotice } from "@jslab/rpc-schema";
import type { Recovery } from "./persistence/json-store";
import { strings } from "./strings";

export interface StartupNoticeInput {
  settings: { recovered: Recovery; newerVersion: number | null };
  session: { recovered: Recovery; newerVersion: number | null; droppedTabs: readonly string[] };
  /** The newest `<name>.corrupt-<timestamp>.json` snapshot that loadJson saved for each file, or null. */
  corruptCopies: { settings: string | null; session: string | null };
}

/** The newest corrupt-file snapshot `loadJson` saved for `settings.json` or `session.json`, or null. */
export function latestCorruptCopy(dataDir: string, name: "settings" | "session"): string | null {
  const pattern = new RegExp(`^${name}\\.corrupt-(\\d+)\\.json$`);
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return null;
  }
  let best: { file: string; at: number } | null = null;
  for (const file of entries) {
    const match = pattern.exec(file);
    if (!match) continue;
    const at = Number(match[1]);
    if (!best || at > best.at) best = { file, at };
  }
  return best?.file ?? null;
}

/** What Main tells the user at startup (spec §20; final review M7 and I4). */
export function startupNotices(input: StartupNoticeInput): StartupNotice[] {
  const notices: StartupNotice[] = [];
  const copy = (file: string | null) => (file ? strings.notices.copySaved(file) : "");
  if (input.settings.recovered !== "none") {
    const base =
      input.settings.recovered === "backup" ? strings.notices.settingsRestored : strings.notices.settingsReset;
    notices.push({ id: "settingsRecovered", message: `${base}${copy(input.corruptCopies.settings)}` });
  }
  if (input.session.recovered !== "none") {
    const base = input.session.recovered === "backup" ? strings.notices.sessionRestored : strings.notices.sessionReset;
    notices.push({ id: "sessionRecovered", message: `${base}${copy(input.corruptCopies.session)}` });
  }
  if (input.settings.newerVersion !== null) {
    notices.push({ id: "settingsNewer", message: strings.notices.settingsNewer(input.settings.newerVersion) });
  }
  if (input.session.newerVersion !== null) {
    notices.push({ id: "sessionNewer", message: strings.notices.sessionNewer(input.session.newerVersion) });
  }
  if (input.session.droppedTabs.length > 0) {
    notices.push({ id: "tabsDropped", message: strings.notices.tabsDropped(input.session.droppedTabs.length) });
  }
  return notices;
}
