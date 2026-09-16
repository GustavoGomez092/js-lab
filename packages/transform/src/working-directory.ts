import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkingDirectoryOptions } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: Babel plugin API
type Any = any;

/** `.`, `..`, `./…` and `../…` are relative, as in Node and Bun. */
const isRelative = (value: string) =>
  value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");

/** Spec §5.3: relative specifiers and the WD globals resolve against the tab's working directory. */
export function createWorkingDirectoryPlugin(wd: WorkingDirectoryOptions) {
  // A `?query` or `#hash` suffix is kept as written: only the path part before it is resolved (N-6).
  const rewrite = (value: string) => {
    if (!isRelative(value)) return value;
    const cut = value.search(/[?#]/);
    if (cut < 0) return resolve(wd.dir, value);
    return `${resolve(wd.dir, value.slice(0, cut))}${value.slice(cut)}`;
  };
  const metaValues: Record<string, string> = {
    dir: wd.dir,
    dirname: wd.dir,
    path: wd.filename,
    filename: wd.filename,
    url: pathToFileURL(wd.filename).href,
  };
  return (api: Any) => {
    const t = api.types;
    /** Replaces a node with a string literal that keeps its source location (N-1). */
    const replaceWithString = (path: Any, value: string) =>
      path.replaceWith(t.inherits(t.stringLiteral(value), path.node));
    /** Rewrites a specifier: a string literal, or a template literal with no substitutions (M-2). */
    const rewriteSource = (source: Any) => {
      const node = source?.node;
      if (node?.type === "StringLiteral") {
        node.value = rewrite(node.value);
        return;
      }
      if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
        const cooked = node.quasis[0]?.value.cooked;
        if (typeof cooked === "string" && isRelative(cooked)) replaceWithString(source, rewrite(cooked));
      }
    };
    const isFree = (path: Any, name: string) => !path.scope.hasBinding(name, { noGlobals: true });
    const isAssignmentTarget = (path: Any) =>
      (path.parentPath?.isAssignmentExpression() && path.parent.left === path.node) ||
      path.parentPath?.isUpdateExpression() ||
      (path.parentPath?.isForXStatement() && path.key === "left");
    return {
      name: "jslab-working-directory",
      visitor: {
        ImportDeclaration(path: Any) {
          rewriteSource(path.get("source"));
        },
        ExportNamedDeclaration(path: Any) {
          rewriteSource(path.get("source"));
        },
        ExportAllDeclaration(path: Any) {
          rewriteSource(path.get("source"));
        },
        ImportExpression(path: Any) {
          rewriteSource(path.get("source"));
        },
        CallExpression(path: Any) {
          const { callee } = path.node;
          if (path.node.arguments.length === 0) return;
          const first = path.get("arguments.0");
          if (callee.type === "Import") return rewriteSource(first);
          if (callee.type === "Identifier" && callee.name === "require" && isFree(path, "require"))
            return rewriteSource(first);
          if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.object.type === "Identifier" &&
            callee.object.name === "require" &&
            callee.property.type === "Identifier" &&
            callee.property.name === "resolve" &&
            isFree(path, "require")
          ) {
            rewriteSource(first);
          }
        },
        Identifier(path: Any) {
          const { name } = path.node;
          if (name !== "__dirname" && name !== "__filename") return;
          if (!path.isReferencedIdentifier() || isAssignmentTarget(path) || !isFree(path, name)) return;
          replaceWithString(path, name === "__dirname" ? wd.dir : wd.filename);
        },
        MemberExpression(path: Any) {
          const { object, property, computed } = path.node;
          if (computed || property.type !== "Identifier" || isAssignmentTarget(path)) return;
          if (object.type === "MetaProperty" && object.meta.name === "import" && object.property.name === "meta") {
            const value = metaValues[property.name];
            if (value !== undefined) replaceWithString(path, value);
            return;
          }
          if (object.type === "Identifier" && object.name === "module" && isFree(path, "module")) {
            if (property.name === "filename") replaceWithString(path, wd.filename);
            else if (property.name === "path") replaceWithString(path, wd.dir);
          }
        },
      },
    };
  };
}
