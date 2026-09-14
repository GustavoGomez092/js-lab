import type { DisplayEvent, OutputEntry } from "../state/output";
import type { OutputFilter } from "../state/store";

export const OUTPUT_FILTERS: readonly OutputFilter[] = ["all", "results", "logs", "errors"];

export type EntryLevel = "result" | "log" | "info" | "warn" | "error";

export function entryLevel(event: DisplayEvent): EntryLevel {
  switch (event.kind) {
    case "result":
      return "result";
    case "error":
    case "stderr":
      return "error";
    case "stdout":
      return "log";
    case "console":
      if (event.level === "error" || event.level === "assert") return "error";
      if (event.level === "warn") return "warn";
      if (event.level === "info") return "info";
      return "log";
  }
}

export function matchesFilter(event: DisplayEvent, filter: OutputFilter): boolean {
  const level = entryLevel(event);
  switch (filter) {
    case "all":
      return true;
    case "results":
      return level === "result";
    case "errors":
      return level === "error";
    case "logs":
      return level === "log" || level === "info" || level === "warn";
  }
}

export function filterCounts(entries: readonly OutputEntry[]): Record<OutputFilter, number> {
  const counts: Record<OutputFilter, number> = { all: entries.length, results: 0, logs: 0, errors: 0 };
  for (const { event } of entries) {
    if (matchesFilter(event, "results")) counts.results++;
    else if (matchesFilter(event, "errors")) counts.errors++;
    else counts.logs++;
  }
  return counts;
}

export function applyFilter(entries: OutputEntry[], filter: OutputFilter): OutputEntry[] {
  return filter === "all" ? entries : entries.filter((entry) => matchesFilter(entry.event, filter));
}
