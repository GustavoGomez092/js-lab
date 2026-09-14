import { describe, expect, test } from "bun:test";
import { OperationQueue, OperationTimeoutError } from "../src/queue";

describe("OperationQueue (spec §11.3)", () => {
  test("runs tasks one at a time in order", async () => {
    const queue = new OperationQueue();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await Bun.sleep(ms);
      events.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([queue.run(task("a", 30)), queue.run(task("b", 1))]);
    expect(results).toEqual(["a", "b"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
    expect(queue.pending).toBe(0);
  });

  test("a task that exceeds the timeout is aborted and rejected, and the next task runs", async () => {
    // graceMs is short because this task's promise never settles on its own (fix round 1, I-1): only the abort
    // handler runs, so the queue's kill-grace wait always exhausts its budget before moving on.
    const queue = new OperationQueue({ timeoutMs: 20, graceMs: 20 });
    let aborted = false;
    const slow = queue.run(
      (signal) =>
        new Promise<string>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const next = queue.run(async () => "next");
    await expect(slow).rejects.toBeInstanceOf(OperationTimeoutError);
    expect(aborted).toBe(true);
    expect(await next).toBe("next");
  });

  test("a failing task doesn't block later tasks", async () => {
    const queue = new OperationQueue();
    const failing = queue.run(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect(await queue.run(async () => 42)).toBe(42);
  });

  test("a timed-out task's settlement is awaited, bounded by the kill grace, before the next task starts", async () => {
    const queue = new OperationQueue({ timeoutMs: 10, graceMs: 200 });
    const events: string[] = [];
    const first = queue.run(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            events.push("aborted");
            setTimeout(() => {
              events.push("settled");
              resolve("first-result");
            }, 5);
          });
        }),
    );
    const next = queue.run(async () => {
      events.push("next started");
      return "next";
    });
    await expect(first).rejects.toBeInstanceOf(OperationTimeoutError);
    expect(events).toEqual(["aborted", "settled", "next started"]);
    expect(await next).toBe("next");
  });
});
