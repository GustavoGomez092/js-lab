const HAS_MAGIC = /(^|\s)\/\/\?(\s.*)?$/;
const TRAILING_MAGIC = /\s*\/\/\?(\s.*)?$/;

/** Toggle Magic Comment (spec §6.5, EX-13): works on whole lines, ignoring blank ones. */
export function toggleMagicCommentLines(lines: string[]): string[] {
  const content = lines.filter((line) => line.trim() !== "");
  const allMarked = content.length > 0 && content.every((line) => HAS_MAGIC.test(line));
  return lines.map((line) => {
    if (line.trim() === "") return line;
    if (allMarked) return line.replace(TRAILING_MAGIC, "");
    return HAS_MAGIC.test(line) ? line : `${line} //?`;
  });
}

export function sortLinesCaseInsensitive(lines: string[], reverse: boolean): string[] {
  const sorted = [...lines].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return reverse ? sorted.reverse() : sorted;
}
