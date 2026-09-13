/** Wraps the Clipboard API so a denied or failed write reports a status instead of throwing (Copy All). */
export async function copyEntriesToClipboard(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
): Promise<"copied" | "failed"> {
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
