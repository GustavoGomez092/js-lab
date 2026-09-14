export type WhenContext = Readonly<Record<string, boolean>>;

const IDENTIFIER = /^[A-Za-z][\w.]*$/;

/** A `when` clause: identifiers, `!`, `&&` and `||` (no parentheses). Anything else evaluates to false. */
export function evaluateWhen(expression: string | undefined, context: WhenContext): boolean {
  if (expression === undefined || expression.trim() === "") return true;
  const clauses = expression.split("||");
  // A leading, trailing or doubled `||`/`&&` produces an empty clause or term (e.g. "editorFocus ||" or
  // "&& modalOpen"). Treat the whole expression as malformed and fail closed, rather than letting a valid
  // OR-clause elsewhere make it evaluate true (m-5).
  if (clauses.some((clause) => clause.trim() === "" || clause.split("&&").some((term) => term.trim() === ""))) {
    return false;
  }
  return clauses.some((clause) =>
    clause.split("&&").every((term) => {
      let name = term.trim();
      let negate = false;
      while (name.startsWith("!")) {
        negate = !negate;
        name = name.slice(1).trim();
      }
      if (!IDENTIFIER.test(name) || !Object.hasOwn(context, name)) return false;
      return negate ? !context[name] : Boolean(context[name]);
    }),
  );
}
