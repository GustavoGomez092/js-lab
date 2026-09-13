import { describe, expect, test } from "bun:test";
import { stripBaseUrl } from "../scripts/devkit-tsconfig";

describe("stripBaseUrl", () => {
  test("removes baseUrl and keeps paths", () => {
    const input = {
      compilerOptions: {
        baseUrl: ".",
        paths: { electrobun: ["./api/sdks/main/index.ts"] },
      },
    };

    const result = stripBaseUrl(input);

    expect(result.compilerOptions).not.toHaveProperty("baseUrl");
    expect(result.compilerOptions?.paths).toEqual({ electrobun: ["./api/sdks/main/index.ts"] });

    // idempotent: input without baseUrl comes back deep-equal
    const withoutBaseUrl = {
      compilerOptions: { paths: { electrobun: ["./api/sdks/main/index.ts"] } },
    };
    expect(stripBaseUrl(withoutBaseUrl)).toEqual(withoutBaseUrl);

    // does not mutate its input
    expect(input.compilerOptions).toHaveProperty("baseUrl", ".");
  });
});
