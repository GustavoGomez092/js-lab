import { describe, expect, jest, test } from "bun:test";
import { appNoticeSchema, type StartupNotice } from "@jslab/rpc-schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { NOTICE_AUTO_DISMISS_MS, StartupNotices } from "../src/shell/parts";
import { createAppStore } from "../src/state/store";

/**
 * The `settingsTooLarge` notice (D1), pinned end to end on the UI side.
 *
 * Main raising a notice is worth nothing if the UI drops it, and the ways it could drop it are silent: the id has
 * to survive `appNoticeSchema` (the UI validates every `app.notice` before showing it, so an id Main can raise but
 * the schema rejects is discarded without a trace), then reach the store, then actually render. `settingsNewer`
 * is covered at two of those points; this one was covered at none, which is why it is pinned here rather than
 * trusted to the path being generic.
 *
 * The exact wording lives in Main's strings and is asserted there (main-services.test.ts checks it names the file
 * and the limit). Asserting it again here would mean apps/ui reaching into apps/desktop, so this pins that
 * whatever message arrives is the message the user can read and dismiss.
 */
const MESSAGE =
  "settings.json is too large for JSLab to save (1054676 bytes; the limit is 1048576). " +
  "Changes made in this window won't be saved to it and will be lost when JSLab restarts.";

describe("the settings-too-large notice reaches the user", () => {
  test("the id crosses the app.notice contract, shows once, and can be dismissed", () => {
    // The wire contract. This is what breaks if `settingsTooLarge` is dropped from STARTUP_NOTICE_IDS: Main would
    // still raise it and the UI would still refuse it, silently -- the exact failure this notice exists to avoid.
    const parsed = appNoticeSchema.parse({ id: "settingsTooLarge", message: MESSAGE });
    expect(parsed.id).toBe("settingsTooLarge");

    // The store: one banner per id, however many times Main raises it. Main already raises it once per session,
    // so this is the second, independent guard against a banner that stacks up on every settings change.
    const store = createAppStore();
    store.getState().addNotice(parsed);
    store.getState().addNotice(parsed);
    expect(store.getState().notices.map((notice) => notice.id)).toEqual(["settingsTooLarge"]);

    // The real component, with the real notice object: the user can read it, and get rid of it.
    const dismissed: string[] = [];
    render(<StartupNotices notices={store.getState().notices} onDismiss={(id) => dismissed.push(id)} />);
    expect(screen.getByTestId("startup-notices").textContent).toContain("too large");
    expect(screen.getByText(MESSAGE, { exact: false })).toBeDefined();

    // No action is registered for this id, so the only button in the banner is its dismiss control.
    fireEvent.click(screen.getByRole("button"));
    expect(dismissed).toEqual(["settingsTooLarge"]);
  });

  test("a notice the schema rejects never reaches the store", () => {
    // The negative control for the assertion above: if `appNoticeSchema` accepted anything, the first test would
    // pass no matter what STARTUP_NOTICE_IDS contained, and would be pinning nothing at all.
    expect(() => appNoticeSchema.parse({ id: "settingsWayTooLarge", message: MESSAGE })).toThrow();
    expect(() => appNoticeSchema.parse({ id: "settingsTooLarge", message: "" })).toThrow();
  });
});

/**
 * UI item 7: the banner used to render `banner banner-warning` for every id, so a silent recovery and an
 * unexpected Main error arrived in the same tone.
 */
describe("the notice banner's voice matches what happened", () => {
  const INFO: StartupNotice = { id: "settingsRecovered", message: "Settings were reset." };
  const WARNING: StartupNotice = { id: "settingsTooLarge", message: "settings.json is too large to save." };
  const ERROR: StartupNotice = { id: "unexpectedError", message: "Something went wrong." };

  test("each severity renders its own class and its own icon", () => {
    render(<StartupNotices notices={[INFO, WARNING, ERROR]} onDismiss={() => {}} />);
    // Scoped to the banners themselves: with three stacked, the container also holds the Dismiss all control.
    const banners = [...screen.getByTestId("startup-notices").querySelectorAll("output.banner")];
    expect(banners.map((banner) => banner.className)).toEqual([
      "banner banner-info",
      "banner banner-warning",
      "banner banner-error",
    ]);
    // Colour alone would fail anyone who cannot see it, so the shape has to differ too -- and differ per
    // severity, which is what a single shared glyph would quietly not do.
    const icons = banners.map((banner) => banner.querySelector(".banner-icon")?.textContent ?? "");
    expect(icons.every((icon) => icon.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(3);
  });

  test("an error notice is never auto-dismissed, however long it waits", () => {
    jest.useFakeTimers();
    try {
      const dismissed: StartupNotice["id"][] = [];
      render(<StartupNotices notices={[INFO, WARNING, ERROR]} onDismiss={(id) => dismissed.push(id)} />);
      jest.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 100);
      // WCAG 2.2.3, and §7's hard constraint. The `info` half is the control: without it this test would pass
      // just as well if NO timer were ever scheduled, and would be pinning nothing.
      expect(dismissed).toEqual(["settingsRecovered"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an informational notice's timer does not outlive the component", () => {
    jest.useFakeTimers();
    try {
      const dismissed: StartupNotice["id"][] = [];
      const view = render(<StartupNotices notices={[INFO]} onDismiss={(id) => dismissed.push(id)} />);
      view.unmount();
      jest.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 100);
      // A timer that survives teardown dismisses a notice that is gone -- a state update on an unmounted tree.
      expect(dismissed).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * Retargeted per the brief. Dedup-by-id and the bounded queue are already pinned in `store.test.ts`
   * ("runtime notices from Main are added once per id and capped at the 5 newest"), so duplicating them here
   * would add no coverage. The third guarantee that brief names -- the per-notice action -- was covered
   * nowhere, and neither was the a11y the banner must keep: `<output>`, and a dismiss control named by the
   * message it dismisses.
   */
  test("a notice's action runs, and the banner is still an announced <output> named by its message", () => {
    const dismissed: StartupNotice["id"][] = [];
    let copied = 0;
    render(
      <StartupNotices
        notices={[ERROR]}
        onDismiss={(id) => dismissed.push(id)}
        actions={{
          unexpectedError: {
            label: "Copy Debug Log",
            run: () => {
              copied += 1;
            },
          },
        }}
      />,
    );
    expect(screen.getByTestId("startup-notices").firstElementChild?.tagName).toBe("OUTPUT");
    fireEvent.click(screen.getByRole("button", { name: "Copy Debug Log" }));
    expect(copied).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: `Dismiss: ${ERROR.message}` }));
    expect(dismissed).toEqual(["unexpectedError"]);
  });

  test("Dismiss all appears only once notices stack up, and clears every one of them", () => {
    const dismissed: StartupNotice["id"][] = [];
    const onDismiss = (id: StartupNotice["id"]) => dismissed.push(id);
    // All three are warnings, so nothing here is auto-dismissed and the count is the only variable.
    const two: StartupNotice[] = [WARNING, { id: "sessionNewer", message: "session.json is newer." }];
    const view = render(<StartupNotices notices={two} onDismiss={onDismiss} />);
    expect(screen.queryByRole("button", { name: "Dismiss all" })).toBeNull();

    const three: StartupNotice[] = [...two, { id: "tabsDropped", message: "2 tabs were skipped." }];
    view.rerender(<StartupNotices notices={three} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    expect(dismissed).toEqual(["settingsTooLarge", "sessionNewer", "tabsDropped"]);
  });
});
