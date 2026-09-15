import { strings } from "../strings";

/** Side bar host (spec §7.1). The Snippets and AI Chat panels arrive in M5; the region and toggle exist now. */
export function SideBar({ panel }: { panel: "snippets" | "ai" }) {
  return (
    <aside className="side-bar" aria-label={panel === "snippets" ? strings.shell.snippets : strings.shell.aiChat}>
      <h2>{panel === "snippets" ? strings.shell.snippets : strings.shell.aiChat}</h2>
      <p>{strings.shell.sideBarPlaceholder}</p>
    </aside>
  );
}
