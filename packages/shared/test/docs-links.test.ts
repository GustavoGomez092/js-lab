import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * A link-integrity check for docs/user (the M6 "user documentation site" milestone): every relative Markdown
 * link under docs/user must resolve to a real file, and every page under docs/user must be reachable by
 * following links starting from docs/user/README.md, the manual's index. Nothing else in the repo enforces
 * either property, so a renamed or deleted page currently rots silently.
 *
 * Lives here rather than under apps/ui or apps/desktop because it checks repo-level documentation, not any one
 * app or package, and `@jslab/shared` has no runtime dependencies of its own to entangle it with.
 */
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const DOCS_USER_DIR = resolve(REPO_ROOT, "docs", "user");
const INDEX_FILE = resolve(DOCS_USER_DIR, "README.md");

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listMarkdownFiles(full));
    } else if (extname(entry) === ".md") {
      out.push(full);
    }
  }
  return out;
}

// Matches Markdown link/image targets: `[text](target)` or `[text](target "title")`. Deliberately simple --
// this repo's docs don't use reference-style links or link targets containing unescaped parentheses.
const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function extractLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(LINK_PATTERN)) {
    const href = match[1];
    if (href) targets.push(href);
  }
  return targets;
}

/** A scheme-prefixed URL (`https://…`, `mailto:…`) or a protocol-relative one (`//…`) — never a local file. */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

function isUnderDocsUser(path: string): boolean {
  return path === DOCS_USER_DIR || path.startsWith(DOCS_USER_DIR + sep);
}

describe("docs/user link integrity", () => {
  const files = listMarkdownFiles(DOCS_USER_DIR);

  test("docs/user has an index and at least one other page", () => {
    // Guards the two tests below against a trivially, vacuously "passing" empty or missing docs/user.
    expect(existsSync(INDEX_FILE)).toBe(true);
    expect(files.length).toBeGreaterThan(1);
  });

  test("every relative link under docs/user resolves to a real file", () => {
    const broken: string[] = [];
    for (const file of files) {
      const markdown = readFileSync(file, "utf8");
      for (const href of extractLinkTargets(markdown)) {
        if (isExternal(href) || href.startsWith("#")) continue;
        const pathPart = href.split("#")[0];
        if (!pathPart) continue; // a bare "#fragment" is a same-page anchor, not a file link
        const target = resolve(dirname(file), pathPart);
        if (!existsSync(target)) broken.push(`${relative(REPO_ROOT, file)} -> ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("every page under docs/user is reachable from the index", () => {
    const visited = new Set<string>();
    const queue = [INDEX_FILE];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current) || !existsSync(current)) continue;
      visited.add(current);
      const markdown = readFileSync(current, "utf8");
      for (const href of extractLinkTargets(markdown)) {
        if (isExternal(href) || href.startsWith("#")) continue;
        const pathPart = href.split("#")[0];
        if (!pathPart || extname(pathPart) !== ".md") continue;
        const target = resolve(dirname(current), pathPart);
        if (isUnderDocsUser(target) && !visited.has(target)) queue.push(target);
      }
    }
    const unreachable = files.filter((file) => !visited.has(file)).map((file) => relative(REPO_ROOT, file));
    expect(unreachable).toEqual([]);
  });
});
