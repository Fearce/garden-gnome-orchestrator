import { useEffect, useRef, useState } from "react";
import type { EditorProps } from "./CodeEditor.js";

/** Native editing is predictable on touch keyboards. Keep it independent of the Monaco bundle. */
export function TouchEditor(props: EditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [find, setFind] = useState("");
  useEffect(() => {
    if (!props.line || !ref.current) return;
    const start = props.text.split("\n").slice(0, props.line - 1).join("\n").length + (props.line > 1 ? 1 : 0);
    ref.current.focus(); ref.current.setSelectionRange(start, start);
  }, [props.path, props.line]);
  return <div className="ide-touch-editor">
    <div className="ide-touch-find"><input aria-label="Find in file" placeholder="Find in file" value={find} onChange={e => setFind(e.target.value)} /><button onClick={() => {
      const area = ref.current!; const start = props.text.toLowerCase().indexOf(find.toLowerCase(), area.selectionEnd); const at = start < 0 ? props.text.toLowerCase().indexOf(find.toLowerCase()) : start;
      if (at >= 0 && find) { area.focus(); area.setSelectionRange(at, at + find.length); props.onStatus(`Match at character ${at + 1}`); } else props.onStatus("No match in this file");
    }}>Find next</button></div>
    <textarea ref={ref} aria-label="Code editor" value={props.text} onChange={e => props.onChange(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap={props.settings.wrap ? "soft" : "off"} style={{ fontSize: Math.max(16, props.settings.fontSize) }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); props.onSave(); } }} />
  </div>;
}
