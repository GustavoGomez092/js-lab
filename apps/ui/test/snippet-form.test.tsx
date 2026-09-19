import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, MAX_SNIPPET_DESCRIPTION_CHARS, type Snippet } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SnippetBodyFactory } from "../src/snippets/body-editor";
import { SnippetForm } from "../src/snippets/SnippetForm";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

const AT = "2026-09-16T10:00:00.000Z";
const LATER = "2026-09-17T11:00:00.000Z";

const ZED: Snippet = {
  id: "s0",
  // Stored WITH capitals on purpose: it is what makes the stored-side case fold falsifiable below.
  name: "ZedHelper",
  description: "stored first, last by name",
  body: "zed()",
  language: null,
  createdAt: AT,
  updatedAt: AT,
};
const FETCH: Snippet = {
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "await fetch($0)",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
};
const ALPHA: Snippet = {
  id: "s2",
  name: "alpha",
  description: "stored last, first by name",
  body: "alpha()",
  language: null,
  createdAt: AT,
  updatedAt: AT,
};

/**
 * Deliberately NOT in name order, and the snippet these tests edit (FETCH) is the MIDDLE of it. This plan's
 * fixtures are written in expected-output order, which silently disarms every ordering assertion made against
 * them -- the root cause behind six surviving mutants in Task 6 and the inert `select(...)` calls in Task 7.
 * With the edited record in the middle, a save that rebuilt the array around it cannot pass.
 */
const LIBRARY = [ZED, FETCH, ALPHA];

/** A stub body field: the form must never depend on Monaco to be testable (R-M5b-5). */
function stubBody() {
  const state = {
    value: "",
    opened: "",
    language: "unset" as string | null,
    host: null as HTMLElement | null,
    disposed: 0,
  };
  const factory: SnippetBodyFactory = (host, options) => {
    state.value = options.value;
    state.opened = options.value;
    state.language = options.language;
    state.host = host;
    return {
      getValue: () => state.value,
      focus: () => {},
      dispose: () => {
        state.disposed += 1;
      },
    };
  };
  return {
    factory,
    state,
    setValue: (next: string) => {
      state.value = next;
    },
  };
}

function setup(
  options: {
    initial?: Snippet | null;
    body?: string;
    library?: Snippet[];
    seedName?: string;
    createBody?: SnippetBodyFactory;
  } = {},
) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  store.getState().receiveSnippets(options.library ?? LIBRARY);
  const { api } = createFakeApi();
  const onDone = mock(() => {});
  const body = stubBody();
  const view = render(
    <SnippetForm
      store={store}
      api={api}
      initial={options.initial ?? null}
      body={options.body ?? ""}
      seedName={options.seedName}
      onDone={onDone}
      createBody={options.createBody ?? body.factory}
      now={() => LATER}
    />,
  );
  return { store, api, onDone, body, view };
}

type Api = ReturnType<typeof createFakeApi>["api"];

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const saveButton = () => screen.getByRole("button", { name: strings.snippets.save }) as HTMLButtonElement;
const saved = (api: Api, call = 0) => (api.snippetsSave.mock.calls[call]?.[0] ?? []) as Snippet[];
const submit = async () => {
  await act(async () => {
    fireEvent.click(saveButton());
    await Bun.sleep(1);
  });
};

describe("the New / Edit snippet form (spec §13.1)", () => {
  test("a new form opens empty, titled New Snippet, offering every language plus Any", () => {
    const { body } = setup();
    expect(screen.getByRole("heading").textContent).toBe(strings.snippets.newTitle);
    expect(field(strings.snippets.nameLabel).value).toBe("");
    expect(field(strings.snippets.descriptionLabel).value).toBe("");
    expect(select(strings.snippets.languageLabel).value).toBe("");
    expect(body.state.language).toBeNull();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      strings.snippets.languageNone,
      "TypeScript",
      "JavaScript",
      "TSX",
      "JSX",
    ]);
  });

  test("the name field takes focus when the form opens", () => {
    setup();
    expect(document.activeElement).toBe(field(strings.snippets.nameLabel));
  });

  test("creates a snippet from the four fields and appends it, leaving the library in place", async () => {
    const { api, onDone, store, body } = setup();
    body.setValue("console.log($0)");
    type(strings.snippets.nameLabel, "log");
    type(strings.snippets.descriptionLabel, "  print a value  ");
    fireEvent.change(select(strings.snippets.languageLabel), { target: { value: "javascript" } });
    await submit();
    expect(api.snippetsSave).toHaveBeenCalledTimes(1);
    // The three existing snippets survive IN ORDER, and the new one goes on the end.
    expect(saved(api).slice(0, 3)).toEqual(LIBRARY);
    expect(saved(api)).toHaveLength(4);
    expect(saved(api)[3]).toMatchObject({
      name: "log",
      description: "print a value",
      body: "console.log($0)",
      language: "javascript",
      createdAt: LATER,
      updatedAt: LATER,
    });
    // A fresh id, not one borrowed from the library.
    expect(LIBRARY.map((entry) => entry.id)).not.toContain(saved(api)[3]?.id ?? "");
    expect(store.getState().snippets).toHaveLength(4);
    expect(onDone).toHaveBeenCalled();
  });

  test("stores what the body field holds at save time, not the body the form opened with", async () => {
    const { api, body } = setup({ body: "const selected = 1" });
    // The factory was handed the opening body (Create Snippet…'s selection, spec §13.1)...
    expect(body.state.opened).toBe("const selected = 1");
    // ...and then the user edited it. A form that saved its `body` prop back would store the stale text.
    body.setValue("const selected = 2");
    type(strings.snippets.nameLabel, "sel");
    await submit();
    expect(saved(api)[3]?.body).toBe("const selected = 2");
  });

  test('a new form starts from the seed name, so Create "<query>" keeps the query', () => {
    setup({ seedName: "newthing" });
    expect(field(strings.snippets.nameLabel).value).toBe("newthing");
  });

  test("an edit shows the snippet's own name even when a seed name is supplied", () => {
    setup({ initial: FETCH, body: FETCH.body, seedName: "newthing" });
    // The seed only ever fills a NEW form; letting it win here would rename the snippet behind the user's back.
    expect(field(strings.snippets.nameLabel).value).toBe("fetchjson");
    expect(screen.getByRole("heading").textContent).toBe(strings.snippets.editTitle);
    expect(field(strings.snippets.descriptionLabel).value).toBe("Fetch + parse JSON");
  });

  test("editing keeps the id and createdAt, moves updatedAt, and leaves the snippet where it sat", async () => {
    const { api } = setup({ initial: FETCH, body: FETCH.body });
    type(strings.snippets.nameLabel, "fetchjson2");
    await submit();
    // Asserted whole: FETCH is the MIDDLE of the stored library, so a save that rebuilt the array around the
    // edited record -- appending or prepending it -- would silently reorder the user's library.
    expect(saved(api)).toEqual([ZED, { ...FETCH, name: "fetchjson2", createdAt: AT, updatedAt: LATER }, ALPHA]);
  });

  test("an edit trims the description it writes", async () => {
    const { api } = setup({ initial: FETCH, body: FETCH.body });
    type(strings.snippets.descriptionLabel, "   trimmed   ");
    await submit();
    expect(saved(api)[1]?.description).toBe("trimmed");
  });

  test("the language hint round-trips, and Any stores null rather than an empty string", async () => {
    const { api, body } = setup({ initial: FETCH, body: FETCH.body });
    expect(select(strings.snippets.languageLabel).value).toBe("typescript");
    // The body field is told the language too -- that is how Monaco colors it (Task 9).
    expect(body.state.language).toBe("typescript");
    fireEvent.change(select(strings.snippets.languageLabel), { target: { value: "" } });
    await submit();
    // "" is not a Language: storing it would fail the shared schema at the Main end.
    expect(saved(api)[1]?.language).toBeNull();
  });

  test("a missing, illegal or taken name blocks the save and says which (spec §13.1)", async () => {
    const { api } = setup();
    await submit();
    expect(await screen.findByText(strings.snippets.nameRequired)).toBeTruthy();

    type(strings.snippets.nameLabel, "   ");
    await submit();
    expect(await screen.findByText(strings.snippets.nameRequired)).toBeTruthy();

    type(strings.snippets.nameLabel, "has spaces");
    await submit();
    expect(await screen.findByText(strings.snippets.nameInvalid)).toBeTruthy();

    type(strings.snippets.nameLabel, "fetchjson");
    await submit();
    expect(await screen.findByText(strings.snippets.nameTaken)).toBeTruthy();

    expect(api.snippetsSave).not.toHaveBeenCalled();
  });

  test("a typed name differing only in case from a stored one is taken (the typed side is folded)", async () => {
    const { api } = setup();
    type(strings.snippets.nameLabel, "FETCHJSON");
    await submit();
    expect(await screen.findByText(strings.snippets.nameTaken)).toBeTruthy();
    expect(api.snippetsSave).not.toHaveBeenCalled();
  });

  test("a STORED name carrying the capitals is taken too (the stored side is folded)", async () => {
    // With every stored name already lowercase, dropping the stored-side fold is INVISIBLE: the typed fold alone
    // still matches. ZedHelper is stored with capitals, so this half needs its own fixture (Task 7's P34 lesson).
    const { api } = setup();
    type(strings.snippets.nameLabel, "zedhelper");
    await submit();
    expect(await screen.findByText(strings.snippets.nameTaken)).toBeTruthy();
    expect(api.snippetsSave).not.toHaveBeenCalled();
  });

  test("renaming a snippet to its own current name is not a conflict", async () => {
    const { api } = setup({ initial: FETCH, body: FETCH.body });
    type(strings.snippets.descriptionLabel, "changed");
    await submit();
    expect(api.snippetsSave).toHaveBeenCalledTimes(1);
  });

  test("a failed save keeps the form open with everything typed", async () => {
    const { api, onDone, store } = setup();
    api.snippetsSave.mockImplementation(async () => ({ ok: false, error: "ENOSPC" }));
    type(strings.snippets.nameLabel, "log");
    type(strings.snippets.descriptionLabel, "keep me");
    await submit();
    expect(await screen.findByText(strings.snippets.saveFailed("ENOSPC"))).toBeTruthy();
    expect(field(strings.snippets.nameLabel).value).toBe("log");
    expect(field(strings.snippets.descriptionLabel).value).toBe("keep me");
    // Pessimistic: a snippet that never reached disk must not appear in the library either.
    expect(store.getState().snippets).toEqual(LIBRARY);
    expect(onDone).not.toHaveBeenCalled();
  });

  test("a save that throws is reported rather than escaping as an unhandled rejection", async () => {
    const { api, onDone, store } = setup();
    api.snippetsSave.mockImplementation(async () => {
      throw new Error("EPIPE");
    });
    type(strings.snippets.nameLabel, "log");
    await submit();
    expect(await screen.findByText(strings.snippets.saveFailed("EPIPE"))).toBeTruthy();
    expect(store.getState().snippets).toEqual(LIBRARY);
    expect(onDone).not.toHaveBeenCalled();
  });

  test("a successful save clears the name error and the failure message an earlier attempt left", async () => {
    const { api } = setup();
    type(strings.snippets.nameLabel, "has spaces");
    await submit();
    expect(await screen.findByText(strings.snippets.nameInvalid)).toBeTruthy();

    api.snippetsSave.mockImplementation(async () => ({ ok: false, error: "ENOSPC" }));
    type(strings.snippets.nameLabel, "log");
    await submit();
    expect(screen.queryByText(strings.snippets.nameInvalid)).toBeNull();
    expect(await screen.findByText(strings.snippets.saveFailed("ENOSPC"))).toBeTruthy();

    api.snippetsSave.mockImplementation(async () => ({ ok: true }));
    await submit();
    // A stale "couldn't save" sitting under a save that then succeeded would misreport what is on disk.
    expect(screen.queryByText(strings.snippets.saveFailed("ENOSPC"))).toBeNull();
  });

  test("the Save button is disabled while a save is in flight, and cannot start a second write", async () => {
    const { api } = setup();
    let release: () => void = () => {};
    api.snippetsSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    type(strings.snippets.nameLabel, "log");
    await act(async () => {
      fireEvent.click(saveButton());
      await Bun.sleep(1);
    });
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(api.snippetsSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await Bun.sleep(1);
    });
    expect(saveButton().disabled).toBe(false);
  });

  test("Cancel leaves without saving", () => {
    const { api, onDone } = setup();
    type(strings.snippets.nameLabel, "discarded");
    fireEvent.click(screen.getByRole("button", { name: strings.snippets.cancel }));
    expect(api.snippetsSave).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  test("Escape cancels even when the body field swallows the key, and only Escape does", async () => {
    // Monaco handles keys itself and stops them propagating, so a bubble-phase document listener would never see
    // an Escape typed inside the body. This factory reproduces exactly that -- it is why the listener is capture
    // phase, and without the capture flag this test cannot pass.
    const swallowing: SnippetBodyFactory = (host) => {
      const area = host.ownerDocument.createElement("textarea");
      area.addEventListener("keydown", (event) => event.stopPropagation());
      host.append(area);
      return { getValue: () => area.value, focus: () => area.focus(), dispose: () => area.remove() };
    };
    const { onDone } = setup({ createBody: swallowing });
    const area = document.querySelector(".snippets-body textarea");
    expect(area).not.toBeNull();
    if (!area) return;

    fireEvent.keyDown(area, { key: "a" });
    expect(onDone).not.toHaveBeenCalled();
    // dispatchEvent returns false when the handler called preventDefault, so this pins that too.
    expect(fireEvent.keyDown(area, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  test("the body field is mounted into the form's body host and disposed when the form goes away", () => {
    const { body, view } = setup();
    expect(body.state.host).toBe(document.querySelector(".snippets-body"));
    expect(body.state.disposed).toBe(0);
    view.unmount();
    // Monaco holds a model and listeners; a form that never disposed would leak one per open.
    expect(body.state.disposed).toBe(1);
  });

  test("the name field is described by its help text, and marked invalid only once it is", async () => {
    setup();
    expect(field(strings.snippets.nameLabel).getAttribute("aria-describedby")).toBe("snippet-name-help");
    expect(document.getElementById("snippet-name-help")?.textContent).toBe(strings.snippets.nameHelp);
    expect(field(strings.snippets.nameLabel).getAttribute("aria-invalid")).toBe("false");
    await submit();
    expect(await screen.findByText(strings.snippets.nameRequired)).toBeTruthy();
    expect(field(strings.snippets.nameLabel).getAttribute("aria-invalid")).toBe("true");
    // Announced, not merely drawn: a validation message nobody hears blocks a save for no visible reason.
    expect(screen.getByRole("alert").textContent).toBe(strings.snippets.nameRequired);
  });

  test("the description field declares the shared length cap", () => {
    setup();
    // The only guard on this field: nothing validates description length, so the cap has to reach the DOM.
    expect(field(strings.snippets.descriptionLabel).getAttribute("maxlength")).toBe(
      String(MAX_SNIPPET_DESCRIPTION_CHARS),
    );
  });
});
