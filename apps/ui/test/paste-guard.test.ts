import { describe, expect, mock, test } from "bun:test";
import { installPasteGuard, LARGE_PASTE_BYTES } from "../src/editor/paste-guard";

function paste(target: HTMLElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  target.dispatchEvent(event);
  return event;
}

describe("paste guard", () => {
  test("small pastes pass through; large pastes wait for confirmation", async () => {
    const target = document.createElement("div");
    let allow = false;
    const confirm = mock(async (_bytes: number) => allow);
    const insert = mock((_text: string) => {});
    const stop = installPasteGuard(target, confirm, insert);
    expect(paste(target, "small").defaultPrevented).toBe(false);
    const big = "x".repeat(LARGE_PASTE_BYTES + 1);
    expect(paste(target, big).defaultPrevented).toBe(true);
    await Bun.sleep(1);
    expect(insert).not.toHaveBeenCalled();
    allow = true;
    paste(target, big);
    await Bun.sleep(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toBe(LARGE_PASTE_BYTES + 1);
    stop();
    expect(paste(target, big).defaultPrevented).toBe(false);
  });
});
