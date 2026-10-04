import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ago } from "../lib/format.js";
import {
  MEMORY_TYPES,
  formatTokens,
  memoryApi,
  memoryBody,
  type JobState,
  type MemoryDraft,
  type MemoryFile,
  type MemorySettings as MemorySettingsDTO,
  type MemoryStatus,
  type MemoryType,
  type ProviderState,
  type RecallMode,
  type RecallResponse,
  type UsageSummary,
} from "../lib/memoryApi.js";
import "./memorySettings.css";

const STATUS_POLL_MS = 15_000;
const PAGE = 40;

/** The settings page's own layout primitives, passed in so this page reads exactly like its siblings. */
export type SettingsShell = {
  Group: (props: { label: string; children: ReactNode }) => ReactNode;
  ToggleRow: (props: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) => ReactNode;
};

/** Settings → Memory: the owner's memory files, how GGO recalls them, and what that costs. Loads when the
 *  page opens and polls status while it stays open. */
export function MemorySettings({ active, shell }: { active: boolean; shell: SettingsShell }) {
  const { status, error, refresh } = useMemoryStatus(active);
  const { Group } = shell;
  if (!status) return <p className="settings-note">{error ? `Couldn't load memory status: ${error}` : "Loading memory status…"}</p>;
  return (
    <>
      <Group label="Memory status">
        <StatusOverview status={status} onReindexed={refresh} />
      </Group>
      <Group label="Behaviour">
        <BehaviourToggles settings={status.settings} shell={shell} onChanged={refresh} />
      </Group>
      <Group label="Try recall">
        <RecallTester />
      </Group>
      <Group label="Memories">
        <MemoryBrowser total={status.index.files} onChanged={refresh} />
      </Group>
    </>
  );
}

function useMemoryStatus(active: boolean) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await memoryApi.status());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  return { status, error, refresh };
}

// ---- status ----

function StatusOverview({ status, onReindexed }: { status: MemoryStatus; onReindexed: () => void }) {
  const [reindexing, setReindexing] = useState(false);
  const { index } = status;
  const toBuild = index.missingCards + index.staleCards;
  const reindex = async () => {
    setReindexing(true);
    try {
      await memoryApi.reindex();
      onReindexed();
    } finally {
      setReindexing(false);
    }
  };
  return (
    <div className="mem-status">
      <dl className="mem-stats">
        <Stat label="Memories" value={index.files.toLocaleString()} note={`${index.chunks.toLocaleString()} indexed passages`} />
        <Stat label="Retrieval cards" value={`${index.cards.toLocaleString()}`} note={toBuild ? `${toBuild.toLocaleString()} to build · ${jobWord(status.cards?.state)}` : "all current"} />
        <Stat label="Extraction queue" value={String(status.extraction?.pending ?? 0)} note={jobWord(status.extraction?.state)} />
        <Stat label="Index" value={status.workerRunning ? "Loaded" : "Idle"} note={index.lastSyncAt ? `synced ${ago(index.lastSyncAt)}` : "not synced yet"} />
      </dl>
      {status.providers ? (
        <div className="mem-providers">
          <ProviderLine name="Haiku" role="judges relevance first" state={status.providers.haiku} />
          <ProviderLine name="Luna" role="fallback through Codex" state={status.providers.luna} />
        </div>
      ) : (
        <p className="settings-note tight">No model access is configured, so memory ranks lexically only.</p>
      )}
      <UsageTable today={index.usageToday} week={index.usage7d} />
      <div className="mem-status-foot">
        <span className="mem-path mono" title={status.indexPath}>{status.dir}</span>
        <button className="btn sm" disabled={reindexing} onClick={() => void reindex()}>
          {reindexing ? "Rebuilding…" : "Rebuild index"}
        </button>
      </div>
      {status.cards?.lastError || status.extraction?.lastError ? (
        <p className="settings-note tight mem-warn">{[status.cards?.lastError, status.extraction?.lastError].filter(Boolean).join(" · ")}</p>
      ) : null}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="mem-stat">
      <dt>{label}</dt>
      <dd>
        <span className="mem-stat-value">{value}</span>
        <span className="mem-stat-note">{note}</span>
      </dd>
    </div>
  );
}

function jobWord(state: JobState | undefined): string {
  if (state === "running") return "working";
  if (state === "waiting-for-capacity") return "waiting for capacity";
  if (state === "disabled") return "turned off";
  return "idle";
}

function ProviderLine({ name, role, state }: { name: string; role: string; state: ProviderState }) {
  return (
    <div className="mem-provider" data-available={state.available}>
      <span className="mem-dot" aria-hidden="true" />
      <span className="mem-provider-name">{name}</span>
      <span className="mem-provider-role">{role}</span>
      <span className="mem-provider-detail mono">{state.available ? state.detail : `unavailable: ${state.detail}`}</span>
      {state.lastError ? <span className="mem-provider-error">last error: {state.lastError}</span> : null}
    </div>
  );
}

function UsageTable({ today, week }: { today: UsageSummary[]; week: UsageSummary[] }) {
  if (!week.length) return <p className="settings-note tight">No memory model calls in the last 7 days.</p>;
  const key = (u: UsageSummary) => `${u.provider}|${u.model}|${u.purpose}`;
  const todayBy = new Map(today.map((u) => [key(u), u]));
  return (
    <table className="mem-usage">
      <thead>
        <tr>
          <th>Model</th>
          <th>Purpose</th>
          <th>Calls today</th>
          <th>Calls 7d</th>
          <th>Tokens 7d (in / out)</th>
        </tr>
      </thead>
      <tbody>
        {week.map((u) => (
          <tr key={key(u)}>
            <td className="mono">{u.model}</td>
            <td>{u.purpose}</td>
            <td>{todayBy.get(key(u))?.calls ?? 0}</td>
            <td>
              {u.calls}
              {u.failures ? <span className="mem-failures"> ({u.failures} failed)</span> : null}
            </td>
            <td className="mono">
              {formatTokens(u.inputTokens)} / {formatTokens(u.outputTokens)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- behaviour ----

const TOGGLES: Array<{ key: keyof MemorySettingsDTO; label: string; hint: string }> = [
  { key: "modelRanking", label: "Model relevance ranking", hint: "Haiku (or Luna) reads the closest lexical matches and keeps only what fits the prompt. Off: plain lexical ranking with a stricter match bar." },
  { key: "agentRecall", label: "Recall in GGO's agents", hint: "Claude and z.ai runs get memories through session hooks, Codex runs as a prompt prefix; their user-level memory hooks stand down so nothing is injected twice." },
  { key: "cards", label: "Retrieval cards", hint: "In the background, Haiku writes the questions and synonyms each memory answers, so a search finds it by words it never uses. Rebuilt after an edit." },
  { key: "extraction", label: "Automatic extraction", hint: "Your durable statements from finished conversations become new memories, each quoted verbatim and checked for duplicates. They land under review in the index." },
  { key: "lunaFallback", label: "Luna fallback", hint: "When no Claude subscription has room, memory work runs on Codex Luna through your ChatGPT plan. Off: it waits for Haiku instead." },
];

function BehaviourToggles({ settings, shell, onChanged }: { settings: MemorySettingsDTO; shell: SettingsShell; onChanged: () => void }) {
  const [current, setCurrent] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setCurrent(settings), [settings]);
  const flip = async (key: keyof MemorySettingsDTO, on: boolean) => {
    setCurrent((s) => ({ ...s, [key]: on }));
    try {
      setCurrent(await memoryApi.setSettings({ [key]: on }));
      setError(null);
      onChanged();
    } catch (err) {
      setCurrent(settings);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      {TOGGLES.map((t) => (
        <shell.ToggleRow key={t.key} label={t.label} hint={t.hint} on={current[t.key]} onChange={(on) => void flip(t.key, on)} />
      ))}
      {error ? <p className="settings-note tight mem-warn">{error}</p> : null}
    </>
  );
}

// ---- recall tester ----

const MODES: Array<{ id: RecallMode; label: string }> = [
  { id: "search", label: "Search" },
  { id: "prompt", label: "Prompt recall" },
  { id: "session", label: "Session start" },
];

function RecallTester() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RecallMode>("search");
  const [result, setResult] = useState<RecallResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await memoryApi.search(query.trim(), mode, mode === "search" ? 8 : mode === "prompt" ? 2 : 4));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mem-recall">
      <p className="settings-note tight">
        Run the same recall an agent gets. Search lists everything relevant; prompt recall and session start inject only what the model judges
        useful, at most two and four memories.
      </p>
      <form
        className="mem-recall-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input className="text-input" value={query} placeholder="e.g. how do I deploy a server change" onChange={(e) => setQuery(e.target.value)} aria-label="Recall query" />
        <select className="text-input mem-mode" value={mode} onChange={(e) => setMode(e.target.value as RecallMode)} aria-label="Recall mode">
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button className="btn primary sm" type="submit" disabled={busy || !query.trim()}>
          {busy ? "Recalling…" : "Recall"}
        </button>
      </form>
      {error ? <p className="settings-note tight mem-warn">{error}</p> : null}
      {result ? <RecallResult result={result} /> : null}
    </div>
  );
}

function RecallResult({ result }: { result: RecallResponse }) {
  const how = result.model ? `judged by ${result.model}` : `lexical${result.fallbackReason ? ` (${result.fallbackReason})` : ""}`;
  return (
    <div className="mem-recall-result" data-testid="memory-recall-result">
      <p className="mem-recall-meta">
        {result.memories.length} {result.memories.length === 1 ? "memory" : "memories"} · {how} · {result.cached ? "cached" : `${(result.ms / 1000).toFixed(1)} s`}
      </p>
      {result.memories.length ? (
        <ol className="mem-hits">
          {result.memories.map((m) => (
            <li key={m.file} className="mem-hit">
              <span className="mem-hit-name">{m.name}</span>
              <span className={"mem-badge " + m.judgedBy}>{m.judgedBy === "model" ? "model" : "lexical"}</span>
              <span className="mem-hit-desc">{m.description || "(no description)"}</span>
              <span className="mem-hit-file mono">{m.file}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="settings-note tight">Nothing qualified for this query.</p>
      )}
    </div>
  );
}

// ---- browser + editor ----

type Editing = { kind: "new" } | { kind: "file"; file: string } | null;

function MemoryBrowser({ total, onChanged }: { total: number; onChanged: () => void }) {
  const [filter, setFilter] = useState("");
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [count, setCount] = useState(total);
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const page = await memoryApi.list(0, limit, filter.trim());
      setFiles(page.files);
      setCount(page.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [filter, limit]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);
  const saved = () => {
    setEditing(null);
    void load();
    onChanged();
  };
  if (editing) return <MemoryEditor editing={editing} onDone={saved} onCancel={() => setEditing(null)} />;
  return (
    <div className="mem-browser">
      <div className="mem-browser-bar">
        <input className="text-input" value={filter} placeholder="Filter by name, description or file" aria-label="Filter memories" onChange={(e) => { setFilter(e.target.value); setLimit(PAGE); }} />
        <button className="btn sm" onClick={() => setEditing({ kind: "new" })}>
          New memory
        </button>
      </div>
      {error ? <p className="settings-note tight mem-warn">{error}</p> : null}
      <ul className="mem-list" aria-label="Memory files">
        {files.map((f) => (
          <li key={f.file}>
            <button className="mem-list-item" onClick={() => setEditing({ kind: "file", file: f.file })}>
              <span className="mem-list-name">{f.name}</span>
              <span className="mem-list-type">{f.type || "untyped"}</span>
              <span className="mem-list-desc">{f.description}</span>
              <span className="mem-list-meta mono">
                {f.file}
                {f.lastVerified ? ` · verified ${f.lastVerified}` : ""}
                {f.source === "auto-extracted" ? " · auto-extracted" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mem-list-foot">
        Showing {files.length.toLocaleString()} of {count.toLocaleString()}
        {files.length < count ? (
          <button className="btn ghost sm" onClick={() => setLimit((l) => l + PAGE)}>
            Show more
          </button>
        ) : null}
      </p>
    </div>
  );
}

/** The editor's working copy. `type` may be a custom type an existing memory already carries. */
type EditorDraft = Omit<MemoryDraft, "type"> & { type: string };

const EMPTY_DRAFT: EditorDraft = { type: "feedback", name: "", description: "", body: "" };
const isStandardType = (type: string): type is MemoryType => (MEMORY_TYPES as readonly string[]).includes(type);

function MemoryEditor({ editing, onDone, onCancel }: { editing: NonNullable<Editing>; onDone: () => void; onCancel: () => void }) {
  const loaded = useLoadedMemory(editing);
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (loaded.draft) setDraft(loaded.draft);
  }, [loaded.draft]);
  const patch = editing.kind === "file" ? changedFields(loaded.draft, draft) : null;
  const valid = patch ? Object.keys(patch).length > 0 && patchValid(patch) : isStandardType(draft.type) && patchValid(draft);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(() => (editing.kind === "file" ? memoryApi.update(editing.file, patch!) : memoryApi.create({ ...draft, type: draft.type as MemoryType })));
  const remove = () => act(() => (editing.kind === "file" ? memoryApi.remove(editing.file) : Promise.resolve()));
  const loading = editing.kind === "file" && !loaded.draft && !loaded.error;
  return (
    <div className="mem-editor" data-testid="memory-editor">
      <div className="mem-editor-head">
        <span className="mem-editor-title">{editing.kind === "new" ? "New memory" : editing.file}</span>
        {loaded.meta?.source === "auto-extracted" ? <span className="mem-badge lexical">auto-extracted</span> : null}
      </div>
      {loading ? <p className="settings-note tight">Loading…</p> : <EditorFields draft={draft} onChange={(next) => setDraft((d) => ({ ...d, ...next }))} />}
      {error ?? loaded.error ? <p className="settings-note tight mem-warn">{error ?? loaded.error}</p> : null}
      <div className="mem-editor-actions">
        <button className="btn primary sm" disabled={busy || loading || !valid} onClick={() => void save()}>
          {editing.kind === "new" ? "Create" : "Save"}
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {editing.kind === "file" ? (
          <button className={"btn sm mem-delete " + (confirmDelete ? "danger" : "ghost")} disabled={busy || loading} onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>
            {confirmDelete ? "Move to trash" : "Delete…"}
          </button>
        ) : null}
      </div>
      {confirmDelete ? (
        <p className="settings-note tight">
          The file moves to the memory directory's <code>.ggo-trash</code> folder and can be restored from there.
        </p>
      ) : null}
    </div>
  );
}

function useLoadedMemory(editing: NonNullable<Editing>): { draft: EditorDraft | null; meta: MemoryFile | null; error: string | null } {
  const [state, setState] = useState<{ draft: EditorDraft | null; meta: MemoryFile | null; error: string | null }>({ draft: null, meta: null, error: null });
  useEffect(() => {
    if (editing.kind !== "file") return;
    let cancelled = false;
    memoryApi.get(editing.file).then(
      ({ meta, text }) => {
        if (cancelled) return;
        const draft = { type: meta?.type || "reference", name: meta?.name ?? editing.file, description: meta?.description ?? "", body: memoryBody(text) };
        setState({ draft, meta, error: null });
      },
      (err: unknown) => !cancelled && setState({ draft: null, meta: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [editing]);
  return state;
}

function EditorFields({ draft, onChange }: { draft: EditorDraft; onChange: (next: Partial<EditorDraft>) => void }) {
  const types = isStandardType(draft.type) ? MEMORY_TYPES : [draft.type, ...MEMORY_TYPES];
  return (
    <div className="mem-editor-fields">
      <label className="mem-field">
        <span>Name</span>
        <input className="text-input" value={draft.name} maxLength={80} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <label className="mem-field">
        <span>Description</span>
        <input className="text-input" value={draft.description} maxLength={200} onChange={(e) => onChange({ description: e.target.value })} />
      </label>
      <label className="mem-field">
        <span>Type</span>
        <select className="text-input" value={draft.type} onChange={(e) => onChange({ type: e.target.value })}>
          {types.map((t) => (
            <option key={t} value={t} disabled={!isStandardType(t)}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="mem-field">
        <span>Body (Markdown)</span>
        <textarea className="text-input mem-body mono" value={draft.body} rows={12} onChange={(e) => onChange({ body: e.target.value })} />
      </label>
    </div>
  );
}

/** Only what the owner changed, so an untouched custom type or empty description is never rewritten. */
function changedFields(before: EditorDraft | null, after: EditorDraft): Partial<MemoryDraft> {
  if (!before) return {};
  const patch: Partial<MemoryDraft> = {};
  if (after.name !== before.name) patch.name = after.name;
  if (after.description !== before.description) patch.description = after.description;
  if (after.body !== before.body) patch.body = after.body;
  if (after.type !== before.type && isStandardType(after.type)) patch.type = after.type;
  return patch;
}

/** The server's limits, checked on the fields being sent. */
function patchValid(patch: Partial<EditorDraft>): boolean {
  if (patch.name !== undefined && patch.name.trim().length < 3) return false;
  if (patch.description !== undefined && patch.description.trim().length < 10) return false;
  if (patch.body !== undefined && patch.body.trim().length < 10) return false;
  return true;
}
