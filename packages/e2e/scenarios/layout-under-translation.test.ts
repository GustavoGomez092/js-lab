import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * Does the UI still lay out when it is not in English?
 *
 * **Why this is an E2E scenario.** happy-dom has no layout engine: `getBoundingClientRect()` returns zeros and
 * `apps/ui`'s tests never load `styles.css`, so a CSS box question is invisible to every unit test in this repo.
 * That argument is true of the unit suite and false of this one -- a built app lays out for real, which is what
 * `webview-preview-height.test.ts` already relies on. This scenario reads the same mechanism, widened by
 * `apps/ui/src/e2e/layout-metrics.ts` to carry `scrollWidth`/`clientWidth` and the text each box contained.
 *
 * **What the shipped translations actually cover, and why `text` is asserted.** Each non-English locale seeds
 * only ~27 of 761 keys, so most of the UI renders English even under `ja`. In particular `shell.*`, `tabs.*`,
 * `snippets.*` and `palette.*` are NOT seeded: the status bar, tab bar and snippets panel show English in every
 * locale. Measuring those and calling it "verified under translation" would be fake coverage. So:
 *
 *   - The Settings window is where the seeded strings really land (`settings.tabs.*` in a fixed 180px nav track,
 *     `settings.restartRequired` inside `.field-text`). Its assertions pin the measured *text* as non-ASCII under
 *     `ja`/`zh`, so a fallback to English fails rather than passing quietly.
 *   - The main window's `.status-item` and `.tab-title` rules are instead stressed with long CJK *content* (a
 *     working-directory name and a tab title), which is real user content those rules exist for. That is a test
 *     of the rule, not of a translation, and is labelled as such.
 *
 * `documentLang` is asserted on every reading: if `app.uiLanguage` never reached the view, it stays "en" and the
 * whole measurement is disqualified instead of being reported as a pass.
 */

interface BoxMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  text: string;
}

interface CjkProbe {
  hiraginoAvailable: boolean;
  pingfangAvailable: boolean;
  cjkUnderAppStack: number;
  cjkUnderMonospaceOnly: number;
  cjkUnderHiraginoOnly: number;
  asciiUnderAppStack: number;
  codeFontFamily: string;
  sample: string;
}

interface LayoutMetrics {
  boxes: Record<string, BoxMetrics | null>;
  groups: Record<string, BoxMetrics[]>;
  viewport: { width: number; height: number };
  root: BoxMetrics;
  documentLang: string;
  cjk: CjkProbe | null;
}

type Frame = { x: number; y: number; width: number; height: number };

/**
 * `scrollWidth`/`clientWidth` are rounded to integers while the boxes they describe are subpixel, so a 1px
 * difference is rounding rather than overflow. Anything a broken tolerance rule produces is far larger than this
 * (the mutations below moved these by tens to hundreds of pixels), so the slack costs no sensitivity.
 */
const OVERFLOW_SLACK = 1;
/** Edge comparisons are subpixel on both sides; this absorbs fractional layout only. */
const EDGE_SLACK = 0.5;

/** A folder name long enough that `.status-item`'s ellipsis has something to do, in CJK. */
const LONG_CJK_DIR = "日本語のとても長いフォルダー名前テスト用";
/** A first line long enough that `.tab-title` must clip inside `.tab`'s 220px cap. `deriveTitle` uses it. */
const LONG_CJK_TITLE = "非常に長い日本語のタブタイトルの見本テキストです本当に長い";

const LOCALES = ["en", "ja", "zh", "es", "pt"] as const;
type Locale = (typeof LOCALES)[number];

const SIZES = [
  { label: "wide 1400x1000", frame: { x: 60, y: 60, width: 1400, height: 1000 } },
  { label: "narrow 820x620", frame: { x: 60, y: 60, width: 820, height: 620 } },
] as const;

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

// biome-ignore lint/suspicious/noExplicitAny: persisted JSON is read field by field
const readJson = async (path: string): Promise<Record<string, any>> => JSON.parse(await readFile(path, "utf8"));

const layoutOf = async (app: LaunchedApp): Promise<LayoutMetrics> =>
  (await app.state()).ui.layoutMetrics as LayoutMetrics;

const hasCjk = (text: string): boolean => /[぀-ヿ㐀-䶿一-鿿]/.test(text);
const overflowsX = (box: BoxMetrics): boolean => box.scrollWidth > box.clientWidth + OVERFLOW_SLACK;

/** Sets this launch's stored main-window frame, the way `webview-preview-height.test.ts` does. */
async function setWindowFrame(userData: string, key: "window" | "settingsWindow", frame: Frame) {
  const path = join(userData, "session.json");
  const session = await readJson(path);
  session[key] = { ...frame, fullscreen: false };
  await writeFile(path, JSON.stringify(session));
}

/** Drives the real folder picker, as `working-directory.test.ts` does. */
async function pickFolder(app: LaunchedApp, folder: string) {
  await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([folder]));
  await app.command("wd.set");
  await waitFor(async () => activeTab(await app.state()).workingDirectory === folder || null, {
    timeoutMs: 15_000,
    message: "the working directory was never set",
  });
}

function describeBox(name: string, box: BoxMetrics | null): string {
  if (!box) return `  ${name.padEnd(14)} ABSENT`;
  const size = `${box.width.toFixed(1)}x${box.height.toFixed(1)}`;
  const scroll = `scroll ${box.scrollWidth}/${box.clientWidth}`;
  return `  ${name.padEnd(14)} ${size.padEnd(18)} @ (${box.x.toFixed(0)},${box.y.toFixed(0)}) ${scroll} ${JSON.stringify(box.text.slice(0, 40))}`;
}

describe("layout under translation", () => {
  test("the shell has no page overflow and no zero-size region, in five locales at two window sizes", async () => {
    const userData = await createUserData();
    const wd = join(userData, LONG_CJK_DIR);
    await mkdir(wd, { recursive: true });

    // One setup launch creates session.json, which is what the frame is written into for every later launch.
    const setup = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    apps.push(setup);
    await setup.quit();

    const readings: { locale: Locale; size: string; metrics: LayoutMetrics }[] = [];

    for (const locale of LOCALES) {
      for (const size of SIZES) {
        await setWindowFrame(userData, "window", size.frame);
        const app = await launchApp({
          userData,
          settings: { version: 3, run: { autoRun: false }, app: { uiLanguage: locale } },
        });
        apps.push(app);

        // Content that gives the two tolerance rules something to tolerate.
        await pickFolder(app, wd);
        await app.type(LONG_CJK_TITLE);
        await waitFor(async () => (activeTab(await app.state()).title.includes("長い") ? true : null), {
          timeoutMs: 15_000,
          message: "the CJK tab title never landed",
        });

        const metrics = await layoutOf(app);
        readings.push({ locale, size: size.label, metrics });

        console.log(
          `\n[${locale}] ${size.label} lang=${metrics.documentLang} viewport=${metrics.viewport.width}x${metrics.viewport.height}`,
        );
        for (const name of ["rootEl", "app", "toolbar", "tabBar", "statusBar", "statusRight", "output"])
          console.log(describeBox(name, metrics.boxes[name] ?? null));
        for (const item of metrics.groups.statusItems ?? []) console.log(describeBox("statusItem", item));
        for (const title of metrics.groups.tabTitles ?? []) console.log(describeBox("tabTitle", title));

        await app.quit();
      }
    }

    expect(readings.length).toBe(LOCALES.length * SIZES.length);

    for (const { locale, size, metrics } of readings) {
      const where = `${locale} @ ${size}`;

      // The locale actually reached the view. Without this every assertion below could be measuring English.
      expect(metrics.documentLang, `${where}: <html lang> must be the launched locale`).toBe(locale);

      // (1) No horizontal overflow of the page.
      const root = metrics.boxes.rootEl as BoxMetrics | null;
      expect(root, `${where}: #root must exist`).toBeTruthy();
      expect(
        (root as BoxMetrics).scrollWidth,
        `${where}: #root overflows horizontally (content is being clipped off-screen)`,
      ).toBeLessThanOrEqual((root as BoxMetrics).clientWidth + OVERFLOW_SLACK);

      // (4) Nothing renders at zero size. A 1352x0 frame was a real bug in this app and it "looked fine".
      for (const name of ["app", "toolbar", "tabBar", "statusBar", "output"]) {
        const box = metrics.boxes[name] as BoxMetrics | null;
        expect(box, `${where}: ${name} must be mounted`).toBeTruthy();
        expect((box as BoxMetrics).width, `${where}: ${name} has zero width`).toBeGreaterThan(0);
        expect((box as BoxMetrics).height, `${where}: ${name} has zero height`).toBeGreaterThan(0);
      }

      // (2) No status item escapes the status bar. This is the `.status-item` tolerance rule's whole job, and
      // it is being asked to do it against a long CJK folder name.
      const statusBar = metrics.boxes.statusBar as BoxMetrics;
      const items = metrics.groups.statusItems ?? [];
      expect(items.length, `${where}: the status bar must have items to measure`).toBeGreaterThan(0);
      for (const item of items) {
        expect(
          item.right,
          `${where}: a status item escapes the status bar's right edge (${JSON.stringify(item.text)})`,
        ).toBeLessThanOrEqual(statusBar.right + EDGE_SLACK);
        expect(
          item.x,
          `${where}: a status item escapes the status bar's left edge (${JSON.stringify(item.text)})`,
        ).toBeGreaterThanOrEqual(statusBar.x - EDGE_SLACK);
      }

      // The working-directory item is the one carrying the long CJK name: it must be one of the measured items,
      // or this locale's reading never stressed `.status-item` at all.
      const wdItem = items.find((item) => hasCjk(item.text));
      expect(wdItem, `${where}: the CJK working-directory status item was not measured`).toBeTruthy();

      // (3) The tab title clips by design rather than pushing its siblings out. `scrollWidth > clientWidth` on
      // an ellipsised element is the positive signal that clipping is happening.
      const titles = metrics.groups.tabTitles ?? [];
      expect(titles.length, `${where}: a tab title must be measured`).toBeGreaterThan(0);
      const cjkTitle = titles.find((title) => hasCjk(title.text));
      expect(cjkTitle, `${where}: the long CJK tab title was not measured`).toBeTruthy();
      expect(
        overflowsX(cjkTitle as BoxMetrics),
        `${where}: the long CJK tab title is NOT being clipped -- .tab-title's ellipsis is not in effect`,
      ).toBe(true);

      const tabs = metrics.groups.tabs ?? [];
      const owningTab = tabs.find((tab) => hasCjk(tab.text));
      expect(owningTab, `${where}: the tab holding the CJK title was not measured`).toBeTruthy();
      // The clipped title must not have made its own tab overflow: that is the "pushes siblings out" failure.
      expect(
        overflowsX(owningTab as BoxMetrics),
        `${where}: the tab overflows its own box -- the title is pushing its siblings out`,
      ).toBe(false);
    }
  }, 900_000);

  test("the Settings window lays out translated labels without overflowing, at two window sizes", async () => {
    const userData = await createUserData();
    const setup = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    apps.push(setup);
    await setup.quit();

    const settingsSizes = [
      { label: "wide 980x760", frame: { x: 80, y: 80, width: 980, height: 760 } },
      { label: "narrow 620x460", frame: { x: 80, y: 80, width: 620, height: 460 } },
    ] as const;

    for (const locale of LOCALES) {
      for (const size of settingsSizes) {
        await setWindowFrame(userData, "settingsWindow", size.frame);
        const app = await launchApp({
          userData,
          settings: { version: 3, run: { autoRun: false }, app: { uiLanguage: locale } },
        });
        apps.push(app);

        await app.key("cmd+,");
        const state = await waitFor(
          async () => {
            const settings = await app.settingsState();
            return settings?.ready ? settings : null;
          },
          { timeoutMs: 45_000, message: "The Settings window never became ready" },
        );
        const metrics = state.layoutMetrics as LayoutMetrics;
        const where = `${locale} @ ${size.label}`;

        console.log(
          `\n[settings ${locale}] ${size.label} lang=${metrics.documentLang} viewport=${metrics.viewport.width}x${metrics.viewport.height}`,
        );
        for (const name of ["rootEl", "settings", "nav", "main", "heading"])
          console.log(describeBox(name, metrics.boxes[name] ?? null));
        for (const button of metrics.groups.navButtons ?? []) console.log(describeBox("navButton", button));

        expect(metrics.documentLang, `${where}: the Settings window must be in the launched locale`).toBe(locale);

        // (1) No horizontal overflow of the Settings page.
        const root = metrics.boxes.rootEl as BoxMetrics | null;
        expect(root, `${where}: #root must exist`).toBeTruthy();
        expect(
          (root as BoxMetrics).scrollWidth,
          `${where}: the Settings window overflows horizontally`,
        ).toBeLessThanOrEqual((root as BoxMetrics).clientWidth + OVERFLOW_SLACK);

        // (4) Nothing renders at zero size.
        for (const name of ["settings", "nav", "main"]) {
          const box = metrics.boxes[name] as BoxMetrics | null;
          expect(box, `${where}: ${name} must be mounted`).toBeTruthy();
          expect((box as BoxMetrics).width, `${where}: ${name} has zero width`).toBeGreaterThan(0);
          expect((box as BoxMetrics).height, `${where}: ${name} has zero height`).toBeGreaterThan(0);
        }

        // (2) No nav button escapes the fixed 180px nav track.
        const nav = metrics.boxes.nav as BoxMetrics;
        const buttons = metrics.groups.navButtons ?? [];
        expect(buttons.length, `${where}: the Settings nav must have buttons`).toBe(8);
        for (const button of buttons) {
          expect(
            button.right,
            `${where}: a nav button escapes the 180px nav track (${JSON.stringify(button.text)})`,
          ).toBeLessThanOrEqual(nav.right + EDGE_SLACK);
          expect(
            overflowsX(button),
            `${where}: a nav button's label overflows its own box (${JSON.stringify(button.text)})`,
          ).toBe(false);
        }

        // These labels are genuinely translated (`settings.tabs.*` is one of the ~27 seeded keys), so under a
        // CJK locale the measured text must actually be CJK. Without this the assertions above would be
        // measuring the English fallback and proving nothing about translation.
        if (locale === "ja" || locale === "zh") {
          const translated = buttons.filter((button) => hasCjk(button.text));
          expect(
            translated.length,
            `${where}: no Settings nav label rendered as CJK -- the measurement was of English fallbacks`,
          ).toBeGreaterThanOrEqual(6);
        }

        // (2, cont.) A field's text column must not push its control out of the field row. `.field-text`'s
        // `min-width: 0` is what lets it shrink; without it the control is pushed past the row's right edge.
        const fields = metrics.groups.fields ?? [];
        const controls = metrics.groups.fieldControls ?? [];
        expect(fields.length, `${where}: the General tab must render fields`).toBeGreaterThan(0);
        expect(controls.length, `${where}: the General tab must render field controls`).toBe(fields.length);
        for (const [index, field] of fields.entries()) {
          const control = controls[index] as BoxMetrics;
          expect(
            control.right,
            `${where}: a field control is pushed outside its field row (${JSON.stringify(field.text.slice(0, 30))})`,
          ).toBeLessThanOrEqual(field.right + EDGE_SLACK);
          expect(overflowsX(field), `${where}: a field row overflows its own box`).toBe(false);
        }

        await app.quit();
      }
    }
  }, 900_000);

  test("a CJK run resolves to a font with CJK coverage, measured rather than asserted against the constant", async () => {
    // Asserting that `fontStack()` contains CJK_FALLBACK would compare the implementation against itself: that
    // assertion stays green when the constant's value changes, which this milestone has already shipped twice.
    // An advance width is independent evidence -- the browser either found CJK coverage or it did not.
    const app = await launchApp({ settings: { version: 3, run: { autoRun: false }, app: { uiLanguage: "ja" } } });
    apps.push(app);
    const metrics = await layoutOf(app);
    const cjk = metrics.cjk as CjkProbe | null;
    expect(cjk, "the CJK probe must have run").toBeTruthy();
    const probe = cjk as CjkProbe;
    console.log(`\n[cjk probe] ${JSON.stringify(probe, null, 2)}`);

    // The stack the app actually installed must be present at all: this is what proves
    // `applyAppearanceVariables` ran and set the variable the UI paints text with.
    expect(probe.codeFontFamily, "--code-font-family must be set by applyAppearanceVariables").not.toBe("");

    // A CJK run must occupy real horizontal space: a zero or degenerate advance is what "renders, so it is easy
    // to miss" looks like from the outside.
    expect(probe.cjkUnderAppStack, "the CJK sample has no advance width under the app's font stack").toBeGreaterThan(0);
    expect(probe.asciiUnderAppStack, "the ASCII control has no advance width").toBeGreaterThan(0);

    // Per CHARACTER, not per string: the samples have different lengths (8 CJK glyphs vs 15 ASCII characters),
    // so comparing the two totals compares nothing. A CJK glyph is a wide character and must take markedly more
    // advance than a Latin one at the same size; if the run had been substituted with narrow last-resort boxes,
    // this ratio would collapse toward 1.
    const perCjkChar = probe.cjkUnderAppStack / [...probe.sample].length;
    const perAsciiChar = probe.asciiUnderAppStack / "Latin text here".length;
    console.log(
      `[cjk probe] per-character advance: CJK ${perCjkChar.toFixed(2)}px vs ASCII ${perAsciiChar.toFixed(2)}px`,
    );
    expect(perCjkChar, "CJK glyphs are not being laid out at wide-character advances").toBeGreaterThan(
      perAsciiChar * 1.4,
    );

    // What this test does NOT establish, measured rather than assumed (see the report for the numbers): the
    // three stacks below -- the app's own, bare `monospace`, and Hiragino alone -- all returned the SAME advance
    // width. macOS performs last-resort substitution to the same family whether or not the stack names it, so no
    // width measurement here can distinguish "the CJK_FALLBACK stack resolved the glyphs" from "the OS
    // substituted them anyway". This scenario therefore does not cover Task 13's font-fallback change, and the
    // equality is asserted so that the day macOS stops substituting, this stops quietly claiming otherwise.
    expect(
      probe.cjkUnderMonospaceOnly,
      "monospace-only no longer substitutes to the same CJK metrics -- the fallback stack may now be measurable",
    ).toBe(probe.cjkUnderAppStack);
  }, 300_000);
});
