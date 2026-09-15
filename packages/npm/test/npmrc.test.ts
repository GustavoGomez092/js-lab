import { describe, expect, test } from "bun:test";
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

  test("redactRegistryUrl removes userinfo and leaves other URLs unchanged", () => {
    expect(redactRegistryUrl("https://user:pass@npm.corp.example/")).toBe("https://npm.corp.example/");
    expect(redactRegistryUrl("http://127.0.0.1:4873/")).toBe("http://127.0.0.1:4873/");
    expect(redactRegistryUrl("not a url")).toBe("not a url");
  });
});
