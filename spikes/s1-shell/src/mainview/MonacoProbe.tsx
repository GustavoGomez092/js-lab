import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import { useEffect, useRef } from "react";
import { rpc } from "./rpc";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker();
  },
};

export function MonacoProbe() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    monaco.typescript.typescriptDefaults.addExtraLib("declare const fromExtraLib: { hello: string };", "file:///extra.d.ts");
    const model = monaco.editor.createModel(
      'const x: number = "a";\n[1, 2].ma\nfromExtraLib.hello',
      "typescript",
      monaco.Uri.parse("file:///tab/probe.ts"),
    );
    const editor = monaco.editor.create(host.current, { model, theme: "vs-dark", automaticLayout: true });
    const timer = setTimeout(async () => {
      const markers = monaco.editor.getModelMarkers({ resource: model.uri });
      const getWorker = await monaco.typescript.getTypeScriptWorker();
      const client = await getWorker(model.uri);
      const completions = await client.getCompletionsAtPosition(model.uri.toString(), model.getOffsetAt({ lineNumber: 2, column: 10 }));
      rpc.send.viewReport({
        section: "S2",
        data: {
          location: location.href,
          markerMessages: markers.map((m) => m.message),
          completionHasMap: Boolean(completions?.entries.some((e: { name: string }) => e.name === "map")),
        },
      });
    }, 4000);
    return () => {
      clearTimeout(timer);
      editor.dispose();
      model.dispose();
    };
  }, []);
  return <div ref={host} style={{ height: 240, border: "1px solid #444" }} />;
}
