import { describe, expect, mock, test } from "bun:test";
import { createMainWindowController } from "../../src/main/windows/main-window";

class FakeWindow {
  readonly handlers = new Map<string, ((event: unknown) => void)[]>();
  activated = 0;
  closed = 0;
  on(event: string, handler: (event: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string) {
    for (const handler of this.handlers.get(event) ?? []) handler({});
  }
  activate() {
    this.activated++;
  }
  close() {
    this.closed++;
    this.emit("close");
  }
}

describe("main window controller", () => {
  test("open creates one window, activates it on repeat, and reopens after the window closes", () => {
    const windows: FakeWindow[] = [];
    const onClosed = mock(() => {});
    const controller = createMainWindowController({
      create: () => {
        const created = new FakeWindow();
        windows.push(created);
        return created;
      },
      onClosed,
    });
    const first = controller.open();
    expect(controller.open()).toBe(first);
    expect(first.activated).toBe(1);
    first.emit("close");
    expect([controller.isOpen(), controller.window, onClosed.mock.calls.length]).toEqual([false, null, 1]);
    const second = controller.open();
    expect(second).not.toBe(first);
    expect(windows).toHaveLength(2);
  });

  test("close closes the current window, and a stale close event is ignored", () => {
    const onClosed = mock(() => {});
    const controller = createMainWindowController({ create: () => new FakeWindow(), onClosed });
    const first = controller.open();
    controller.close();
    expect(first.closed).toBe(1);
    controller.close();
    const second = controller.open();
    first.emit("close");
    expect([controller.window, onClosed.mock.calls.length]).toEqual([second, 1]);
  });
});
