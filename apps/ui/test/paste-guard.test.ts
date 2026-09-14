import { describe, expect, mock, test } from "bun:test";
import { installPasteGuard, LARGE_PASTE_BYTES, pasteInto } from "../src/editor/paste-guard";

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
    const insert = mock((_text: string, _captured: string) => {});
    const stop = installPasteGuard(target, confirm, () => "model-at-paste", insert);
    expect(paste(target, "small").defaultPrevented).toBe(false);
    const big = "x".repeat(LARGE_PASTE_BYTES + 1);
    expect(paste(target, big).defaultPrevented).toBe(true);
    await Bun.sleep(1);
    expect(insert).not.toHaveBeenCalled();
    allow = true;
    paste(target, big);
    await Bun.sleep(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]?.[1]).toBe("model-at-paste");
    expect(confirm.mock.calls[0]?.[0]).toBe(LARGE_PASTE_BYTES + 1);
    stop();
    expect(paste(target, big).defaultPrevented).toBe(false);
  });

  // T18-m-paste: a menu click can switch tabs while the confirm is open. The text goes only into the model that was
  // attached at paste time, into every selection, as one undo step.
  test("a large paste captures the model at paste time and fills every selection between undo stops (T18-m-paste)", async () => {
    const calls: string[] = [];
    const modelA = { id: "a" };
    const modelB = { id: "b" };
    let attached: { id: string } = modelA;
    const selections = [{ line: 1 }, { line: 3 }];
    const editor = {
      getModel: () => attached,
      getSelections: () => selections,
      pushUndoStop: () => void calls.push("stop"),
      executeEdits: (source: string, edits: { range: { line: number }; text: string }[]) =>
        void calls.push(`${source}:${edits.map((edit) => `${edit.range.line}=${edit.text}`).join(",")}`),
    };
    const target = document.createElement("div");
    let answer: (ok: boolean) => void = () => {};
    installPasteGuard(
      target,
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
      () => editor.getModel(),
      (text, model) => pasteInto(editor, model, text),
    );
    const big = "y".repeat(LARGE_PASTE_BYTES + 1);

    paste(target, big);
    attached = modelB;
    answer(true);
    await Bun.sleep(1);
    expect(calls).toEqual([]);

    attached = modelA;
    paste(target, big);
    answer(true);
    await Bun.sleep(1);
    expect(calls).toEqual(["stop", `paste:1=${big},3=${big}`, "stop"]);
  });
});
