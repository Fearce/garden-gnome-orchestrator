import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/common/services/editorWebWorkerMain.js?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import type { Snippet } from "./snippets.js";

// Monaco 0.56's generic editor worker uses an ESM URL that Vite otherwise copies as a raw
// asset. Make that worker a real bundled entry; language workers already use new Worker URLs.
globalThis.MonacoEnvironment = { getWorker: (_id, label) => {
  if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
  if (label === "json") return new JsonWorker();
  if (["html", "handlebars", "razor"].includes(label)) return new HtmlWorker();
  if (["css", "scss", "less"].includes(label)) return new CssWorker();
  return new EditorWorker();
} };

export const languageFor = (path: string) => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", json: "json", css: "css", scss: "scss", html: "html", md: "markdown", py: "python", rs: "rust", go: "go", yaml: "yaml", yml: "yaml", sh: "shell", ps1: "powershell", sql: "sql", cs: "csharp", cpp: "cpp", h: "cpp", java: "java", xml: "xml", toml: "ini" } as Record<string, string>)[ext] ?? "plaintext";
};
export interface EditorSettings { fontSize: number; wrap: boolean; minimap: boolean }
export interface EditorProps {
  workspace: string; path: string; text: string; settings: EditorSettings; snippets: Snippet[];
  line?: number; onChange: (text: string) => void; onSave: () => void;
  onStatus: (value: string) => void;
  openModels: string[];
}

export function CodeEditor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const models = useRef(new Map<string, { model: monaco.editor.ITextModel; view: monaco.editor.ICodeEditorViewState | null }>());
  const current = useRef<string>("");
  useEffect(() => {
    // Monaco does not resolve CSS custom properties, so the editor reads the console's --font-mono
    // token itself and re-reads it whenever Settings → Appearance swaps the monospace face.
    const monoFace = () => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
    const editor = monaco.editor.create(host.current!, { model: null, automaticLayout: true, theme: "vs-dark", fontFamily: monoFace(), fontSize: 13, scrollBeyondLastLine: false, padding: { top: 12 }, fixedOverflowWidgets: true, tabSize: 2, ariaLabel: "Code editor", renderWhitespace: "selection" });
    instance.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
    const change = editor.onDidChangeModelContent(() => callbacks.current.onChange(editor.getModel()!.getValue(undefined, true)));
    const status = () => {
      const p = editor.getPosition(); const model = editor.getModel();
      const markers = model ? monaco.editor.getModelMarkers({ resource: model.uri }) : [];
      callbacks.current.onStatus(`Ln ${p?.lineNumber ?? 1}, Col ${p?.column ?? 1} · ${markers.filter(m => m.severity === monaco.MarkerSeverity.Error).length} errors`);
    };
    const cursor = editor.onDidChangeCursorPosition(status);
    const markers = monaco.editor.onDidChangeMarkers(status);
    // Convert theme tokens to hex for Monaco; it cannot consume CSS oklch values directly.
    const theme = () => {
      const canvas = document.createElement("canvas").getContext("2d")!;
      const color = (token: string) => { canvas.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(token).trim(); canvas.fillRect(0, 0, 1, 1); return "#" + [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join(""); };
      monaco.editor.defineTheme("ggo", { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": color("--bg-1"), "editor.foreground": color("--text"), "editorLineNumber.foreground": color("--text-faint"), "editorCursor.foreground": color("--accent"), "editor.selectionBackground": color("--bg-3") } });
      monaco.editor.setTheme("ggo");
    };
    const repaint = () => { theme(); editor.updateOptions({ fontFamily: monoFace() }); };
    theme(); const observer = new MutationObserver(repaint); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font-mono"] });
    return () => { observer.disconnect(); change.dispose(); cursor.dispose(); markers.dispose(); editor.dispose(); instance.current = null; models.current.forEach(m => m.model.dispose()); models.current.clear(); };
  }, []);
  useEffect(() => {
    const editor = instance.current!;
    const key = props.workspace + "/" + props.path;
    if (current.current && current.current !== key) { const previous = models.current.get(current.current); if (previous) previous.view = editor.saveViewState(); }
    let entry = models.current.get(key);
    if (!entry) {
      entry = { model: monaco.editor.createModel(props.text, languageFor(props.path), monaco.Uri.parse(`file:///ggo/${key.split("/").map(encodeURIComponent).join("/")}`)), view: null };
      models.current.set(key, entry);
    }
    if (entry.model.getValue(undefined, true) !== props.text) entry.model.setValue(props.text);
    if (current.current !== key) { editor.setModel(entry.model); editor.restoreViewState(entry.view); current.current = key; editor.focus(); }
  }, [props.workspace, props.path, props.text]);
  useEffect(() => {
    const retained = new Set(props.openModels);
    for (const [key, entry] of models.current) if (key !== current.current && !retained.has(key)) { entry.model.dispose(); models.current.delete(key); }
  }, [props.openModels]);
  useEffect(() => { instance.current?.updateOptions({ fontSize: props.settings.fontSize, wordWrap: props.settings.wrap ? "on" : "off", minimap: { enabled: props.settings.minimap } }); }, [props.settings]);
  useEffect(() => { if (props.line) { instance.current?.revealLineInCenter(props.line); instance.current?.setPosition({ lineNumber: props.line, column: 1 }); } }, [props.path, props.line]);
  useEffect(() => {
    // A wildcard provider loses to the built-in language provider's higher selector score.
    // Register at the same specificity so imported snippets participate in real completion.
    const provider = monaco.languages.registerCompletionItemProvider(monaco.languages.getLanguages().map(l => ({ language: l.id })), {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        return { suggestions: props.snippets.filter(s => !s.scope.length || s.scope.includes(model.getLanguageId())).flatMap(s => s.prefixes.map(prefix => ({ label: prefix, detail: s.name, documentation: s.description, kind: monaco.languages.CompletionItemKind.Snippet, insertText: s.body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) }))) };
      },
    });
    return () => provider.dispose();
  }, [props.snippets]);
  return <div ref={host} className="ide-monaco" />;
}
