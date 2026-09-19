import { Fragment } from "react";
import { strings } from "../strings";
import { linkify } from "./links";

interface LinkedTextProps {
  text: string;
  /**
   * Opens a URL in the user's browser. Absent means "render this text as text": every caller that cannot reach
   * Main leaves it off, and the output then reads exactly as it did before OU-13 rather than growing controls
   * that would do nothing when pressed.
   */
  onOpenLink?(url: string): void;
}

/**
 * OU-13. Output text with its http(s) URLs made openable.
 *
 * When there is nothing to link -- which is almost every row -- this renders the original string and no wrapper
 * at all, so the common path adds not one DOM node and the text still reads as one selectable run.
 */
export function LinkedText({ text, onOpenLink }: LinkedTextProps) {
  const segments = linkify(text);
  if (!onOpenLink || segments.every((segment) => segment.href === null)) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.href === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs of one string have no identity beyond their order
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the same URL can legitimately appear twice in a row
          <OutputLink key={index} href={segment.href} onOpen={onOpenLink} />
        ),
      )}
    </>
  );
}

/**
 * One openable URL.
 *
 * A real `<button>`, which is what makes this reachable at all: it is an ordinary Tab stop and opens on Enter or
 * Space, so a keyboard user is never left with a control only a modified click can reach. The row already
 * carries per-row buttons for the line badge, each stack frame and the OU-10 entry menu, so a focusable control
 * inside a row is the established shape here rather than a new one.
 *
 * Its text content is the URL itself, so the accessible name a screen reader announces is the destination.
 */
function OutputLink({ href, onOpen }: { href: string; onOpen(url: string): void }) {
  return (
    <button
      type="button"
      className="entry-link"
      data-testid="output-link"
      title={strings.output.openLink}
      onClick={(event) => {
        // Cmd on macOS, Ctrl elsewhere. A plain click stays a plain click on purpose: output text is selected
        // and dragged with the mouse, and swallowing that gesture would make the panel hostile to read.
        if (event.metaKey || event.ctrlKey) onOpen(href);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Keyboard activation needs no modifier: a focused button has none of the text-selection ambiguity that
        // makes Cmd-click the right pointer gesture. preventDefault stops the browser's own Enter/Space → click
        // synthesis, so one press opens exactly once instead of twice.
        event.preventDefault();
        onOpen(href);
      }}
    >
      {href}
    </button>
  );
}
