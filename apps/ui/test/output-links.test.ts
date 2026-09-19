import { describe, expect, test } from "bun:test";
import { EXTERNAL_URL_PROTOCOLS, isSafeExternalUrl, MAX_EXTERNAL_URL_CHARS } from "@jslab/rpc-schema";
import { hasLink, linkify } from "../src/output/links";

/**
 * OU-13. Output text is produced by the user's own running program -- a script can `console.log` any string it
 * likes -- so these are security tests before they are formatting tests. The ordering matters: `isSafeExternalUrl`
 * is asserted directly, so the guard is shown to be what refuses a `javascript:` URL, rather than the narrow
 * matcher in `links.ts` merely never offering one to it.
 */
describe("isSafeExternalUrl (OU-13)", () => {
  test("allows http and https, and nothing else is on the list", () => {
    expect(isSafeExternalUrl("https://example.com")).toBe(true);
    expect(isSafeExternalUrl("http://example.com/a/b?c=d#e")).toBe(true);
    // The allowlist itself, as a literal: a test that only exercised the function would still pass if a third
    // scheme were quietly added to the constant.
    expect([...EXTERNAL_URL_PROTOCOLS]).toEqual(["http:", "https:"]);
  });

  test("refuses javascript: however it is spelled", () => {
    // Each of these is a standard bypass of a naive `startsWith("javascript:")` check. The WHATWG URL parser
    // lower-cases the scheme and strips C0 controls, spaces, tabs and newlines -- which is exactly why the
    // allowlist is applied to the PARSED protocol, and why the hidden-character rule runs before it.
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "JAVASCRIPT:alert(1)",
      "  javascript:alert(1)",
      `${String.fromCharCode(1)}javascript:alert(1)`,
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "java\rscript:alert(1)",
      "javascript\t:alert(1)",
    ]) {
      expect({ url, safe: isSafeExternalUrl(url) }).toEqual({ url, safe: false });
    }
  });

  /**
   * `ftp://` and `file:///` are the inputs that make the allowlist load-bearing: both spell out an authority, so
   * they clear every structural rule in the function and can only be refused by the list of allowed protocols.
   * Delete that list and these two open; they are why it is not dead code sitting behind a scheme-shaped regex.
   */
  test("refuses every other scheme, by omission from the allowlist rather than by naming it", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "blob:https://example.com/uuid",
      "mailto:someone@example.com",
      "about:blank",
      "chrome://settings",
      "views://index.html",
      "ftp://example.com/x",
    ]) {
      expect({ url, safe: isSafeExternalUrl(url) }).toEqual({ url, safe: false });
    }
  });

  test("refuses an ALLOWED scheme whose text hides characters the parser would strip", () => {
    // These are the inputs that make the hidden-character rule load-bearing rather than incidental. Every one of
    // them PARSES to a perfectly good https URL -- the parser deletes the tab, or trims the surrounding spaces --
    // so every other rule in the function accepts them. Refusing the hidden characters outright is the only thing
    // that stops the text on screen and the URL that opens from being two different strings.
    for (const url of [
      "ht\ttps://evil.example",
      "  https://example.com",
      // DEL is not stripped by the parser, but it is invisible on screen, so a URL carrying one still shows the
      // reader something other than what it opens.
      `https://example.com/${String.fromCharCode(127)}`,
      "https://exa\tmple.com",
      "https://example.com\n",
    ]) {
      expect({ url, safe: isSafeExternalUrl(url) }).toEqual({ url, safe: false });
    }
  });

  test("refuses a URL carrying credentials, which hides the real host behind a username", () => {
    // `https://www.paypal.com@evil.example/` reads to a human as PayPal and resolves to evil.example.
    expect(isSafeExternalUrl("https://user:pass@evil.example/")).toBe(false);
    expect(isSafeExternalUrl("https://www.paypal.com@evil.example/")).toBe(false);
    // The host on its own is still fine, so the rule is about credentials and not about `@` anywhere.
    expect(isSafeExternalUrl("https://evil.example/")).toBe(true);
  });

  test("refuses text that is not a URL at all, and the empty string", () => {
    // `https:example` is the interesting one: the WHATWG parser RESOLVES it to `https://example/` because https
    // is a special scheme, so a guard that trusted the parse alone would display one string and open another.
    for (const value of ["", "example.com", "not a url", "https://", "http://", "://example.com", "https:example"]) {
      expect({ value, safe: isSafeExternalUrl(value) }).toEqual({ value, safe: false });
    }
  });

  test("refuses a URL longer than the cap, and allows one exactly at it", () => {
    const prefix = "https://example.com/";
    const atCap = prefix + "a".repeat(MAX_EXTERNAL_URL_CHARS - prefix.length);
    expect(atCap.length).toBe(MAX_EXTERNAL_URL_CHARS);
    expect(isSafeExternalUrl(atCap)).toBe(true);
    expect(isSafeExternalUrl(`${atCap}a`)).toBe(false);
    // The literal the cap is, so a change to it is a visible diff rather than a silently wider bound.
    expect(MAX_EXTERNAL_URL_CHARS).toBe(2048);
  });

  test("a Unicode host is accepted as written -- the decision recorded for homographs", () => {
    // JSLab does not attempt confusable/punycode detection. The URL is shown as the exact characters the
    // program printed and opened as those same characters, leaving the browser's address bar as the place that
    // renders IDN safely. This test exists so the decision is visible rather than undiscovered.
    expect(isSafeExternalUrl("https://аpple.com")).toBe(true);
    expect(isSafeExternalUrl("https://xn--pple-43d.com")).toBe(true);
  });
});

describe("linkify (OU-13)", () => {
  const linked = (text: string) => linkify(text).filter((segment) => segment.href !== null);

  test("plain text yields one unlinked run", () => {
    expect(linkify("nothing to see here")).toEqual([{ text: "nothing to see here", href: null }]);
    expect(hasLink("nothing to see here")).toBe(false);
  });

  test("splits a sentence into text, link, text", () => {
    expect(linkify("see https://example.com/docs now")).toEqual([
      { text: "see ", href: null },
      { text: "https://example.com/docs", href: "https://example.com/docs" },
      { text: " now", href: null },
    ]);
  });

  /**
   * The property the whole feature's honesty rests on: what is displayed IS what opens. A shortened or
   * decorated label would let an output row advertise one destination and open another.
   */
  test("every linked run's href is identical to the text it displays", () => {
    const samples = [
      "https://example.com",
      "go to https://example.com/a?b=c#d.",
      "two https://one.example and https://two.example here",
      '{"url":"https://example.com/n"}',
      "HTTPS://EXAMPLE.COM/Upper",
    ];
    for (const sample of samples) {
      const links = linked(sample);
      expect(links.length).toBeGreaterThan(0);
      for (const segment of links) expect(segment.href).toBe(segment.text);
    }
  });

  /**
   * Nothing is invented and nothing is dropped. Without this, trimming trailing punctuation or skipping an
   * unsafe candidate could silently delete characters from the row the user is reading.
   */
  test("the segments always reassemble into exactly the original text", () => {
    for (const sample of [
      "",
      "plain",
      "https://example.com",
      "(see https://example.com)",
      "javascript:alert(1) and https://ok.example end",
      "https://a.example, https://b.example.",
      "trailing punctuation https://example.com!?",
    ]) {
      expect(
        linkify(sample)
          .map((segment) => segment.text)
          .join(""),
      ).toBe(sample);
    }
  });

  test("a javascript: URL in output is never linked, and the guard is what refuses it", () => {
    expect(linked("javascript:alert(1)")).toEqual([]);
    expect(linked("click javascript:alert(document.cookie) now")).toEqual([]);
    // A scheme smuggled past a naive matcher by an embedded tab stays unlinked too.
    expect(linked("java\tscript:alert(1)")).toEqual([]);
    expect(hasLink("javascript:alert(1)")).toBe(false);
    // The control: the same sentence shape WITH an allowed scheme does link, so the assertions above are not
    // passing merely because `linked` never finds anything.
    expect(linked("click https://example.com now").map((segment) => segment.href)).toEqual(["https://example.com"]);
  });

  test("a credentialed URL stays plain text rather than becoming a link", () => {
    expect(linked("https://www.paypal.com@evil.example/pay")).toEqual([]);
    expect(linkify("https://www.paypal.com@evil.example/pay")).toEqual([
      { text: "https://www.paypal.com@evil.example/pay", href: null },
    ]);
  });

  test("trailing sentence punctuation is left out of the link", () => {
    expect(linked("see https://example.com.").map((segment) => segment.href)).toEqual(["https://example.com"]);
    expect(linked("see https://example.com, ok").map((segment) => segment.href)).toEqual(["https://example.com"]);
    expect(linked("(see https://example.com)").map((segment) => segment.href)).toEqual(["https://example.com"]);
  });

  test("a closing bracket that belongs to the URL is kept", () => {
    expect(linked("https://en.wikipedia.org/wiki/Foo_(bar)").map((segment) => segment.href)).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  test("a bare host is never linked, because a guessed scheme is a destination nobody was shown", () => {
    expect(linked("example.com")).toEqual([]);
    expect(linked("www.example.com")).toEqual([]);
  });

  test("finds several URLs in one row", () => {
    expect(linked("https://a.example and https://b.example").map((segment) => segment.href)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("a URL over the length cap is left as plain text", () => {
    const tooLong = `https://example.com/${"a".repeat(MAX_EXTERNAL_URL_CHARS)}`;
    expect(linked(tooLong)).toEqual([]);
    expect(linkify(tooLong)).toEqual([{ text: tooLong, href: null }]);
  });
});
