import type { Diagnostic, TransformOptions } from "./types";

// Babel's plugin API is untyped in @babel/standalone; keep `any` confined to this file.
// biome-ignore lint/suspicious/noExplicitAny: Babel plugin API
type Any = any;

interface Marker {
  kind: "line" | "block";
  source: "magic" | "logpoint";
  line: number;
  column: number;
  start: number;
  end: number;
  expression: string | null;
}

interface Target {
  marker: Marker;
  path: Any;
  mode: "statement" | "head" | "expression";
}

const LOGGABLE = new Set(["ExpressionStatement", "VariableDeclaration", "ReturnStatement", "ThrowStatement"]);
const BLOCK_HEADS = new Set(["IfStatement", "WhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);
const LINE_HEADS = new Set([...BLOCK_HEADS, "DoWhileStatement"]);
const DIRECTIVES_NOT_LOGGED = new Set(["use strict", "use asm", "use client", "use server"]);

export function parseMarkers(
  comments: ReadonlyArray<{ type: string; value: string; start: number; end: number; loc: Any }>,
  logpoints: readonly number[],
): Marker[] {
  const markers: Marker[] = [];
  for (const c of comments) {
    const match = c.type === "CommentLine" ? /^\s?\?(.*)$/.exec(c.value) : /^\s*\?(.*?)\s*$/s.exec(c.value);
    if (!match) continue;
    markers.push({
      kind: c.type === "CommentLine" ? "line" : "block",
      source: "magic",
      line: c.loc.start.line,
      column: c.loc.start.column + 1,
      start: c.start,
      end: c.end,
      expression: match[1]?.trim() || null,
    });
  }
  const magicLines = new Set(markers.filter((m) => m.kind === "line").map((m) => m.line));
  for (const line of new Set(logpoints)) {
    if (magicLines.has(line)) continue;
    markers.push({ kind: "line", source: "logpoint", line, column: 1, start: -1, end: -1, expression: null });
  }
  return markers;
}

export function createInstrumentPlugin(options: TransformOptions, source: string, diagnostics: Diagnostic[]) {
  return (api: Any) => {
    const t = api.types;
    const template = api.template;

    const jl = (method: "log" | "mc") => t.memberExpression(t.identifier("__jl"), t.identifier(method));
    const span = (node: Any) => node.end - node.start;

    const warn = (code: Diagnostic["code"], message: string, marker: Marker) => {
      diagnostics.push({ severity: "warning", code, message, line: marker.line, column: marker.column });
    };

    const formatterFor = (marker: Marker) => {
      if (!marker.expression) return null;
      try {
        return t.arrowFunctionExpression([t.identifier("$")], template.expression.ast(marker.expression));
      } catch {
        warn("magic-comment-invalid-expression", `Invalid magic comment expression: ${marker.expression}`, marker);
        return null;
      }
    };

    const mc = (marker: Marker, expression: Any) => {
      const formatter = formatterFor(marker);
      const args = [t.numericLiteral(marker.line), t.numericLiteral(marker.column), expression];
      if (formatter) args.push(formatter);
      return t.callExpression(jl("mc"), args);
    };

    const bindingsValue = (node: Any) => {
      if (t.isMemberExpression(node)) return t.cloneNode(node);
      const names = Object.keys(t.getBindingIdentifiers(node));
      if (names.length === 1) return t.identifier(names[0]);
      return t.objectExpression(names.map((n) => t.objectProperty(t.identifier(n), t.identifier(n), false, true)));
    };

    const noValue = (marker: Marker) =>
      marker.source === "logpoint"
        ? warn("logpoint-no-value", "Logpoint has no value to log on this line", marker)
        : warn("magic-comment-no-value", "Magic comment has no value to log", marker);

    return {
      name: "jslab-instrument",
      visitor: {
        Program: {
          enter(program: Any, state: Any) {
            // Check for __jl binding in program scope first
            let jlBinding: Any = null;
            const programBinding = program.scope.getOwnBinding("__jl");
            if (programBinding) {
              jlBinding = programBinding;
            }

            // Check for __jl binding in any nested scope
            if (!jlBinding) {
              program.traverse({
                Scopable(path: Any) {
                  if (jlBinding) return;
                  const binding = path.scope.getOwnBinding("__jl");
                  if (binding) {
                    jlBinding = binding;
                    path.stop();
                  }
                },
              });
            }

            if (jlBinding) {
              const error = new Error("`__jl` is reserved by JSLab") as Error & Any;
              error.loc = jlBinding.identifier?.loc?.start ?? { line: 1, column: 0 };
              error.jslabCode = "reserved-identifier";
              throw error;
            }

            const markers = parseMarkers(state.file.ast.comments ?? [], options.logpoints);
            const handled = new WeakSet<object>();

            if (markers.length > 0) {
              const statements: Any[] = [];
              const expressions: Any[] = [];
              program.traverse({
                Statement(p: Any) {
                  const type = p.node.type;
                  if (!LOGGABLE.has(type) && !LINE_HEADS.has(type)) return;
                  if (type === "VariableDeclaration" && (p.key === "init" || p.key === "left" || p.node.declare))
                    return;
                  statements.push(p);
                },
                Expression(p: Any) {
                  if (p.parentPath.isVariableDeclarator() && p.key === "id") return;
                  if (p.key === "left" && (p.parentPath.isAssignmentExpression() || p.parentPath.isForXStatement()))
                    return;
                  if (p.parentPath.isUpdateExpression()) return;
                  if (p.parentPath.isMemberExpression() && p.key === "property" && !p.parent.computed) return;
                  if (p.parentPath.isObjectProperty() && p.key === "key") return;
                  expressions.push(p);
                },
              });

              const targets: Target[] = [];
              for (const marker of markers) {
                const target =
                  marker.kind === "line"
                    ? resolveLineMarker(marker, statements)
                    : resolveBlockMarker(marker, statements, expressions, source);
                if (target) targets.push(target);
                else noValue(marker);
              }

              // Innermost/last targets first so earlier paths never go stale.
              targets.sort((a, b) => b.path.node.start - a.path.node.start || span(a.path.node) - span(b.path.node));

              for (const { marker, path, mode } of targets) {
                if (mode === "expression") {
                  path.replaceWith(mc(marker, path.node));
                  continue;
                }
                if (mode === "head") {
                  applyHead(marker, path);
                  continue;
                }
                const node = path.node;
                switch (node.type) {
                  case "ExpressionStatement":
                    node.expression = mc(marker, node.expression);
                    handled.add(node);
                    break;
                  case "ReturnStatement":
                  case "ThrowStatement":
                    if (node.argument) node.argument = mc(marker, node.argument);
                    else noValue(marker);
                    break;
                  case "VariableDeclaration": {
                    const anchor = path.parentPath.isExportNamedDeclaration() ? path.parentPath : path;
                    anchor.insertAfter(t.expressionStatement(mc(marker, bindingsValue(node))));
                    break;
                  }
                  default:
                    applyHead(marker, path);
                }
              }
            }

            if (options.autoLog) {
              const directiveLogs = program.node.directives
                .filter((d: Any) => !DIRECTIVES_NOT_LOGGED.has(d.value.value))
                .map((d: Any) =>
                  t.expressionStatement(
                    t.callExpression(jl("log"), [t.numericLiteral(d.loc.start.line), t.stringLiteral(d.value.value)]),
                  ),
                );
              for (const stmt of program.get("body")) {
                if (!stmt.isExpressionStatement() || handled.has(stmt.node)) continue;
                const expression = stmt.node.expression;
                if (t.isAssignmentExpression(expression) || t.isUpdateExpression(expression)) continue;
                if (isCallOn(t, expression, "console") || isCallOn(t, expression, "__jl")) continue;
                stmt.node.expression = t.callExpression(jl("log"), [
                  t.numericLiteral(stmt.node.loc.start.line),
                  expression,
                ]);
              }
              if (directiveLogs.length > 0) program.unshiftContainer("body", directiveLogs);
            }

            if (options.loopProtection) {
              const max = options.loopProtectionMaxIterations;
              const seen = new WeakSet<object>();
              program.traverse({
                Loop(loop: Any) {
                  if (seen.has(loop.node)) return;
                  seen.add(loop.node);
                  const line = loop.node.loc?.start.line ?? 0;
                  const counter = loop.scope.generateUidIdentifier("jlLoop");
                  const guard = t.ifStatement(
                    t.binaryExpression(
                      ">",
                      t.updateExpression("++", t.cloneNode(counter), true),
                      t.numericLiteral(max),
                    ),
                    t.throwStatement(
                      t.newExpression(t.identifier("RangeError"), [
                        t.stringLiteral(
                          `Potential infinite loop: exceeded ${max} iterations (line ${line}). Disable Loop Protection or raise the limit in Settings → Advanced.`,
                        ),
                      ]),
                    ),
                  );
                  const body = loop.get("body");
                  if (body.isBlockStatement()) body.unshiftContainer("body", guard);
                  else body.replaceWith(t.blockStatement([guard, body.node]));
                  let anchor = loop;
                  while (anchor.parentPath?.isLabeledStatement()) anchor = anchor.parentPath;
                  anchor.insertBefore(
                    t.variableDeclaration("let", [t.variableDeclarator(counter, t.numericLiteral(0))]),
                  );
                },
              });
            }

            function applyHead(marker: Marker, path: Any) {
              const node = path.node;
              switch (node.type) {
                case "IfStatement":
                case "WhileStatement":
                case "DoWhileStatement":
                  node.test = mc(marker, node.test);
                  return;
                case "ForStatement":
                  if (node.test) node.test = mc(marker, node.test);
                  else noValue(marker);
                  return;
                case "ForInStatement":
                case "ForOfStatement": {
                  const log = t.expressionStatement(mc(marker, bindingsValue(node.left)));
                  const body = path.get("body");
                  if (body.isBlockStatement()) body.unshiftContainer("body", log);
                  else body.replaceWith(t.blockStatement([log, body.node]));
                  return;
                }
                default:
                  noValue(marker);
              }
            }
          },
        },
      },
    };
  };
}

function isCallOn(t: Any, expression: Any, objectName: string): boolean {
  return (
    t.isCallExpression(expression) &&
    t.isMemberExpression(expression.callee) &&
    t.isIdentifier(expression.callee.object, { name: objectName })
  );
}

function resolveLineMarker(marker: Marker, statements: Any[]): Target | null {
  const bySpanDesc = (a: Any, b: Any) => b.node.end - b.node.start - (a.node.end - a.node.start);
  if (marker.source === "magic") {
    const loggable = statements
      .filter((p) => LOGGABLE.has(p.node.type) && p.node.loc.end.line === marker.line && p.node.end <= marker.start)
      .sort(bySpanDesc);
    return loggable[0] ? { marker, path: loggable[0], mode: "statement" } : null;
  }
  const starting = statements.filter((p) => p.node.loc.start.line === marker.line);
  const loggable = starting.filter((p) => LOGGABLE.has(p.node.type)).sort(bySpanDesc);
  if (loggable[0]) return { marker, path: loggable[0], mode: "statement" };
  const heads = starting.filter((p) => LINE_HEADS.has(p.node.type)).sort(bySpanDesc);
  return heads[0] ? { marker, path: heads[0], mode: "head" } : null;
}

function resolveBlockMarker(marker: Marker, statements: Any[], expressions: Any[], source: string): Target | null {
  for (const p of statements) {
    const node = p.node;
    if (!BLOCK_HEADS.has(node.type)) continue;
    const body = node.type === "IfStatement" ? node.consequent : node.body;
    const headEnd =
      node.type === "ForStatement"
        ? ((node.update ?? node.test ?? node.init)?.end ?? node.start)
        : node.type === "ForInStatement" || node.type === "ForOfStatement"
          ? node.right.end
          : node.test.end;
    if (marker.start >= headEnd && marker.end <= body.start) return { marker, path: p, mode: "head" };
  }
  let before = marker.start - 1;
  while (before >= 0 && /\s/.test(source[before] ?? "")) before--;
  const end = before + 1;
  const candidates = expressions
    .filter((p) => p.node.end === end && p.node.start < marker.start)
    .sort((a, b) => a.node.start - b.node.start);
  return candidates[0] ? { marker, path: candidates[0], mode: "expression" } : null;
}
