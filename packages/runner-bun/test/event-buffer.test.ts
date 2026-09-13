import { expect, test } from "bun:test";
import type { RawRunEvent } from "@jslab/rpc-schema";
import { EventBuffer, type TimerFns } from "../src/event-buffer";

function manualTimers() {
  let pending: (() => void) | null = null;
  const timers: TimerFns = {
    setTimeout: ((fn: () => void) => {
      pending = fn;
      return 1;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {
      pending = null;
    }) as unknown as typeof clearTimeout,
  };
  return {
    timers,
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
    isScheduled: () => pending !== null,
  };
}

function setup(maxEntries: number) {
  const sent: RawRunEvent[][] = [];
  const clock = manualTimers();
  const buffer = new EventBuffer((events) => sent.push(events), maxEntries, clock.timers);
  return { sent, clock, buffer };
}

test("batches events until the timer fires", () => {
  const { sent, clock, buffer } = setup(10);
  buffer.push({ kind: "stdout", text: "a" });
  buffer.push({ kind: "stdout", text: "b" });
  expect(sent).toEqual([]);
  expect(clock.isScheduled()).toBe(true);
  clock.fire();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.map((e) => e.seq)).toEqual([1, 2]);
});

test("drops events beyond the cap and reports one running total", () => {
  const { sent, clock, buffer } = setup(2);
  const seqs = [1, 2, 3, 4, 5].map((n) => buffer.push({ kind: "stdout", text: String(n) }));
  expect(seqs).toEqual([1, 2, null, null, null]);
  clock.fire();
  expect(sent[0]?.map((e) => e.kind)).toEqual(["stdout", "stdout", "truncated"]);
  expect(sent[0]?.at(-1)).toMatchObject({ kind: "truncated", dropped: 3 });
  buffer.push({ kind: "stdout", text: "6" });
  buffer.flush();
  expect(sent[1]).toEqual([expect.objectContaining({ kind: "truncated", dropped: 4 })]);
});

test("promise settlements bypass the cap", () => {
  const { sent, buffer } = setup(1);
  buffer.push({ kind: "stdout", text: "a" });
  expect(buffer.push({ kind: "promiseSettled", ref: 1, value: { t: "null" } })).toBe(2);
  buffer.flush();
  expect(sent[0]?.map((e) => e.kind)).toEqual(["stdout", "promiseSettled"]);
});

test("flush sends immediately and cancels the pending timer", () => {
  const { sent, clock, buffer } = setup(10);
  buffer.push({ kind: "stdout", text: "a" });
  buffer.flush();
  expect(sent).toHaveLength(1);
  expect(clock.isScheduled()).toBe(false);
});

test("never sends empty batches", () => {
  const { sent, buffer } = setup(10);
  buffer.flush();
  expect(sent).toEqual([]);
});
