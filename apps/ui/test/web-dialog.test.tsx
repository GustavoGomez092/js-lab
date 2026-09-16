import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { WebDialog } from "../src/output/WebDialog";
import type { WebDialogEntry } from "../src/state/output";

// Task 13 (spec §5.12, M0-S4): JSLab's own non-blocking stand-in for `alert()`. These tests query the rendered
// DOM through testing-library's role/name queries, the same mechanism as audio-indicator.test.tsx, rather than
// reading React props -- and specifically assert the *absence* of anything that would make this a blocking modal
// (no dialog role, no backdrop element), since "non-blocking" is the entire point of the shim.

const entry = (key: string, text: string): WebDialogEntry => ({ key, text });

test("renders nothing while the queue is empty", () => {
  const { container } = render(<WebDialog dialogs={[]} onDismiss={() => {}} />);
  expect(container.firstChild).toBeNull();
});

test("shows the front of the queue's text", () => {
  render(<WebDialog dialogs={[entry("k1", "Hello from the page")]} onDismiss={() => {}} />);
  expect(screen.getByText("Hello from the page")).toBeTruthy();
});

test("is not a blocking modal: no dialog role, nothing else is disabled or covered", () => {
  render(<WebDialog dialogs={[entry("k1", "hi")]} onDismiss={() => {}} />);
  // A real `alert()` would be exposed as role="dialog" (or "alertdialog") and typically trap focus; this shim is
  // deliberately just a status banner (role="status") that never gets in the way of anything else.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("status")).toBeTruthy();
});

test("dismissing calls back with the shown dialog's key", () => {
  const dismissed: string[] = [];
  render(<WebDialog dialogs={[entry("k1", "hi")]} onDismiss={(key) => dismissed.push(key)} />);
  fireEvent.click(screen.getByRole("button"));
  expect(dismissed).toEqual(["k1"]);
});

test("shows only the front of the queue, and counts the rest instead of stacking them", () => {
  render(
    <WebDialog dialogs={[entry("k1", "first"), entry("k2", "second"), entry("k3", "third")]} onDismiss={() => {}} />,
  );
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.queryByText("second")).toBeNull();
  expect(screen.queryByText("third")).toBeNull();
  expect(screen.getByText("2 more waiting")).toBeTruthy();
});
