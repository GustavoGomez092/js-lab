import { describe, expect, test } from "bun:test";
import { waitFor } from "../src/wait";

describe("waitFor", () => {
  test("polls until the probe returns a value (0 counts as a value)", async () => {
    let calls = 0;
    expect(await waitFor(() => (++calls >= 3 ? 0 : undefined), { intervalMs: 1 })).toBe(0);
    expect(calls).toBe(3);
  });

  test("times out with the message and the last probe error", async () => {
    await expect(
      waitFor(
        () => {
          throw new Error("not yet");
        },
        { timeoutMs: 20, intervalMs: 5, message: "Socket never appeared" },
      ),
    ).rejects.toThrow("Socket never appeared within 20 ms (last error: Error: not yet)");
  });
});
