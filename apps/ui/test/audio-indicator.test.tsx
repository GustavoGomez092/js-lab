import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { AudioIndicator } from "../src/tabs/AudioIndicator";

// Task 15 (spec §5.12, parity EX-35): "while an AudioContext is running or a media element is playing, the tab
// shows a speaker icon; clicking it toggles mute." These tests query the rendered DOM through testing-library's
// role/name/pressed-state queries -- the same mechanism a screen reader uses -- rather than reading React props or
// raw attribute strings, so a control whose *state* never actually reaches the accessibility tree (the failure
// mode the task brief calls out from an earlier M4 task) would fail here, not just look right.

test("renders nothing while the tab has no audio activity", () => {
  const { container } = render(<AudioIndicator active={false} muted={false} title="script.ts" onToggle={() => {}} />);
  expect(container.firstChild).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

test("shows a pressable, honestly-labelled control while active, announcing it is playing (not muted)", () => {
  render(<AudioIndicator active={true} muted={false} title="script.ts" onToggle={() => {}} />);
  // getByRole with `pressed` computes the accessible pressed state from the real DOM node (aria-pressed), and
  // `name` computes the accessible name from what a screen reader would read (aria-label) -- both fail if the
  // state was only ever set on a React prop and never actually reached the element.
  const button = screen.getByRole("button", { pressed: false, name: /mute script\.ts/i });
  expect(button.tagName).toBe("BUTTON");
});

test("while muted, the control's pressed state and accessible name both flip to say so", () => {
  render(<AudioIndicator active={true} muted={true} title="noisy.ts" onToggle={() => {}} />);
  const button = screen.getByRole("button", { pressed: true, name: /unmute noisy\.ts/i });
  expect(button).toBeDefined();
});

test("clicking toggles mute without also activating whatever is behind it (event.stopPropagation)", () => {
  function Harness() {
    const [muted, setMuted] = useState(false);
    const [rowClicks, setRowClicks] = useState(0);
    return (
      // Stands in for TabBar's own tab row (which already handles Enter/Space itself) -- irrelevant to what this
      // test is proving, so both a11y rules are suppressed rather than reimplementing that handling here too.
      // biome-ignore lint/a11y/useKeyWithClickEvents: see above
      // biome-ignore lint/a11y/noStaticElementInteractions: see above
      <div onClick={() => setRowClicks((c) => c + 1)}>
        <span data-testid="row-clicks">{rowClicks}</span>
        <AudioIndicator active={true} muted={muted} title="script.ts" onToggle={() => setMuted((m) => !m)} />
      </div>
    );
  }
  render(<Harness />);
  const button = screen.getByRole("button", { pressed: false });
  fireEvent.click(button);
  // The toggle took effect (aria-pressed flipped)...
  screen.getByRole("button", { pressed: true, name: /unmute script\.ts/i });
  // ...but the click never bubbled up to activate the row underneath it.
  expect(screen.getByTestId("row-clicks").textContent).toBe("0");
});

test("is a real button: focusable by keyboard, not merely drawn to look like a control", () => {
  render(<AudioIndicator active={true} muted={false} title="script.ts" onToggle={() => {}} />);
  const button = screen.getByRole("button", { pressed: false });
  // A native <button> is keyboard-reachable and Enter/Space-activatable by construction; there is no tabIndex
  // override here to break that, and it can genuinely receive focus (not, for example, disabled or hidden).
  button.focus();
  expect(document.activeElement).toBe(button);
});
