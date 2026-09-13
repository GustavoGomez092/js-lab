export default {
  packageManager: "bun",
  // M0 pins Electrobun 2.0.1; without this, `hutch electrobun sync` floats on the stable channel.
  electrobun: { version: "2.0.1" },
  // With packageManager "bun", `hutch pm exec -- vite` forwards to `bun exec`, a shell
  // runner that does not resolve node_modules/.bin ("bun: command not found: vite").
  // `bun x --no-install` runs the local binary and never installs.
  scripts: {
    install: ["hutch", "pm", "install"],
    dev: "hutch electrobun prepare && hutch pm x --no-install vite build && hutch electrobun dev",
    build: "hutch electrobun prepare && hutch pm x --no-install vite build && hutch electrobun build --env=canary",
  },
};
