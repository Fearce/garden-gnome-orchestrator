import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useStore } from "../../store.js";
import { ideApi, cachedIde, invalidateIde, type Entry, type FileData, type SearchHit, type Workspace } from "./api.js";
import { parseSnippets, type Snippet } from "./snippets.js";
import { readSnippetVsix, snippetSource } from "./vsix.js";
import type { EditorSettings } from "./CodeEditor.js";
import "./ide.css";

const CodeEditor = lazy(() => import("./CodeEditor.js").then(m => ({ default: m.CodeEditor })));
const TouchEditor = lazy(() => import("./TouchEditor.js").then(m => ({ default: m.TouchEditor })));
const GitWorkspace = lazy(() => import("../GitConsole.js").then(m => ({ default: m.GitWorkspace })));
interface Tab { workspace: string; path: string; text: string; base: string; version: string | null; line?: number }
const keyOf = (t: Pick<Tab, "workspace" | "path">) => `${t.workspace}:${t.path}`;
const dirty = (t: Tab) => t.text !== t.base || t.version === null;
const DRAFT_KEY = "ggo-ide-drafts-v1";
function restored(): Tab[] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((t): t is Tab => t && typeof t.workspace === "string" && typeof t.path === "string" && typeof t.text === "string" && typeof t.base === "string" && (typeof t.version === "string" || t.version === null)).slice(0, 30);
  } catch { return []; }
}
function getSettings(): EditorSettings {
  try { const s = JSON.parse(localStorage.getItem("ggo-ide-settings") ?? "{}"); return { fontSize: Math.max(11, Math.min(24, Number(s.fontSize) || 13)), wrap: s.wrap !== false, minimap: s.minimap === true }; }
  catch { return { fontSize: 13, wrap: true, minimap: false }; }
}

export function Ide() {
  const boardView = useStore(s => s.boardView);
  const selectedTask = useStore(s => s.selectedThreadId);
  const selectTask = useStore(s => s.select);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [tabs, setTabs] = useState<Tab[]>(restored);
  const [active, setActive] = useState<string | null>(null);
  const [mode, setMode] = useState<"files" | "search" | "git" | "extensions">("files");
  const [gitOpened, setGitOpened] = useState(false);
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const [sidebar, setSidebar] = useState(true);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [compare, setCompare] = useState<FileData | null>(null);
  const [settings, setSettings] = useState(getSettings);
  const [snippets, setSnippets] = useState<Snippet[]>(() => { try { return parseSnippets(localStorage.getItem("ggo-ide-snippets") ?? "{}"); } catch { return []; } });
  const [extensionInfo, setExtensionInfo] = useState(() => { try { return localStorage.getItem("ggo-ide-snippet-source") ?? ""; } catch { return ""; } });
  const [repo, setRepo] = useState<{ path: string | null; prefix: string }>({ path: null, prefix: "" });
  const [touch, setTouch] = useState(() => matchMedia("(pointer: coarse), (max-width: 600px)").matches);
  const tab = tabs.find(t => keyOf(t) === active && t.workspace === workspace);
  const currentWorkspace = workspaces.find(w => w.id === workspace);
  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    const abort = new AbortController();
    ideApi<Workspace[]>("workspaces", {}, undefined, abort.signal).then(ws => {
      setWorkspaces(ws);
      const preferred = ws.find(w => w.tasks.some(t => t.id === selectedTask)) ?? ws.find(w => tabs.some(t => t.workspace === w.id)) ?? ws[0];
      if (preferred) { setWorkspace(preferred.id); const first = tabs.find(t => t.workspace === preferred.id); if (first) setActive(keyOf(first)); }
    }).catch(e => { if (e.name !== "AbortError") report(e); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!workspace) return;
    const abort = new AbortController(); setRepo(cachedIde<typeof repo>("repo", { workspace }) ?? { path: null, prefix: "" });
    ideApi<typeof repo>("repo", { workspace }, undefined, abort.signal).then(value => { setRepo(value); if (value.path) useStore.getState().loadRepoState(value.path); }).catch(e => { if (e.name !== "AbortError") report(e); });
    return () => abort.abort();
  }, [workspace]);
  useEffect(() => {
    const mq = matchMedia("(pointer: coarse), (max-width: 600px)");
    const update = () => setTouch(mq.matches); mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const changed = () => { invalidateIde(); setRevision(r => r + 1); };
    window.addEventListener("ggo:repo-changed", changed);
    return () => window.removeEventListener("ggo:repo-changed", changed);
  }, []);
  useEffect(() => {
    const changed = tabs.filter(dirty);
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(changed)); }
    catch { setError("Draft recovery storage is full or unavailable. Keep this tab open and save your files."); }
    const leave = (e: BeforeUnloadEvent) => { if (changed.length) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [tabs]);
  useEffect(() => { try { localStorage.setItem("ggo-ide-settings", JSON.stringify(settings)); } catch { setError("Editor settings could not be stored in this browser."); } }, [settings]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (useStore.getState().boardView !== "ide") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); setMode("search"); setSidebar(true); }
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, []);

  const openFile = async (path: string, line?: number) => {
    const ws = workspace;
    const key = keyOf({ workspace: ws, path });
    setError(""); setCompare(null);
    if (tabs.some(t => keyOf(t) === key)) { setActive(key); setTabs(ts => ts.map(t => keyOf(t) === key ? { ...t, line } : t)); if (touch) setSidebar(false); return; }
    if (tabs.length >= 30) { setError("Close a tab before opening another (30-tab limit)."); return; }
    try {
      const file = await ideApi<FileData>("file", { workspace: ws, path });
      setTabs(ts => ts.some(t => keyOf(t) === key) || ts.length >= 30 ? ts : [...ts, { workspace: ws, ...file, base: file.text, line }]);
      if (workspaceRef.current === ws) { setActive(key); if (touch) setSidebar(false); }
    } catch (e) { report(e); }
  };
  const save = async () => {
    if (!tab || savingRef.current || !dirty(tab)) return;
    savingRef.current = true; setSaving(true); setError("");
    const savingTab = tab;
    try {
      const file = await ideApi<FileData>("file", {}, { workspace: tab.workspace, path: tab.path, text: tab.text, version: tab.version });
      setTabs(ts => ts.map(t => keyOf(t) === keyOf(savingTab) ? { ...t, base: file.text, version: file.version } : t));
      setStatus(`Saved ${tab.path}`); setRevision(r => r + 1); setCompare(null);
      if (repo.path) useStore.getState().loadRepoState(repo.path);
    } catch (e) { report(e); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const close = (t: Tab) => {
    if (saving || (dirty(t) && !window.confirm(`Discard the unsaved draft of ${t.path}? The disk file will stay as it is.`))) return;
    setTabs(ts => ts.filter(x => keyOf(x) !== keyOf(t)));
    if (active === keyOf(t)) setActive(tabs.find(x => x.workspace === workspace && keyOf(x) !== keyOf(t)) ? keyOf(tabs.find(x => x.workspace === workspace && keyOf(x) !== keyOf(t))!) : null);
    setCompare(null);
  };
  const reload = async () => {
    if (!tab || saving || (dirty(tab) && !window.confirm(`Discard your unsaved draft of ${tab.path} and load the disk version?`))) return;
    try { const file = await ideApi<FileData>("file", { workspace, path: tab.path }, undefined, undefined, true); setTabs(ts => ts.map(t => keyOf(t) === keyOf(tab) ? { ...t, ...file, base: file.text } : t)); setCompare(null); setError(""); } catch (e) { report(e); }
  };
  const create = () => {
    const path = window.prompt("New file path relative to this workspace (parent folder must exist):");
    if (!path) return;
    const key = keyOf({ workspace, path });
    if (tabs.some(t => keyOf(t) === key)) { setActive(key); return; }
    if (tabs.length >= 30) { setError("Close a tab before creating another file."); return; }
    setTabs(ts => [...ts, { workspace, path, text: "", base: "", version: null }]); setActive(key); setMode("files"); if (touch) setSidebar(false);
  };
  const editorProps = tab ? { workspace, path: tab.path, text: tab.text, line: tab.line, settings, snippets, openModels: tabs.map(t => `${t.workspace}/${t.path}`), onSave: () => { void save(); }, onStatus: setStatus, onChange: (text: string) => setTabs(ts => ts.map(t => keyOf(t) === keyOf(tab) ? { ...t, text } : t)) } : null;

  return <section className="ide" aria-label="Development workspace">
    <div className="ide-toolbar">
      <select aria-label="IDE workspace" value={workspace} disabled={saving} onChange={e => { setWorkspace(e.target.value); const t = tabs.find(t => t.workspace === e.target.value); setActive(t ? keyOf(t) : null); setCompare(null); setError(""); }}>
        {!workspaces.length && <option value="">Loading workspaces…</option>}
        {workspaces.map(w => <option value={w.id} key={w.id}>{w.name} — {w.path}</option>)}
      </select>
      <button onClick={() => setSidebar(s => !s)} aria-expanded={sidebar}>Explorer</button>
      <button onClick={create} disabled={!workspace || saving}>New file</button>
      <button className="ide-save" disabled={!tab || !dirty(tab) || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
    </div>
    <nav className="ide-modes" aria-label="IDE tools">
      {([ ["files", "Files"], ["search", "Search"], ["git", "Source control"], ["extensions", "Extensions & editor"] ] as const).map(([value, label]) => <button key={value} aria-pressed={mode === value} onClick={() => { setMode(value); if (value === "git") setGitOpened(true); setSidebar(true); }}>{label}</button>)}
    </nav>
    {error && <div className="ide-error" role="alert">{error}<button aria-label="Dismiss IDE error" onClick={() => setError("")}>×</button></div>}
    {gitOpened && <div className="ide-git" hidden={mode !== "git"}><Suspense fallback={<p>Opening source control…</p>}>
      {repo.path ? <GitWorkspace key={workspace} visible={mode === "git" && boardView === "ide"} workspace={workspace} path={repo.path} onOpenFile={p => { setMode("files"); void openFile([repo.prefix, p].filter(Boolean).join("/")); }} hasDrafts={tabs.some(t => t.workspace === workspace && dirty(t))} /> : <div className="ide-welcome"><h3>No repository in this workspace</h3><p>Choose a workspace containing a Git checkout to use source control.</p></div>}
    </Suspense></div>}<div className="ide-preferences" hidden={mode !== "extensions"}>
      <h3>Editor & extensions</h3><p>Monaco powers desktop editing, with completion and diagnostics for JavaScript, TypeScript, JSON, HTML and CSS. Other bundled languages have syntax highlighting. Language analysis covers open files; project builds and language servers run outside GGO.</p>
      <div className="ide-setting"><label>Font size <input type="number" min={11} max={24} value={settings.fontSize} onChange={e => setSettings(s => ({ ...s, fontSize: Math.max(11, Math.min(24, Number(e.target.value) || 13)) }))} /></label><label><input type="checkbox" checked={settings.wrap} onChange={e => setSettings(s => ({ ...s, wrap: e.target.checked }))} /> Word wrap</label><label><input type="checkbox" checked={settings.minimap} onChange={e => setSettings(s => ({ ...s, minimap: e.target.checked }))} /> Minimap</label></div>
      <h3>VS Code snippets</h3><p>Import a .code-snippets or language snippet JSON file. Prefixes, scopes, tab stops and placeholders work in desktop completion (Ctrl+Space). Imported snippets stay in this browser. A language file without a scope applies to all languages.</p>
      <label className="ide-import">Import snippets <input type="file" accept=".json,.code-snippets" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { if (file.size > 200_000) throw new Error("Snippet file must be under 200 KB."); const source = await file.text(); const parsed = parseSnippets(source); localStorage.setItem("ggo-ide-snippets", source); localStorage.removeItem("ggo-ide-snippet-source"); setExtensionInfo(""); setSnippets(parsed); setStatus(`Imported ${parsed.length} snippets`); setError(""); } catch (err) { report(err); } e.target.value = ""; }} /></label>
      <h3>Snippet extensions (.vsix)</h3><p>Import an extension package to use its declared snippet contributions. GGO honors each contribution’s language. Other features are listed as unsupported. Import replaces the current snippet collection.</p>
      <label className="ide-vsix-import">Import VSIX <input type="file" accept=".vsix" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try {
        if (file.size > 5 * 1024 * 1024) throw new Error("VSIX packages must be under 5 MB.");
        const extension = readSnippetVsix(new Uint8Array(await file.arrayBuffer()));
        const info = `${extension.id} ${extension.version} · License: ${extension.license}${extension.ignored.length ? ` · Unsupported: ${extension.ignored.join(", ")}` : " · Snippet contributions supported"}`;
        localStorage.setItem("ggo-ide-snippets", snippetSource(extension.snippets)); localStorage.setItem("ggo-ide-snippet-source", info); setSnippets(extension.snippets); setExtensionInfo(info); setStatus(`Imported ${extension.snippets.length} extension snippets`); setError("");
      } catch (err) { report(err); } e.target.value = ""; }} /></label>
      {extensionInfo && <p className="ide-extension-info">{extensionInfo}</p>}
      <p>{snippets.length} snippets installed {snippets.length > 0 && <button onClick={() => { try { localStorage.removeItem("ggo-ide-snippets"); localStorage.removeItem("ggo-ide-snippet-source"); setSnippets([]); setExtensionInfo(""); } catch (e) { report(e); } }}>Remove snippets</button>}</p>
      {snippets.map((s, i) => <div className="ide-snippet" key={`${s.name}:${i}`}><b>{s.name}</b><code>{s.prefixes.join(", ")}</code><span>{s.scope.join(", ") || "All languages"}</span></div>)}
      <h3>Compatibility</h3><p>Only declarative snippet contributions are supported; there is no VS Code extension host. Marketplace installation, executable extensions, themes, grammars, terminals and debuggers are not supported. No extension code is executed. Touch screens use native text editing with find and save; completion and snippets require the desktop editor.</p>
      <p>GGO themes style the editor automatically. Ctrl+P finds files; Ctrl+S saves; Ctrl+F finds or replaces within the desktop editor. Drafts survive navigation and reloads in this browser tab. Save before closing the tab.</p>
    </div><div hidden={mode === "git" || mode === "extensions"} className={"ide-body" + (sidebar ? " has-sidebar" : "")}>
      <aside hidden={!sidebar} className="ide-sidebar" aria-label={mode === "search" ? "Workspace search" : "File explorer"}>
        <div hidden={mode !== "search"}><Search revision={revision} workspace={workspace} onOpen={openFile} onError={report} /></div><div hidden={mode === "search"}><div className="ide-side-head"><span>{currentWorkspace?.name ?? "Files"}</span><button aria-label="Refresh files" onClick={() => { invalidateIde(workspace); setRevision(r => r + 1); }}>↻</button></div>{workspace && <FileTree key={workspace} revision={revision} workspace={workspace} path="" onOpen={openFile} onError={report} />}</div>
        {!!currentWorkspace?.tasks.length && <details className="ide-tasks"><summary>Workspace tasks ({currentWorkspace.tasks.length})</summary>{currentWorkspace.tasks.slice(0, 30).map(t => <button key={t.id} onClick={() => selectTask(t.id)}>{t.title}</button>)}</details>}
      </aside>
      <div className="ide-editor-area">
        <div className="ide-tabs" role="tablist" aria-label="Open files">{tabs.filter(t => t.workspace === workspace).map(t => <div className={"ide-tab" + (active === keyOf(t) ? " active" : "")} key={keyOf(t)}><button role="tab" aria-selected={active === keyOf(t)} title={t.path} onClick={() => { setActive(keyOf(t)); setCompare(null); }}>{dirty(t) ? "● " : ""}{t.path.split("/").pop()}</button><button aria-label={`Close ${t.path}`} onClick={() => close(t)}>×</button></div>)}</div>
        {tab && <div className="ide-breadcrumb"><span title={tab.path}>{tab.path}</span><button disabled={saving || tab.version === null} onClick={() => void reload()}>Reload</button><button disabled={tab.version === null} onClick={() => void ideApi<FileData>("file", { workspace, path: tab.path }, undefined, undefined, true).then(setCompare).catch(report)}>Compare disk</button></div>}
        {compare && tab ? <div className="ide-compare"><div><h4>Your draft</h4><pre>{tab.text}</pre></div><div><h4>Current disk version</h4><pre>{compare.text}</pre></div><button onClick={() => setCompare(null)}>Back to editor</button></div> : editorProps ? <Suspense fallback={<div className="ide-welcome">Loading editor…</div>}>{touch ? <TouchEditor {...editorProps} /> : <CodeEditor {...editorProps} />}</Suspense> : <div className="ide-welcome"><span className="ide-watermark">{`{ }`}</span><h3>Your development workspace</h3><p>Open a file from the explorer or search the project.</p><div><kbd>Ctrl P</kbd> Find a file <kbd>Ctrl S</kbd> Save</div><p className="faint">UTF-8 text · 2 MB per file · Safe saves</p></div>}
      </div>
    </div>
    <footer className="ide-status" role="status"><span>{status}</span><span>{tabs.filter(dirty).length} unsaved{touch ? " · Touch text editor" : " · UTF-8"}</span></footer>
  </section>;
}

function FileTree({ workspace, path, revision, onOpen, onError }: { revision: number; workspace: string; path: string; onOpen: (path: string) => void; onError: (e: unknown) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(() => cachedIde<{ entries: Entry[] }>("tree", { workspace, path })?.entries ?? null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    ideApi<{ entries: Entry[]; truncated: boolean }>("tree", { workspace, path }, undefined, abort.signal).then(r => { setEntries(r.entries); setTruncated(r.truncated); }).catch(e => { if (e.name !== "AbortError") { onError(e); setEntries([]); } });
    return () => abort.abort();
  }, [workspace, path, revision]);
  return <ul className="ide-tree">{entries === null ? <li className="faint">Loading…</li> : !entries.length ? <li className="faint">Empty folder</li> : entries.map(e => <li key={e.path}>
    <button title={e.path} aria-expanded={e.directory ? expanded.includes(e.path) : undefined} onClick={() => e.directory ? setExpanded(xs => xs.includes(e.path) ? xs.filter(p => p !== e.path) : [...xs, e.path]) : onOpen(e.path)}><span aria-hidden="true">{e.directory ? expanded.includes(e.path) ? "▾" : "▸" : "·"}</span><span>{e.name}</span></button>
    {expanded.includes(e.path) && <FileTree revision={revision} workspace={workspace} path={e.path} onOpen={onOpen} onError={onError} />}
  </li>)}{truncated && <li>First 2,000 entries shown. Use search to narrow the list.</li>}</ul>;
}

function Search({ workspace, revision, onOpen, onError }: { revision: number; workspace: string; onOpen: (path: string, line?: number) => void; onError: (e: unknown) => void }) {
  const [query, setQuery] = useState(""); const [content, setContent] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]); const [note, setNote] = useState("Search files by name or text.");
  useEffect(() => {
    const abort = new AbortController();
    if (!query.trim() || !workspace) { setHits([]); return; }
    const timer = setTimeout(() => { setNote("Searching…"); ideApi<{ hits: SearchHit[]; truncated: boolean; skipped: number }>("search", { workspace, query, content: String(content) }, undefined, abort.signal).then(r => { setHits(r.hits); setNote(`${r.hits.length} matches${r.truncated ? " · Limit reached; narrow your search" : ""}${r.skipped ? ` · ${r.skipped} unreadable/binary files skipped` : ""}`); }).catch(e => { if (e.name !== "AbortError") { onError(e); setNote("Search failed. Change the query to retry."); } }); }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [workspace, query, content, revision]);
  return <div className="ide-search"><input autoFocus aria-label="Search workspace" maxLength={200} placeholder="Find files…" value={query} onChange={e => setQuery(e.target.value)} /><label><input type="checkbox" checked={content} onChange={e => setContent(e.target.checked)} /> Search file contents</label><p className="faint">{note}</p>{hits.map((h, i) => <button key={`${h.path}:${h.line}:${i}`} onClick={() => onOpen(h.path, h.line)}><b>{h.path}{h.line ? `:${h.line}` : ""}</b>{h.preview && <span>{h.preview}</span>}</button>)}<p className="faint">Case-insensitive text. Generated folders and linked files are excluded.</p></div>;
}
