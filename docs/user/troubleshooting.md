# Troubleshooting

## First launch: "JSLab can't be opened"

JSLab's builds aren't signed or notarized — it's open source and doesn't pay for an Apple Developer ID — so
macOS blocks the first launch. Control-click the app in Applications, choose **Open**, and confirm. Or run:

```bash
xattr -dr com.apple.quarantine "/Applications/JSLab-canary.app"
```

The first launch unpacks the app, which can take a few seconds.

## Where your data lives

Everything JSLab stores locally lives under one folder:

```
~/Library/Application Support/dev.jslab.app/<channel>/
```

`<channel>` is `stable` for a normal release build (`canary` for a canary build, `dev` for a development
build). Inside it:

| File / folder | What it holds |
|---|---|
| `settings.json` | Everything in Settings |
| `session.json` | Open tabs, their layout, and window state |
| `keybindings.json` | Your keyboard shortcut overrides |
| `env.json` | [Environment Variables](environment-variables.md), mode `0600` |
| `snippets.json` | Your [snippet](snippets.md) library |
| `ai/conversation.json` | The [AI chat](ai-chat.md) conversation |
| `themes/` | Themes you've imported |
| `packages/` | The shared npm project every tab's imports resolve against |
| `logs/main.log` | The application log (see below) |
| `jslab.sock` | The socket the [`jslab` CLI](cli.md) talks to |

## Logs and the debug log

Help → **Open Logs Folder** opens the `logs/` folder above directly. The live log file is `main.log`, capped
at 5 MB and rotated, keeping 5 files total.

Help → **Copy Debug Log** copies a **redacted** version of recent activity to your clipboard — the fastest way
to hand over diagnostic detail without including your secrets.

## Safe Mode

JSLab starts in **Safe Mode** — Auto Run paused for that session — in three situations, each with its own
banner:

- It detects it didn't shut down cleanly last time it was running code (a crash loop guard).
- You held Shift while launching it.
- You chose Help → **Restart in Safe Mode**.

Safe Mode doesn't stop you from running code manually (<kbd>⌘R</kbd> still works); it only stops Auto Run from
firing on its own, so you can get a hanging or crashing tab back under control before it tries to run again.

## A run won't stop

<kbd>⌘⇧R</kbd> stops a run gracefully and escalates to a kill after 500 ms if it doesn't respond; <kbd>⌘⌥R</kbd>
kills it immediately. If a run stops responding entirely, JSLab shows a **Tab Unresponsive** prompt on its own
— see [The editor and live output](editor-and-output.md#stopping-a-run).

## Something else

Help → **Report Issue** opens the project's issue tracker in your browser.
