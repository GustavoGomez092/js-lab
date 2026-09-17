import { describe, expect, test } from "bun:test";
import { MAX_NPMRC_CHARS } from "@jslab/rpc-schema";
import { authTokenFor, parseNpmrc, redactRegistryUrl, registryFor } from "../src/npmrc";

describe(".npmrc (spec §11.3, §11.5)", () => {
  test("parses keys and values, strips quotes and comments, and a later key wins", () => {
    const config = parseNpmrc(
      [
        "; comment",
        "# comment",
        'registry = "http://127.0.0.1:4873"',
        "@acme:registry=https://npm.acme.test/",
        "registry=http://127.0.0.1:4874/",
        "  malformed line",
      ].join("\n"),
    );
    // A later key wins and moves to the end (parseNpmrc deletes, then sets).
    expect([...config]).toEqual([
      ["@acme:registry", "https://npm.acme.test/"],
      ["registry", "http://127.0.0.1:4874/"],
    ]);
  });

  test("picks the scoped registry, then the default, with a trailing slash and ${VAR} expansion", () => {
    const config = parseNpmrc("registry=${REG}\n@acme:registry=https://npm.acme.test");
    const env = { REG: "http://127.0.0.1:4873" };
    expect(registryFor(config, "@acme/tool", env)).toBe("https://npm.acme.test/");
    expect(registryFor(config, "zod", env)).toBe("http://127.0.0.1:4873/");
    expect(registryFor(parseNpmrc(""), null, {})).toBe("https://registry.npmjs.org/");
  });

  test("uses the longest matching _authToken for the registry URL", () => {
    const config = parseNpmrc(
      [
        "//npm.acme.test/:_authToken=short",
        "//npm.acme.test/private/:_authToken=${TOKEN}",
        "//other.test/:_authToken=nope",
      ].join("\n"),
    );
    expect(authTokenFor(config, "https://npm.acme.test/private/", { TOKEN: "long" })).toBe("long");
    expect(authTokenFor(config, "https://npm.acme.test/", {})).toBe("short");
    expect(authTokenFor(config, "http://127.0.0.1:4873/", {})).toBeNull();
  });

  test("case-folds the scheme and host, but not the path, when matching _authToken (FR-5)", () => {
    const config = parseNpmrc("//npm.acme.test/:_authToken=s3cr3t");
    expect(authTokenFor(config, "https://NPM.ACME.TEST/", {})).toBe("s3cr3t");
    expect(authTokenFor(config, "HTTPS://npm.acme.test/", {})).toBe("s3cr3t");
    // Longest-prefix-wins still holds once host folding is added.
    const nested = parseNpmrc(
      ["//npm.acme.test/:_authToken=short", "//npm.acme.test/private/:_authToken=long"].join("\n"),
    );
    expect(authTokenFor(nested, "https://NPM.ACME.TEST/private/", {})).toBe("long");
    // The path stays case-sensitive: a differently-cased path segment falls back to the shorter, root match.
    const pathSensitive = parseNpmrc(
      ["//npm.acme.test/:_authToken=roottoken", "//npm.acme.test/Scoped/:_authToken=scopedtoken"].join("\n"),
    );
    expect(authTokenFor(pathSensitive, "https://NPM.ACME.TEST/Scoped/pkg", {})).toBe("scopedtoken");
    expect(authTokenFor(pathSensitive, "https://NPM.ACME.TEST/scoped/pkg", {})).toBe("roottoken");
  });

  test("redactRegistryUrl removes userinfo and leaves other URLs unchanged", () => {
    expect(redactRegistryUrl("https://user:pass@npm.corp.example/")).toBe("https://npm.corp.example/");
    expect(redactRegistryUrl("http://127.0.0.1:4873/")).toBe("http://127.0.0.1:4873/");
    expect(redactRegistryUrl("not a url")).toBe("not a url");
  });

  /**
   * F2. The defensive cap `parseDotenv` already carried and this parser did not. It is a backstop only: Main's
   * one production caller reads the file through `readBoundedText`, which throws before text this large can get
   * here. That ordering is the point -- an empty config is exactly what makes `registryFor` fall back to the
   * public registry, so this cap must never be the only bound on the path.
   */
  test("ignores text larger than MAX_NPMRC_CHARS", () => {
    const oversized = `registry=https://npm.acme.test/\n${"x".repeat(MAX_NPMRC_CHARS)}`;
    expect(oversized.length).toBeGreaterThan(MAX_NPMRC_CHARS);
    expect([...parseNpmrc(oversized)]).toEqual([]);
    // The same content under the cap still parses, so the bound is the cap and not something narrower.
    expect([...parseNpmrc("registry=https://npm.acme.test/")]).toEqual([["registry", "https://npm.acme.test/"]]);
  });
});
