# M5c Manual QA Checklist — the `jslab` command

Run against the packaged canary build, using the M2 launch procedure in `docs/qa/m3-checklist.md`. Build the CLI
first — `bun run build:cli` compiles the binary that the bundle copies to `Resources/app/bin/jslab`, and
`hutch run build` does not compile it for you:

```bash
export PATH="$HOME/.hutch/bin:$PATH"
REPO="$(git rev-parse --show-toplevel)"
bun run build:cli
builtin cd "$REPO/apps/desktop" && hutch run build && builtin cd "$REPO"
```

Automated tests install into a temporary folder and never escalate, so these four items have no automated cover.
`packages/e2e/scenarios/cli.test.ts` covers everything else in §16: opening a file, stdin, the `--run` gate, all three
`--runtime` values, `--cwd`, `--title`, the already-open focus rule, the error exits, and the Help menu item's flip
against a symlink inside the launch's own data folder.

- [ ] **A real install.** Help → Install `jslab` Command…, then in a **new** terminal run `which jslab` and
      `jslab --version`. Expect `~/.local/bin/jslab` and `jslab 0.0.1`. Remove it afterwards with Help →
      Uninstall `jslab` Command… and confirm `which jslab` finds nothing.
- [ ] **The PATH message.** In a shell whose profile does not add `~/.local/bin`, install and read the notice.
      Expect it to name `~/.local/bin` and show `export PATH="$HOME/.local/bin:$PATH"` verbatim.
- [ ] **All users, deliberately.** Only if you intend to: choose the all-users install, approve the
      administrator prompt once, confirm `/usr/local/bin/jslab` exists, then uninstall. Confirm the prompt
      appears **only** for this choice — the default install must never raise one.
- [ ] **Autolaunch.** Quit JSLab entirely, then run `echo '1+1' | jslab --run -` from a terminal. Expect
      JSLab to launch, open a tab and show `2` within 10 s.

## Known limitations (record, don't fix in M5c)

- **"Install for all users" is unwired.** `installCli` implements and unit-tests the `/usr/local/bin` scope with an
  `escalate` hook, but `index.ts` calls `installCli(deps, "user")` and nothing offers the other scope. Escalating to
  administrator privileges is the user's decision, not an automatic flow; the user-scope install needs no escalation.
  A user who wants `/usr/local/bin` adds `~/.local/bin` to `PATH` instead, which the notice already spells out. The
  third item above therefore has no UI to reach today — it is recorded for whenever that scope is wired up.
- **An over-long `--title` exits 1, not 2.** `args.ts` bounds no title while the wire schema bounds it at 200
  characters, so a title past 200 is refused by the server as an error rather than by the CLI as a usage error.
- **A directory in the way gives the generic message.** `pathExists` uses `Bun.file().exists()`, which reports false
  for a directory, so a *directory* named `jslab` in `~/.local/bin` falls to "Couldn't install" instead of the
  tailored "something is already there" refusal. Nothing is deleted or overwritten either way.
