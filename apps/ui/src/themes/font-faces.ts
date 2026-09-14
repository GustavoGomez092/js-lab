import dejavuSansMono from "dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf?url";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/700.css";
import "@fontsource/ubuntu-mono/400.css";
import "@fontsource/ubuntu-mono/700.css";
import "hack-font/build/web/hack.css";

/** Registers the bundled fonts that ship as files rather than CSS (spec §9.4). Vite-only: never import in tests. */
export function registerBundledFontFaces(): void {
  document.fonts.add(new FontFace("DejaVu Sans Mono", `url(${dejavuSansMono})`));
}
