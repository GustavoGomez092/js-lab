import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

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

/**
 * Matches HTML image sources: `<img … src="…">`. `LINK_PATTERN` above is blind to these, and the repo README
 * embeds every one of its screenshots that way, so without this a moved or deleted image under `docs/images`
 * rots silently -- on the page that is the project's front door.
 */
const HTML_IMAGE_PATTERN = /<img[^>]+src="([^"]+)"/g;

function extractHtmlImageSources(markdown: string): string[] {
  const sources: string[] = [];
  for (const match of markdown.matchAll(HTML_IMAGE_PATTERN)) {
    const src = match[1];
    if (src) sources.push(src);
  }
  return sources;
}

const README_FILE = resolve(REPO_ROOT, "README.md");

/** The path part of a link, without its `#fragment`; empty for a bare same-page anchor. */
function filePart(href: string): string {
  return href.split("#")[0] ?? "";
}

/**
 * The same integrity guarantee for the repo README, which the suite above does not reach. It is the entry
 * point to the manual, the spec, the parity table and the QA checklists, so a dead link here is the most
 * visible kind there is.
 *
 * Only the README is checked, not every Markdown file in the repo: `docs/superpowers/` holds historical plans
 * and specs that deliberately reference paths as they stood when written, and failing the suite over those
 * would be noise rather than rot. Images are checked HERE and not over `docs/user`, which embeds none at all
 * (0 HTML and 0 Markdown images, measured) -- asserting over an empty set would pass whatever the code did.
 */
describe("README link integrity", () => {
  const markdown = readFileSync(README_FILE, "utf8");
  const relativeLinks = extractLinkTargets(markdown).filter((href) => !isExternal(href) && !href.startsWith("#"));
  const imageSources = extractHtmlImageSources(markdown).filter((src) => !isExternal(src));

  test("the README really does carry relative links and embedded images", () => {
    // Without this, the two tests below would pass just as contentedly against a README that linked to nothing
    // and showed nothing -- which is the shape of a test that can never fail.
    expect(relativeLinks.length).toBeGreaterThan(3);
    expect(imageSources.length).toBeGreaterThan(0);
  });

  test("every relative link in the README resolves to a real file", () => {
    const broken = relativeLinks.filter((href) => {
      const path = filePart(href);
      return path !== "" && !existsSync(resolve(REPO_ROOT, path));
    });
    expect(broken).toEqual([]);
  });

  test("every image the README embeds resolves to a real file", () => {
    const broken = imageSources.filter((src) => !existsSync(resolve(REPO_ROOT, filePart(src))));
    expect(broken).toEqual([]);
  });
});
