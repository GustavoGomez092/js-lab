/**
 * Layout measurement for E2E scenarios: the boxes a real layout engine computed, plus the text that was actually
 * in them.
 *
 * **Why this is E2E-only, and why it reuses `getBoundingClientRect` rather than inventing anything.** happy-dom
 * has no layout engine -- every box it reports is zero -- so a unit test cannot say whether a translated label
 * fits. `App.tsx`'s `overlayDiagnostics` already measures real boxes in the built app (that is what
 * `webview-preview-height.test.ts` reads), and this module is the same mechanism widened: the same
 * `getBoundingClientRect()`, plus the scroll/client pair that says whether a box's content overflows it.
 *
 * **`text` is not a convenience.** Only ~27 of 761 keys are seeded in each non-English locale, so most of the UI
 * renders English even under `ja`. A geometry assertion that does not also pin the string it measured cannot tell
 * "this Japanese label fits" from "this English fallback fits", and the second proves nothing about translation.
 * Scenarios assert on `text` so that a measurement of an untranslated fallback fails loudly instead of passing
 * quietly.
 */

/** One element's geometry. `scrollWidth`/`clientWidth` are integers; `width` and the edges are subpixel. */
export interface BoxMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  /** Content size vs padding-box size. `scrollWidth > clientWidth` means the content is being clipped. */
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** The element's trimmed text, capped. Proves *which* string was measured (translated, or an English fallback). */
  text: string;
}

export interface CjkProbe {
  /** Whether the UA reports the named family as available for a Japanese sample (`FontFaceSet.check`). */
  hiraginoAvailable: boolean;
  pingfangAvailable: boolean;
  /** Advance width of a CJK sample under the app's own code font stack, and under stacks that isolate the cause. */
  cjkUnderAppStack: number;
  cjkUnderMonospaceOnly: number;
  cjkUnderHiraginoOnly: number;
  /** The same measurement for ASCII, so a zero/degenerate CJK reading can be read against a known-good one. */
  asciiUnderAppStack: number;
  /** The resolved value of `--code-font-family`, as the document actually has it. */
  codeFontFamily: string;
  sample: string;
}

export interface LayoutMetrics {
  /** First match for each named selector, `null` when the selector matches nothing. */
  boxes: Record<string, BoxMetrics | null>;
  /** Every match for each named selector, in document order. */
  groups: Record<string, BoxMetrics[]>;
  viewport: { width: number; height: number };
  /** `<html>`: the page-level box a horizontal-overflow check is made against. */
  root: BoxMetrics;
  /** `<html lang>`, which `applyDocumentLocale` sets from the locale (spec §17). */
  documentLang: string;
  cjk: CjkProbe | null;
}

const TEXT_CAP = 120;

function textOf(element: Element): string {
  return (element.textContent ?? "").trim().slice(0, TEXT_CAP);
}

export function measureElement(element: Element): BoxMetrics {
  const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
  return {
    x,
    y,
    width,
    height,
    right,
    bottom,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    text: textOf(element),
  };
}

export function measureFirst(selector: string, doc: Document = document): BoxMetrics | null {
  const element = doc.querySelector(selector);
  return element ? measureElement(element) : null;
}

export function measureAll(selector: string, doc: Document = document): BoxMetrics[] {
  return [...doc.querySelectorAll(selector)].map(measureElement);
}

/**
 * Measures a CJK run's advance width under three stacks, so "the fallback resolves" is a measurement rather than
 * a restatement of the constant.
 *
 * Asserting `fontStack(...)` contains `CJK_FALLBACK` would compare the implementation against itself -- it stays
 * green when the constant's value changes, which is exactly the tautology this milestone has already shipped
 * twice. A width is independent evidence: the browser either found a family with CJK coverage or it did not.
 */
export function probeCjk(doc: Document = document): CjkProbe | null {
  const sample = "日本語のテキスト";
  const ascii = "Latin text here";
  const body = doc.body;
  if (!body) return null;

  const codeFontFamily = doc.defaultView
    ? doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue("--code-font-family").trim()
    : "";

  const probe = doc.createElement("span");
  // Off-screen but laid out: `display: none` would make every width zero and read as a failure.
  probe.style.position = "absolute";
  probe.style.left = "-99999px";
  probe.style.top = "0";
  probe.style.whiteSpace = "pre";
  probe.style.fontSize = "13px";
  body.append(probe);

  const widthOf = (text: string, fontFamily: string): number => {
    probe.style.fontFamily = fontFamily;
    probe.textContent = text;
    return probe.getBoundingClientRect().width;
  };

  try {
    const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
    return {
      hiraginoAvailable: fonts ? fonts.check('13px "Hiragino Sans"', sample) : false,
      pingfangAvailable: fonts ? fonts.check('13px "PingFang SC"', sample) : false,
      cjkUnderAppStack: widthOf(sample, codeFontFamily || "monospace"),
      cjkUnderMonospaceOnly: widthOf(sample, "monospace"),
      cjkUnderHiraginoOnly: widthOf(sample, '"Hiragino Sans"'),
      asciiUnderAppStack: widthOf(ascii, codeFontFamily || "monospace"),
      codeFontFamily,
      sample,
    };
  } finally {
    probe.remove();
  }
}

/**
 * Measures the named selectors in one pass.
 *
 * `first` and `all` are separate so a scenario can both pin a unique region (the status bar) and sweep a
 * repeated one (every status item) without two round trips or two conventions.
 */
export function measureLayout(
  first: Record<string, string>,
  all: Record<string, string>,
  options: { doc?: Document; cjk?: boolean } = {},
): LayoutMetrics {
  const doc = options.doc ?? document;
  const view = doc.defaultView;
  const boxes: Record<string, BoxMetrics | null> = {};
  for (const [name, selector] of Object.entries(first)) boxes[name] = measureFirst(selector, doc);
  const groups: Record<string, BoxMetrics[]> = {};
  for (const [name, selector] of Object.entries(all)) groups[name] = measureAll(selector, doc);
  return {
    boxes,
    groups,
    viewport: { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
    root: measureElement(doc.documentElement),
    documentLang: doc.documentElement.lang,
    cjk: options.cjk === false ? null : probeCjk(doc),
  };
}
