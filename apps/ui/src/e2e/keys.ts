const NAMED_CODES: Record<string, string> = {
  enter: "Enter",
  backspace: "Backspace",
  space: "Space",
  tab: "Tab",
  escape: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  "=": "Equal",
  "-": "Minus",
  "/": "Slash",
  "\\": "Backslash",
  ",": "Comma",
  ".": "Period",
  "[": "BracketLeft",
  "]": "BracketRight",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
};

const MODIFIERS = new Set(["cmd", "ctrl", "alt", "shift"]);

/** "cmd+shift+r" → a KeyboardEvent init keyed by `code`, which is what JSLab's shortcut handling reads. */
export function keyEventInit(spec: string): KeyboardEventInit {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error(`Invalid key: ${spec}`);
  for (const modifier of parts) {
    if (!MODIFIERS.has(modifier)) throw new Error(`Unknown modifier "${modifier}" in ${spec}`);
  }
  let code: string | undefined;
  if (/^[a-z]$/.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
  else if (/^f([1-9]|1[0-2])$/.test(key)) code = key.toUpperCase();
  else code = NAMED_CODES[key];
  if (!code) throw new Error(`Unknown key "${key}" in ${spec}`);
  return {
    code,
    key: key.length === 1 ? key : code,
    metaKey: parts.includes("cmd"),
    ctrlKey: parts.includes("ctrl"),
    altKey: parts.includes("alt"),
    shiftKey: parts.includes("shift"),
    bubbles: true,
    cancelable: true,
  };
}
