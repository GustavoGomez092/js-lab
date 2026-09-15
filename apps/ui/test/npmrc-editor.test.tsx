import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_NPMRC } from "@jslab/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type CreateTextEditor, NpmrcEditor, type NpmrcEditorHandle } from "../src/settings/NpmrcEditor";
import { strings } from "../src/strings";

const NL = String.fromCharCode(10);

function fakeEditorFactory() {
  let value = "";
  const listeners = new Set<() => void>();
  const create: CreateTextEditor = async (_host, initial) => {
    value = initial;
    return {
      getValue: () => value,
      setValue: (next) => {
        value = next;
        for (const listener of listeners) listener();
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: () => listeners.clear(),
    };
  };
  return {
    create,
    type: (next: string) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

describe(".npmrc editor (spec §11.5)", () => {
  test("loads the file, enables Save after a change, saves and resets to the default registry (R27-1, R27-2)", async () => {
    const editor = fakeEditorFactory();
    let handle: NpmrcEditorHandle | null = null;
    const registryA = `registry=http://127.0.0.1:4873/${NL}`;
    const registryB = `registry=http://127.0.0.1:4874/${NL}`;
    const api = {
      getNpmrc: mock(async () => registryA),
      saveNpmrc: mock(async (_content: string) => ({ ok: true as const })),
      resetNpmrc: mock(async () => DEFAULT_NPMRC),
    };
    render(
      <NpmrcEditor
        api={api}
        createEditor={editor.create}
        onReady={(ready) => {
          handle = ready;
        }}
      />,
    );
    await waitFor(() => expect(handle?.content()).toBe(registryA));
    const save = screen.getByRole("button", { name: strings.settings.npmrc.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    act(() => editor.type(registryB));
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
    });
    expect(api.saveNpmrc).toHaveBeenCalledWith(registryB);
    expect(await screen.findByText(strings.settings.npmrc.saved)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(strings.settings.npmrc.saved);
    // R27-1: Reset asks for confirmation before it takes effect.
    await act(async () => {
      screen.getByRole("button", { name: strings.settings.npmrc.reset }).click();
    });
    expect((handle as NpmrcEditorHandle | null)?.content()).toBe(registryB);
    await act(async () => {
      screen.getByRole("button", { name: strings.settings.confirmReset }).click();
    });
    expect((handle as NpmrcEditorHandle | null)?.content()).toBe(DEFAULT_NPMRC);
    expect((handle as NpmrcEditorHandle | null)?.dirty()).toBe(false);
  });

  test("a failed save keeps the text and shows the error", async () => {
    const editor = fakeEditorFactory();
    let handle: NpmrcEditorHandle | null = null;
    const api = {
      getNpmrc: mock(async () => ""),
      saveNpmrc: mock(async () => ({ ok: false as const, error: "EROFS: read-only file system" })),
      resetNpmrc: mock(async () => DEFAULT_NPMRC),
    };
    render(
      <NpmrcEditor
        api={api}
        createEditor={editor.create}
        onReady={(ready) => {
          handle = ready;
        }}
      />,
    );
    await waitFor(() => expect(handle).not.toBeNull());
    act(() => (handle as NpmrcEditorHandle | null)?.set(`//r/:_authToken=npm_FAKE_TEST_TOKEN${NL}`));
    await act(async () => {
      await (handle as NpmrcEditorHandle | null)?.save();
    });
    expect(await screen.findByText(strings.settings.npmrc.saveFailed("EROFS: read-only file system"))).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect((handle as NpmrcEditorHandle | null)?.dirty()).toBe(true);
  });

  test("a failed reset keeps the content and shows the plain error, with no leaked path (N1-1)", async () => {
    const editor = fakeEditorFactory();
    let handle: NpmrcEditorHandle | null = null;
    const registryA = `registry=http://127.0.0.1:4873/${NL}`;
    const leakedPath = "/Users/example/secret/path";
    const api = {
      getNpmrc: mock(async () => registryA),
      saveNpmrc: mock(async (_content: string) => ({ ok: true as const })),
      resetNpmrc: mock(async () => {
        throw new Error(`${leakedPath}: EACCES`);
      }),
    };
    render(
      <NpmrcEditor
        api={api}
        createEditor={editor.create}
        onReady={(ready) => {
          handle = ready;
        }}
      />,
    );
    await waitFor(() => expect(handle?.content()).toBe(registryA));
    // Confirm Reset, then Reset (R27-1's two-click flow).
    await act(async () => {
      screen.getByRole("button", { name: strings.settings.npmrc.reset }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: strings.settings.confirmReset }).click();
    });
    expect((handle as NpmrcEditorHandle | null)?.content()).toBe(registryA);
    expect(await screen.findByText(strings.settings.npmrc.resetFailed)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain(leakedPath);
    expect(screen.queryByRole("button", { name: strings.settings.confirmReset })).toBeNull();
  });
});
