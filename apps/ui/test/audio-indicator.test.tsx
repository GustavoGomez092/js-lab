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

/**
 * CodeRabbit finding 6. `TabBar.tsx` makes each tab row activatable from the keyboard with its own
 * `onKeyDown` handler (`if (event.key === "Enter" || event.key === " ") tabs.activate(id)`). This control sits
 * *inside* that row, so a keyboard user pressing Enter or Space on the speaker icon had the event bubble up and
 * activate the tab as well -- unmuting a background tab silently switched to it. `onClick` propagation was
 * already stopped; keydown was not.
 *
 * `fireEvent.keyDown` does not synthesize the click a real browser generates for Enter/Space on a `<button>`, so
 * what is asserted here is exactly the bug: whether the row underneath saw the keystroke.
 */
test("Enter and Space don't leak into the tab row underneath (CodeRabbit 6)", () => {
  function Harness() {
    const [muted, setMuted] = useState(false);
    const [rowActivations, setRowActivations] = useState(0);
    return (
      // Mirrors TabBar's own tab row, including the Enter/Space handling that is the whole point of this test.
      // biome-ignore lint/a11y/noStaticElementInteractions: this stands in for TabBar's row, which is a real tab stop
      <div
        onClick={() => setRowActivations((c) => c + 1)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") setRowActivations((c) => c + 1);
        }}
      >
        <span data-testid="row-activations">{rowActivations}</span>
        <AudioIndicator active={true} muted={muted} title="script.ts" onToggle={() => setMuted((m) => !m)} />
      </div>
    );
  }
  render(<Harness />);
  const button = screen.getByRole("button", { pressed: false });

  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.keyDown(button, { key: " " });

  expect(screen.getByTestId("row-activations").textContent).toBe("0");
});

/**
 * CodeRabbit finding 7. `if (!active) return null` unmounted the control whenever audio was not active -- but
 * `TabBar` passes the runner's `audioActive` as `active`, and the media path in `packages/runner-web/src/
 * handles.ts` *pauses* playback when the tab is muted (`if (audio.muted) this.pause()`), which drops the element
 * out of `AudioController.active`. So muting a tab could make it report inactive, unmount the only unmute
 * control, and leave the user no way back. A muted tab must keep its control whatever the activity says.
 */
test("a muted tab keeps its unmute control even once audio goes inactive (CodeRabbit 7)", () => {
  render(<AudioIndicator active={false} muted={true} title="noisy.ts" onToggle={() => {}} />);
  const button = screen.getByRole("button", { pressed: true, name: /unmute noisy\.ts/i });
  expect(button).toBeDefined();
});

test("is a real button: focusable by keyboard, not merely drawn to look like a control", () => {
  render(<AudioIndicator active={true} muted={false} title="script.ts" onToggle={() => {}} />);
  const button = screen.getByRole("button", { pressed: false });
  // A native <button> is keyboard-reachable and Enter/Space-activatable by construction; there is no tabIndex
  // override here to break that, and it can genuinely receive focus (not, for example, disabled or hidden).
  button.focus();
  expect(document.activeElement).toBe(button);
});
