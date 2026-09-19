# AI chat

## What's actually available

JSLab's AI seam supports six providers — OpenAI, Anthropic, Gemini, Mistral, a local Ollama server, and any
custom OpenAI-compatible endpoint — but **only Ollama ships and works today**. The other five need API keys
that the project owner hasn't supplied yet, so Settings → AI → Provider offers only **Ollama (Local)** and
**None**; picking anything else isn't possible until a future build adds it. If you don't run Ollama locally,
AI Chat and Explain Result simply have nothing to talk to.

[Ollama](https://ollama.com) itself is a separate, free program you install and run yourself; JSLab talks to
it over HTTP at `http://localhost:11434` by default (configurable in Settings → AI → Ollama Base URL).

## Using the panel

<kbd>⌃⌘I</kbd>, or the activity bar, opens the AI Chat panel. Its header shows the current provider and model
(click it to jump to Settings → AI). Type a question about your code and **Send** it, or use **New Chat** to
start over. While a reply is streaming, **Stop** cancels the underlying request outright rather than just
hiding the response.

JSLab sends the current tab's code (capped at 100 KB) with every message, marked with its language, runtime
and working-directory name, so a question like "what does this do?" doesn't need you to paste the code
yourself. If **Send Recent Output** (Settings → AI) is on, the last run's output is included too, capped at
20 KB. Your message history is trimmed oldest-first when it grows too large; the code always rides its own
turn ahead of the history, so trimming can never drop it.

Replies render as Markdown with syntax-highlighted code blocks. Each code block offers **Copy**, **Insert at
Cursor**, and **Replace Editor** (one single, undoable edit) — these are hidden while the block is still
streaming, so half-written code can't be inserted.

The conversation **survives a relaunch**: it's saved to your data folder as it's written (see
[Troubleshooting](troubleshooting.md) for the path), trimmed to the most recent 200 turns and 1,000,000
characters.

## Explain Result

Every output row's menu offers **Explain Result**, which opens the AI panel and asks about that specific row —
see [the output panel](output-panel.md#copying-a-row). It uses the same Ollama-only path as the rest of AI
chat.

## API keys

When a credentialed provider ships, its key will be stored in the macOS Keychain, never in `settings.json` —
the settings file is read and written in the clear and copied verbatim into the debug log, so it's never
where a secret belongs. Ollama needs no key, which is part of why it's the first provider to ship.
