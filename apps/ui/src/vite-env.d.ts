/// <reference types="vite/client" />

/**
 * `@fontsource-variable/jetbrains-mono`'s package.json `main` points at `index.css`, but its bare specifier
 * (unlike `@fontsource/fira-code/400.css`) doesn't end in `.css`, so vite/client's `declare module "*.css"`
 * doesn't match it. Declared here, next to the other Vite ambient types (font-faces.ts, spec §9.4).
 */
declare module "@fontsource-variable/jetbrains-mono";
