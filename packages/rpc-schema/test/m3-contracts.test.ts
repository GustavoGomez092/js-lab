import { describe, expect, test } from "bun:test";
import {
  envSaveParamsSchema,
  localTypesParamsSchema,
  MAX_NPMRC_CHARS,
  npmInstallParamsSchema,
  npmNameSchema,
  npmrcSaveParamsSchema,
  packageTypesParamsSchema,
} from "../src/ui-rpc";

const ok = (schema: { safeParse(input: unknown): { success: boolean } }, input: unknown) =>
  schema.safeParse(input).success;

describe("M3 contracts", () => {
  test("npm names and install specs accept registry, git and tarball specs and refuse flags and whitespace", () => {
    for (const spec of [
      "zod",
      "zod@^4",
      "@scope/pkg@latest",
      "git+ssh://git@github.com/a/b.git",
      "https://x.test/y.tgz",
    ]) {
      expect(ok(npmInstallParamsSchema, { spec })).toBe(true);
    }
    for (const spec of [
      "--registry=http://evil",
      "-g",
      "a b",
      "",
      "zod\n--x",
      "/etc/passwd",
      "file:///etc/passwd",
      "file:../local",
      "./x",
      "../x",
      "git+file:///x",
      "javascript:alert(1)",
      "zod$(id)",
      "Zod",
    ]) {
      expect(ok(npmInstallParamsSchema, { spec })).toBe(false);
    }
    expect(["zod", "@types/node", "lodash.merge"].map((name) => ok(npmNameSchema, name))).toEqual([true, true, true]);
    expect(["Zod", "../x", "@/x", "a".repeat(215)].map((name) => ok(npmNameSchema, name))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("env saves carry valid keys and string values only", () => {
    expect(ok(envSaveParamsSchema, { variables: { API_URL: "https://x" } })).toBe(true);
    expect(ok(envSaveParamsSchema, { variables: { "1A": "x" } })).toBe(false);
    expect(ok(envSaveParamsSchema, { variables: { A: 1 } })).toBe(false);
  });

  test("type requests name at most 50 packages, and local requests carry only relative specifiers", () => {
    expect(ok(packageTypesParamsSchema, { tabId: "t1", packages: ["zod"] })).toBe(true);
    expect(ok(packageTypesParamsSchema, { tabId: "t1", packages: Array.from({ length: 51 }, (_, i) => `p${i}`) })).toBe(
      false,
    );
    expect(ok(localTypesParamsSchema, { tabId: "t1", specifiers: ["./util", "../lib/x.js"] })).toBe(true);
    expect(ok(localTypesParamsSchema, { tabId: "t1", specifiers: ["zod"] })).toBe(false);
    expect(ok(localTypesParamsSchema, { tabId: "t1", specifiers: ["/etc/passwd"] })).toBe(false);
    expect(ok(localTypesParamsSchema, { tabId: "../x", specifiers: ["./a"] })).toBe(false);
    expect(ok(localTypesParamsSchema, { tabId: "t1", specifiers: ["./a b"] })).toBe(false);
    expect(ok(localTypesParamsSchema, { tabId: "t1", specifiers: ["./a\\b"] })).toBe(false);
  });

  test(".npmrc content is capped", () => {
    expect(ok(npmrcSaveParamsSchema, { content: "registry=http://127.0.0.1:4873/\n" })).toBe(true);
    expect(ok(npmrcSaveParamsSchema, { content: "x".repeat(MAX_NPMRC_CHARS + 1) })).toBe(false);
  });
});
