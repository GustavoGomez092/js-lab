/**
 * The first-run welcome tab (spec §7.5): "A welcome tab with sample code showing Auto Log, `//?`, logpoints,
 * fetch, and a React snippet."
 *
 * R-M5a-4: the language is `tsx`, because a React snippet is not valid TypeScript, and the `fetch` and React
 * samples ship commented. Nothing on a newly created tab is armed for Auto Run, so nothing executes at launch --
 * but a live `fetch` would make a network call the first time the user pressed Run, out of a demo, and would
 * make the e2e scenario depend on the network. Uncommenting either line is the demonstration.
 *
 * Every instruction below is checked against the shipping app in apps/desktop/test/welcome.test.ts: `Cmd+Shift+F9`
 * is the chord in packages/shared/src/keybindings.ts, and "Browser" is the runtime's own label in the status bar.
 */
export const WELCOME_TITLE = "Welcome";

export const WELCOME_CODE = `// Welcome to JSLab. Code runs as you type — edit anything below.

// 1. Auto Log: the value of each top-level expression appears on its line.
const versions = { app: "JSLab", language: "TypeScript" }
Object.keys(versions)

// 2. Magic comments: end a line with //? to log exactly that statement.
const total = [1, 2, 3, 4].reduce((sum, n) => sum + n, 0) //?

// 3. Logpoints: click the gutter left of a line number, or press F9, to log
//    that line without editing it. Cmd+Shift+F9 clears them all.
const doubled = total * 2

// 4. fetch works here. Uncomment the next line to try it.
// const joke = await fetch("https://api.github.com/zen").then((r) => r.text())

// 5. React: switch the runtime to Browser in the status bar, then uncomment.
function Hello({ name }: { name: string }) {
  return <p>Hello, {name}!</p>
}
// document.body.append(Object.assign(document.createElement("div"), { id: "root" }))
// const { createRoot } = await import("react-dom/client")
// createRoot(document.getElementById("root")!).render(<Hello name="JSLab" />)
`;
