import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkingDirectoryOptions } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: Babel plugin API
type Any = any;

/** Spec §5.3: relative specifiers and the WD globals resolve against the tab's working directory. */
export function createWorkingDirectoryPlugin(wd: WorkingDirectoryOptions) {
  const rewrite = (value: string) =>
    value.startsWith("./") || value.startsWith("../") ? resolve(wd.dir, value) : value;
  const metaValues: Record<string, string> = {
    dir: wd.dir,
    dirname: wd.dir,
    path: wd.filename,
    filename: wd.filename,
    url: pathToFileURL(wd.filename).href,
  };
  return (api: Any) => {
    const t = api.types;
    const rewriteSource = (node: Any) => {
      if (node?.type === "StringLiteral") node.value = rewrite(node.value);
    };
    const isFree = (path: Any, name: string) => !path.scope.hasBinding(name, { noGlobals: true });
    const isAssignmentTarget = (path: Any) =>
      (path.parentPath?.isAssignmentExpression() && path.parent.left === path.node) ||
      path.parentPath?.isUpdateExpression();
    return {
      name: "jslab-working-directory",
      visitor: {
        ImportDeclaration(path: Any) {
          rewriteSource(path.node.source);
        },
        ExportNamedDeclaration(path: Any) {
          rewriteSource(path.node.source);
        },
        ExportAllDeclaration(path: Any) {
          rewriteSource(path.node.source);
        },
        ImportExpression(path: Any) {
          rewriteSource(path.node.source);
        },
        CallExpression(path: Any) {
          const { callee } = path.node;
          const first = path.node.arguments[0];
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
          path.replaceWith(t.stringLiteral(name === "__dirname" ? wd.dir : wd.filename));
        },
        MemberExpression(path: Any) {
          const { object, property, computed } = path.node;
          if (computed || property.type !== "Identifier" || isAssignmentTarget(path)) return;
          if (object.type === "MetaProperty" && object.meta.name === "import" && object.property.name === "meta") {
            const value = metaValues[property.name];
            if (value !== undefined) path.replaceWith(t.stringLiteral(value));
            return;
          }
          if (object.type === "Identifier" && object.name === "module" && isFree(path, "module")) {
            if (property.name === "filename") path.replaceWith(t.stringLiteral(wd.filename));
            else if (property.name === "path") path.replaceWith(t.stringLiteral(wd.dir));
          }
        },
      },
    };
  };
}
