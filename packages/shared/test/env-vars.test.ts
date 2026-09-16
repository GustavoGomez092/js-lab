import { describe, expect, test } from "bun:test";
import { envFileSchema, validateEnvRows } from "../src/env-vars";

describe("environment variables (spec §12.1)", () => {
  test("rows validate keys and uniqueness, case-sensitively, and trim keys", () => {
    expect(
      validateEnvRows([
        { key: " API_URL ", value: "https://x" },
        { key: "api_url", value: "y" },
      ]),
    ).toEqual({
      ok: true,
      variables: { API_URL: "https://x", api_url: "y" },
    });
    expect(
      validateEnvRows([
        { key: "1A", value: "" },
        { key: "A-B", value: "" },
        { key: "OK", value: "1" },
        { key: "OK", value: "2" },
      ]),
    ).toEqual({
      ok: false,
      errors: [
        { index: 0, error: "invalidKey" },
        { index: 1, error: "invalidKey" },
        { index: 3, error: "duplicateKey" },
      ],
    });
  });

  test("env.json has a version and string values under valid keys", () => {
    expect(envFileSchema.parse({ version: 1, variables: { TOKEN: "s3cr3t" } }).variables).toEqual({ TOKEN: "s3cr3t" });
    expect(envFileSchema.safeParse({ version: 1, variables: { "1BAD": "x" } }).success).toBe(false);
    expect(envFileSchema.safeParse({ version: 1, variables: { A: 1 } }).success).toBe(false);
    expect(envFileSchema.safeParse({ variables: {} }).success).toBe(false);
  });
});
