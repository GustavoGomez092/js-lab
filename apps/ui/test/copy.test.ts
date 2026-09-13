import { describe, expect, test } from "bun:test";
import { copyEntriesToClipboard } from "../src/output/copy";

describe("copyEntriesToClipboard", () => {
  test("reports a failed clipboard write instead of throwing", async () => {
    const failing = { writeText: () => Promise.reject(new Error("denied")) };
    await expect(copyEntriesToClipboard("text", failing)).resolves.toBe("failed");

    let received: string | undefined;
    const working = {
      writeText: (text: string) => {
        received = text;
        return Promise.resolve();
      },
    };
    await expect(copyEntriesToClipboard("hello", working)).resolves.toBe("copied");
    expect(received).toBe("hello");
  });
});
