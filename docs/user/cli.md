# The `jslab` command

`jslab` is a small command-line tool for opening files or piped code into JSLab from a terminal.

## Installing it

Help → **Install jslab Command…** symlinks the binary that ships inside the app (at
`JSLab.app/Contents/Resources/app/bin/jslab`) into `~/.local/bin/jslab`. If that folder isn't on your `PATH`,
the message tells you the line to add to your shell profile. Help → **Uninstall jslab Command…** removes it;
the menu shows whichever of the two applies.

## Usage

```text
jslab [file ...]                 Open files in new tabs
jslab -                          Read code from stdin into a new tab
jslab --run [file|-]             Open and run immediately
      --runtime bun|browser|browser-node
      --lang ts|js|tsx|jsx       (default: from extension, else settings)
      --cwd <dir>                Set the tab's working directory (default for `-`: current dir)
      --title <title>
jslab --version | --help
```

Examples:

```bash
jslab notes.ts                       # open a file in a new tab
echo 'fetch("…")' | jslab --run -    # run code piped from stdin
jslab --runtime browser --cwd . app.tsx
```

- Code only runs when `--run` is passed; otherwise the file just opens.
- `--cwd` without a leading `-` value sets the new tab's working directory (see [npm packages and the working
  directory](npm-packages.md)); for `jslab -`, the working directory defaults to your terminal's current
  directory if you don't pass `--cwd`.
- `jslab` starts JSLab automatically if it isn't already running, and waits up to 10 seconds for it to come up.

## How it works

Each `jslab` invocation connects to a small local socket JSLab listens on (at `jslab.sock` inside your data
folder — see [Troubleshooting](troubleshooting.md)) and sends one request; it never passes arguments to the
app directly. If nothing answers and launching is allowed, it runs `open -b dev.jslab.app` and polls the
socket until JSLab is ready.
