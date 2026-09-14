import { describe, expect, test } from "bun:test";
import { createMessageHub } from "../src/message-hub";
import { createViewMessageRouter, VIEW_MESSAGES } from "../src/view-messages";

describe("main window message router (T24-hub-main)", () => {
  test("messages Main sends before App subscribes are delivered once, including app.notice", () => {
    const router = createViewMessageRouter();
    expect(Object.keys(router.handlers).sort()).toEqual([...VIEW_MESSAGES].sort());

    router.handlers["menu.command"]?.({ command: "run.start" });
    router.handlers["app.notice"]?.({ id: "unexpectedError", message: "Something went wrong." });

    const commands: unknown[] = [];
    router.on("menu.command", (payload) => commands.push(payload));
    const notices: unknown[] = [];
    router.on("app.notice", (payload) => notices.push(payload));
    expect([commands, notices]).toEqual([
      [{ command: "run.start" }],
      [{ id: "unexpectedError", message: "Something went wrong." }],
    ]);

    const late: unknown[] = [];
    router.on("menu.command", (payload) => late.push(payload));
    router.handlers["menu.command"]?.({ command: "run.stop" });
    expect([commands.length, late]).toEqual([2, [{ command: "run.stop" }]]);
  });
});

type Messages = { tick: { n: number }; other: { s: string } };

describe("message hub", () => {
  test("queues messages until the first listener (capped at 32), never redelivers, and queues again after the last unsubscribe", () => {
    const hub = createMessageHub<Messages>();
    const tick = hub.dispatch("tick");
    hub.dispatch("other")({ s: "kept for its own listener" });
    for (let n = 1; n <= 40; n += 1) tick({ n });

    // The first listener gets the queued payloads synchronously, in arrival order; the 8 oldest were dropped.
    const first: number[] = [];
    const offFirst = hub.on("tick", ({ n }) => first.push(n));
    expect(first).toEqual(Array.from({ length: 32 }, (_, index) => index + 9));

    // A second listener sees nothing already delivered; live messages reach both.
    const second: number[] = [];
    const offSecond = hub.on("tick", ({ n }) => second.push(n));
    expect(second).toEqual([]);
    tick({ n: 41 });
    expect(first.slice(-1)).toEqual([41]);
    expect(second).toEqual([41]);

    // With no listeners left, messages queue again and go to the next first listener only once.
    offFirst();
    offSecond();
    tick({ n: 42 });
    expect(first.slice(-1)).toEqual([41]);
    const third: number[] = [];
    const offThird = hub.on("tick", ({ n }) => third.push(n));
    expect(third).toEqual([42]);
    offThird();
    const fourth: number[] = [];
    hub.on("tick", ({ n }) => fourth.push(n));
    expect(fourth).toEqual([]);

    // Queues are per message name.
    const others: string[] = [];
    hub.on("other", ({ s }) => others.push(s));
    expect(others).toEqual(["kept for its own listener"]);
  });
});
