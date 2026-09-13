# M0 spike shell (throwaway)

Throwaway Electrobun 2.0.1 app used for the M0 spikes S1–S8. Results, raw output and decisions are in `docs/spikes/2026-09-m0-report.md`. Nothing here ships.

## Toolchain

- Hutch is pinned to **0.24.3**, the release `electrobun@2.0.1` requires. Install it with `sh install.sh --version 0.24.3` (see the report's "Toolchain setup"). Never run `hutch upgrade`: the `electrobun@2.0.1` bootstrap rejects any other Hutch version.
- Electrobun is pinned to 2.0.1 in `hutch.config.ts`. The bundled Bun is 1.4.0.

```bash
hutch install            # delegates to the vendored Bun (packageManager: "bun")
hutch electrobun sync    # projects Electrobun 2.0.1 into .hutch/devkit
hutch run dev            # dev build + launch
hutch run build          # canary build -> build/canary-macos-arm64
```

## Re-running the packaged probes

Each spike section in the report has the exact procedure. In short:

1. `hutch run build`, then copy `build/canary-macos-arm64/JSLab Spike-canary.app` to an **internal disk** directory. Launched from an external volume (`/Volumes/...`) it stalls on a hidden removable-volume permission prompt.
2. Delete `~/Library/Application Support/dev.jslab.spike/canary/` for a fresh self-extraction and a clean `spike-report.json`.
3. Launch the copied app's `Contents/MacOS/launcher` directly (not `open`, so the environment reaches the process) with `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`:

   ```bash
   ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "<copy>/JSLab Spike-canary.app/Contents/MacOS/launcher"
   ```

   Opt-in probes:
   - `JSLAB_SPIKE_S6=1` auto-opens the S6 Save dialog on launch. The **Save As...** button works without it.
   - `JSLAB_SPIKE_S7=1` runs the S7 throughput sequence (200/batch, then 1000/batch). The throughput buttons work without it.
4. Read the results from `~/Library/Application Support/dev.jslab.spike/canary/spike-report.json`.
5. Quit by PID (`pgrep -f "JSLab Spike-canary.app"`, then `kill -9 <pid>`). `osascript -e 'quit app "JSLab Spike"'` does not quit this app.

The S3 pinned-Bun check (R9) also expects a Bun 1.3.13 binary at `runner/bun-bin/bun`. It is gitignored; the download commands are in the report's S3 "System changes".
