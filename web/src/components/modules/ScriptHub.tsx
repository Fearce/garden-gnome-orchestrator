import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModuleFrame, Icon, Loading, Notice } from "./ModuleFrame.js";
import { usePoll } from "./hooks.js";
import { ModuleRequestError, errorText, formatAgo, moduleJson, moduleUrl } from "./moduleApi.js";

interface ScriptStatus {
  state: string;
  processCount: number;
  processes: { processId: number; name: string; commandLine: string }[];
  tasks: { taskName: string; state: string }[];
  processEnumeration: { fresh?: boolean; source?: string; ageMs?: number; error?: string } | null;
}

interface Script {
  id: string;
  owner: string | null;
  displayName: string;
  management: "personal" | "agent";
  tags: string[];
  keepAlive: boolean;
  command: string;
  consolidated: boolean;
  status: ScriptStatus;
}

interface StatusPayload {
  generatedAt: string;
  hiddenScripts: string[];
  detailsRevision: string;
  scripts: Script[];
}

interface Details {
  revision: string;
  scripts: Record<string, { description: string; notes: string[]; aliases: string[] }>;
}

type StatusFilter = "all" | "running" | "stopped" | "keepalive" | "recovering";

interface Filters {
  search: string;
  tag: string;
  sort: "name" | "urgency";
  status: StatusFilter;
  hideConsolidated: boolean;
  showHidden: boolean;
  showAgentManaged: boolean;
}

const FILTERS_KEY = "ggo-scripthub-filters";
const DEFAULT_FILTERS: Filters = { search: "", tag: "all", sort: "name", status: "all", hideConsolidated: true, showHidden: false, showAgentManaged: false };
const PENDING_TIMEOUT_MS = 30_000;

function loadFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...(JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "{}") as Partial<Filters>) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

// A client update can arrive before its independent worker is refreshed.
const isAgentManaged = (script: Script) => script.management ? script.management === "agent" : !script.owner;
const isRecovering = (script: Script) => script.keepAlive && script.status.state !== "running" && !script.consolidated;

export function ScriptHub() {
  return (
    <ModuleFrame id="scripthub" title="Script Hub" lede="The scripts and services Script Hub supervises on this PC. Start and stop act on Script Hub itself; leaving this tab changes nothing.">
      {() => <ScriptHubBody />}
    </ModuleFrame>
  );
}

function ScriptHubBody() {
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const status = usePoll((signal) => moduleJson<StatusPayload>("scripthub", "/status", { signal }), 10_000);
  const [details, setDetails] = useState<Details | null>(null);
  const [hidden, setHidden] = useState<Set<string> | null>(null);
  const [pending, setPending] = useState<Record<string, { action: "start" | "stop"; since: number }>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set());
  const nudges = useRef<Set<number>>(new Set());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const timer of nudges.current) window.clearTimeout(timer);
      nudges.current.clear();
    };
  }, []);

  const data = status.data;
  const hiddenSet = useMemo(() => hidden ?? new Set(data?.hiddenScripts ?? []), [hidden, data?.hiddenScripts]);

  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    if (!data?.detailsRevision || details?.revision === data.detailsRevision) return;
    const abort = new AbortController();
    moduleJson<Details>("scripthub", "/details", { signal: abort.signal }).then(setDetails, () => undefined);
    return () => abort.abort();
  }, [data?.detailsRevision, details?.revision]);

  // A start or stop shows as pending until a refresh shows the new state, or for 30 s at most.
  useEffect(() => {
    if (!data) return;
    setPending((current) => {
      const next = { ...current };
      for (const [id, p] of Object.entries(current)) {
        const script = data.scripts.find((s) => s.id === id);
        const running = script?.status.state === "running";
        if (!script || (p.action === "start" && running) || (p.action === "stop" && !running) || Date.now() - p.since > PENDING_TIMEOUT_MS) delete next[id];
      }
      return next;
    });
  }, [data]);

  const nudge = useCallback(() => {
    if (!mounted.current) return;
    for (const ms of [1200, 2800, 5000, 8000]) {
      const timer = window.setTimeout(() => {
        nudges.current.delete(timer);
        void status.refresh();
      }, ms);
      nudges.current.add(timer);
    }
  }, [status]);

  const runAction = useCallback(
    async (id: string, action: "start" | "stop") => {
      setActionError(null);
      setPending((p) => ({ ...p, [id]: { action, since: Date.now() } }));
      try {
        await moduleJson("scripthub", `/scripts/${encodeURIComponent(id)}/${action}`, { method: "POST", body: {} });
        await status.refresh();
        nudge();
      } catch (error) {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        setActionError(errorText(error));
      }
    },
    [status, nudge],
  );

  const toggleKeepAlive = useCallback(
    async (script: Script) => {
      setActionError(null);
      try {
        await moduleJson("scripthub", `/scripts/${encodeURIComponent(script.id)}/keepalive`, { method: "POST", body: { enabled: !script.keepAlive } });
        await status.refresh();
      } catch (error) {
        setActionError(errorText(error));
      }
    },
    [status],
  );

  const toggleHidden = useCallback(
    async (id: string) => {
      const next = new Set(hiddenSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setHidden(next);
      try {
        await moduleJson("scripthub", "/hidden", { method: "PUT", body: { hiddenScripts: [...next] } });
      } catch (error) {
        setActionError(`The hidden list was not saved: ${errorText(error)}`);
        setHidden(hiddenSet);
      }
    },
    [hiddenSet],
  );

  if (!data) {
    if (status.error) return <HubError error={status.error} onRetry={() => void status.refresh()} />;
    return <Loading label="Asking Script Hub for its scripts…" />;
  }

  const pool = filters.showAgentManaged ? data.scripts : data.scripts.filter((s) => !isAgentManaged(s));
  const agentManagedCount = data.scripts.filter(isAgentManaged).length;
  const matches = (script: Script) => matchesFilters(script, filters, hiddenSet, details);
  const visible = pool.filter(matches).sort(filters.sort === "urgency" ? byUrgency : (a, b) => a.displayName.localeCompare(b.displayName));
  const tags = [...new Set(data.scripts.flatMap((s) => s.tags ?? []))].sort();
  const recovering = data.scripts.filter(isRecovering);
  const degraded = data.scripts.map((s) => s.status.processEnumeration).find((e) => e && e.fresh === false) ?? null;
  const hiddenCount = pool.filter((s) => hiddenSet.has(s.id)).length;

  return (
    <div className="sh">
      {status.error ? <HubError error={status.error} onRetry={() => void status.refresh()} stale /> : null}
      {actionError ? <Notice tone="bad" title="Script Hub refused that">{actionError}</Notice> : null}
      {degraded ? (
        <Notice tone="warn" title="Process list is stale">
          Script Hub could not take a fresh process table ({degraded.source ?? "unknown source"}{degraded.error ? `: ${degraded.error}` : ""}). Cards show the last good one, and Keep Alive is not restarting anything until a fresh table lands.
        </Notice>
      ) : null}
      {recovering.length ? <Notice tone="warn" title={`Keep Alive recovery pending for ${recovering.length}`}>{recoveryText(recovering)}</Notice> : null}

      <div className="sh-filters">
        <label className="sh-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Search apps, services or tags" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} aria-label="Search scripts" />
        </label>
        <select className="mod-select" value={filters.tag} onChange={(e) => setFilters({ ...filters, tag: e.target.value })} aria-label="Tag">
          <option value="all">All tags</option>
          {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        <select className="mod-select" value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value as Filters["sort"] })} aria-label="Sort scripts">
          <option value="name">Name A-Z</option>
          <option value="urgency">Recovery first</option>
        </select>
        <select className="mod-select" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as StatusFilter })} aria-label="Status">
          <option value="all">Any status</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
          <option value="keepalive">Keep Alive</option>
          <option value="recovering">Recovering</option>
        </select>
        <label className="mod-check">
          <input type="checkbox" checked={filters.hideConsolidated} onChange={(e) => setFilters({ ...filters, hideConsolidated: e.target.checked })} />
          Hide consolidated
        </label>
        <label className="mod-check">
          <input type="checkbox" checked={filters.showHidden} onChange={(e) => setFilters({ ...filters, showHidden: e.target.checked })} />
          Show hidden{hiddenCount ? ` (${hiddenCount})` : ""}
        </label>
        <label className="mod-check">
          <input type="checkbox" checked={filters.showAgentManaged} onChange={(e) => setFilters({ ...filters, showAgentManaged: e.target.checked })} />
          Show agent-managed{agentManagedCount ? ` (${agentManagedCount})` : ""}
        </label>
        <button className="btn sm ghost" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>Reset filters</button>
        <span className="sh-count mono">
          {visible.length === pool.length ? `${pool.length} scripts` : `${visible.length} of ${pool.length} scripts`} · {formatAgo(data.generatedAt)}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="mod-empty">{emptyText(filters, data.scripts.filter(isAgentManaged).filter(matches).length)}</div>
      ) : (
        <div className="sh-grid">
          {visible.map((script) => (
            <ScriptCard
              key={script.id}
              script={script}
              detail={details?.scripts[script.id]}
              hidden={hiddenSet.has(script.id)}
              pending={pending[script.id]?.action ?? null}
              logsOpen={openLogs.has(script.id)}
              onAction={(action) => void runAction(script.id, action)}
              onKeepAlive={() => void toggleKeepAlive(script)}
              onHide={() => void toggleHidden(script.id)}
              onTag={(tag) => setFilters({ ...filters, tag })}
              onEdited={() => status.refresh()}
              onOrganize={async (organization) => {
                await moduleJson("scripthub", `/scripts/${encodeURIComponent(script.id)}/organization`, { method: "PUT", body: organization });
                await status.refresh();
              }}
              onLogs={() =>
                setOpenLogs((open) => {
                  const next = new Set(open);
                  if (next.has(script.id)) next.delete(script.id);
                  else next.add(script.id);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HubError({ error, onRetry, stale }: { error: unknown; onRetry: () => void; stale?: boolean }) {
  const down = error instanceof ModuleRequestError && error.upstreamDown;
  return (
    <Notice tone="bad" title={down ? "Script Hub is not answering" : "Script Hub could not be read"} onRetry={onRetry}>
      {errorText(error)}
      {stale ? " The cards below show the last answer." : down ? " Start Script Hub on this PC; this tab retries every 10 seconds." : ""}
    </Notice>
  );
}

function matchesFilters(script: Script, filters: Filters, hidden: Set<string>, details: Details | null): boolean {
  if (hidden.has(script.id) && !filters.showHidden) return false;
  if (filters.hideConsolidated && script.consolidated) return false;
  if (filters.tag !== "all" && !(script.tags ?? []).includes(filters.tag)) return false;
  const running = script.status.state === "running";
  if (filters.status === "running" && !running) return false;
  if (filters.status === "stopped" && (running || script.consolidated)) return false;
  if (filters.status === "keepalive" && !script.keepAlive) return false;
  if (filters.status === "recovering" && !isRecovering(script)) return false;
  const q = filters.search.trim().toLowerCase();
  if (!q) return true;
  const d = details?.scripts[script.id];
  const text = [script.displayName, script.id, ...(script.tags ?? []), script.command, d?.description, ...(d?.notes ?? []), ...(d?.aliases ?? [])].filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every((term) => text.includes(term));
}

/** Keep-Alive entries that are down first, then running ones without Keep Alive, then the rest. */
function byUrgency(a: Script, b: Script): number {
  const bucket = (s: Script) => {
    const running = s.status.state === "running";
    if (!running && s.keepAlive) return 0;
    if (running && !s.keepAlive) return 1;
    return running ? 3 : 2;
  };
  return bucket(a) - bucket(b) || a.displayName.localeCompare(b.displayName);
}

function recoveryText(recovering: Script[]): string {
  const own = recovering.filter((s) => !isAgentManaged(s));
  const fleet = recovering.length - own.length;
  const names = own.slice(0, 5).map((s) => s.displayName).join(", ");
  const more = own.length > 5 ? ` (+${own.length - 5} more)` : "";
  const who = own.length ? `${names}${more}${fleet ? ` and ${fleet} agent-managed` : ""}` : `${fleet} agent-managed`;
  return `${who}. Script Hub retries them on its next reconcile cycle.`;
}

function emptyText(filters: Filters, agentHits: number): string {
  const base = "No scripts match the current search and filters.";
  if (filters.showAgentManaged || !agentHits) return base;
  return `${base} ${agentHits} agent-managed ${agentHits === 1 ? "script does" : "scripts do"}; tick "Show agent-managed" to see ${agentHits === 1 ? "it" : "them"}.`;
}

function ScriptCard(props: {
  script: Script;
  detail: Details["scripts"][string] | undefined;
  hidden: boolean;
  pending: "start" | "stop" | null;
  logsOpen: boolean;
  onAction: (action: "start" | "stop") => void;
  onKeepAlive: () => void;
  onHide: () => void;
  onLogs: () => void;
  onTag: (tag: string) => void;
  onOrganize: (organization: Organization) => Promise<void>;
  onEdited: () => Promise<void>;
}) {
  const { script, detail, pending } = props;
  const [notesOpen, setNotesOpen] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [editing, setEditing] = useState(false);
  const state = script.consolidated ? "consolidated" : script.status.state;
  return (
    <article className={`sh-card${props.hidden ? " is-hidden" : ""}`} data-script-id={script.id}>
      <div className="sh-card-head">
        <h4 title={script.displayName}>
          {script.displayName}
          {script.keepAlive ? <span className="sh-keepalive" title="Keep Alive is on" /> : null}
        </h4>
        <span className={`mod-badge mod-badge-${pending ? "pending" : isRecovering(script) ? "recovering" : state}`}>
          {pending ? (pending === "start" ? "Starting…" : "Stopping…") : isRecovering(script) ? "recovering" : state}
        </span>
        <button className="mod-icon-btn" onClick={props.onHide} title={props.hidden ? "Show this script in the list again" : "Hide this script from the list"} aria-label={props.hidden ? "Unhide script" : "Hide script"}>
          <Icon name={props.hidden ? "eye" : "eyeOff"} size={15} />
        </button>
      </div>
      {detail?.description ? <p className="sh-desc">{detail.description}</p> : null}
      <div className="sh-meta mono">
        {script.id}
      </div>
      <div className="sh-labels">
        <span className="mod-chip">{isAgentManaged(script) ? "Agent-managed" : "My app"}</span>
        {(script.tags ?? []).map((tag) => <button key={tag} className="sh-tag" onClick={() => props.onTag(tag)} title={`Filter by ${tag}`}>{tag}</button>)}
      </div>
      <code className="sh-cmd" title={script.command}>
        {script.command || "no start command"}
      </code>
      {script.status.tasks.map((task) => (
        <div className="sh-proc" key={task.taskName}>
          Task <code>{task.taskName}</code> · {task.state}
        </div>
      ))}
      {script.status.processes.length ? (
        script.status.processes.map((p) => (
          <div className="sh-proc" key={p.processId}>
            <strong>PID {p.processId}</strong> · {p.name}
            <code title={p.commandLine}>{p.commandLine}</code>
          </div>
        ))
      ) : (
        <div className="sh-proc faint">No matched processes.</div>
      )}
      {script.status.processCount > script.status.processes.length ? <div className="sh-proc faint">+ {script.status.processCount - script.status.processes.length} more matched processes</div> : null}
      {detail?.notes.length ? (
        <div className={`sh-notes${notesOpen ? " open" : ""}`}>
          <ul>
            {detail.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
          {detail.notes.length > 2 ? (
            <button className="sh-link" onClick={() => setNotesOpen((v) => !v)}>
              {notesOpen ? "Show less" : `Show all notes (${detail.notes.length})`}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="sh-actions">
        <button className="btn sm" disabled={pending !== null} onClick={() => props.onAction("start")}>
          <Icon name="play" size={13} /> Start
        </button>
        <button className="btn sm danger" disabled={pending !== null} onClick={() => props.onAction("stop")}>
          <Icon name="square" size={13} /> Stop
        </button>
        <button className={`btn sm${script.keepAlive ? " success" : " ghost"}`} onClick={props.onKeepAlive} title="Keep Alive: Script Hub restarts this script whenever it stops">
          <Icon name="infinity" size={13} /> {script.keepAlive ? "Alive" : "Keep Alive"}
        </button>
        <button className={`btn sm ghost${props.logsOpen ? " on" : ""}`} onClick={props.onLogs} aria-expanded={props.logsOpen}>
          <Icon name="logs" size={13} /> Logs
        </button>
      </div>
      <button className="sh-link" onClick={() => setOrganizing((open) => !open)} aria-expanded={organizing}>Organize</button>
      <button className="sh-link" onClick={() => setEditing((open) => !open)} aria-expanded={editing}>Edit entry</button>
      {organizing ? <OrganizationEditor script={script} onSave={props.onOrganize} onClose={() => setOrganizing(false)} /> : null}
      {editing ? <EntryEditor script={script} onSaved={props.onEdited} onClose={() => setEditing(false)} /> : null}
      {props.logsOpen ? <LogPanel id={script.id} onClose={props.onLogs} /> : null}
    </article>
  );
}

type Organization = Pick<Script, "management" | "tags">;

interface RegistryEntry {
  id: string;
  displayName?: string;
  description?: string;
  notes?: string[] | string;
  aliases?: string[];
  start?: { type?: string; executable?: string; args?: string[]; workingDir?: string; taskName?: string; startHidden?: boolean; windowStyle?: string };
}

function EntryEditor({ script, onSaved, onClose }: { script: Script; onSaved: () => Promise<void>; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ entry: RegistryEntry; revision: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [args, setArgs] = useState("[]");
  // Raw text for list fields, so a typed newline, comma or space survives until the next character.
  const [notesText, setNotesText] = useState("");
  const [aliasesText, setAliasesText] = useState("");
  const syncListText = (value: Partial<RegistryEntry> | null | undefined) => {
    setNotesText(Array.isArray(value?.notes) ? value.notes.join("\n") : typeof value?.notes === "string" ? value.notes : "");
    setAliasesText(Array.isArray(value?.aliases) ? value.aliases.join(", ") : "");
  };
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    moduleJson<{ entry: RegistryEntry; revision: string }>("scripthub", `/scripts/${encodeURIComponent(script.id)}/entry`, { signal: abort.signal }).then((result) => {
      setLoaded(result);
      setDraft(JSON.stringify(result.entry, null, 2));
      setArgs(JSON.stringify(result.entry.start?.args ?? []));
      syncListText(result.entry);
    },(cause) => { if (!abort.signal.aborted) setError(errorText(cause)); });
    return () => abort.abort();
  }, [script.id]);
  let entry: RegistryEntry | null = null;
  try {
    const parsed = JSON.parse(draft);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && [parsed.displayName, parsed.description].every((value) => value === undefined || typeof value === "string")
      && (parsed.notes === undefined || typeof parsed.notes === "string" || (Array.isArray(parsed.notes) && parsed.notes.every((value: unknown) => typeof value === "string")))
      && (parsed.aliases === undefined || (Array.isArray(parsed.aliases) && parsed.aliases.every((value: unknown) => typeof value === "string")))
      && (parsed.start === undefined || (parsed.start && typeof parsed.start === "object" && !Array.isArray(parsed.start)
        && [parsed.start.type, parsed.start.executable, parsed.start.workingDir, parsed.start.taskName].every((value) => value === undefined || typeof value === "string")))) entry = parsed;
  } catch { /* Invalid advanced drafts remain editable until repaired. */ }
  const update = (value: Partial<RegistryEntry>) => setDraft(JSON.stringify({ ...entry, ...value }, null, 2));
  const start = (value: Partial<NonNullable<RegistryEntry["start"]>>) => update({ start: { ...entry?.start, ...value } });
  return <form className="sh-organize" aria-label={`Edit ${script.displayName}`} onSubmit={async (event) => {
    event.preventDefault();
    setError(null);
    if (!entry) { setError("Entry must be a valid JSON object."); return; }
    setSaving(true);
    try {
      const launchArgs: unknown = JSON.parse(args);
      if (!Array.isArray(launchArgs) || !launchArgs.every((arg) => typeof arg === "string")) throw new Error("Arguments must be a JSON array of strings.");
      const updated = { ...entry, ...(entry.start && (entry.start.args !== undefined || args !== "[]") ? { start: { ...entry.start, args: launchArgs } } : {}) };
      await moduleJson("scripthub", `/scripts/${encodeURIComponent(script.id)}/entry`, { method: "PUT", body: { revision: loaded?.revision, entry: updated } });
      await onSaved();
      onClose();
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  }}>
    {!loaded && !error ? <Loading label="Loading entry..." /> : null}
    <fieldset disabled={saving || !loaded}>
      <fieldset disabled={!entry}>
        <label>Name<input value={entry?.displayName ?? ""} onChange={(event) => update({ displayName: event.target.value })} /></label>
        <label>Description<textarea aria-label="Description" value={entry?.description ?? ""} onChange={(event) => update({ description: event.target.value })} /></label>
        <label>Notes (one per line)<textarea aria-label="Notes (one per line)" value={notesText} onChange={(event) => {
          setNotesText(event.target.value);
          update({ notes: event.target.value.split(/\r?\n/).filter((note) => note.trim()) });
        }} /></label>
        <label>Aliases (comma separated)<input value={aliasesText} onChange={(event) => {
          setAliasesText(event.target.value);
          update({ aliases: event.target.value.split(",").map((alias) => alias.trim()).filter(Boolean) });
        }} /></label>
        <label>Launch type<input value={entry?.start?.type ?? ""} onChange={(event) => start({ type: event.target.value })} placeholder="process, python or task" /></label>
        <label>Executable<input value={entry?.start?.executable ?? ""} onChange={(event) => start({ executable: event.target.value })} /></label>
        <label>Working directory<input value={entry?.start?.workingDir ?? ""} onChange={(event) => start({ workingDir: event.target.value })} /></label>
        <label>Scheduled task name<input value={entry?.start?.taskName ?? ""} onChange={(event) => start({ taskName: event.target.value })} /></label>
        <label>Arguments (JSON array)<textarea aria-label="Arguments (JSON array)" value={args} onChange={(event) => {
          setArgs(event.target.value);
          try { const value = JSON.parse(event.target.value); if (Array.isArray(value) && value.every((arg) => typeof arg === "string")) start({ args: value }); } catch { /* Preserve draft for validation on save. */ }
        }} placeholder={'["app.js", "--port", "8080"]'} /></label>
        <label className="mod-check"><input type="checkbox" checked={entry?.start?.startHidden ?? (entry?.start?.windowStyle !== "normal")} onChange={(event) => start({ startHidden: event.target.checked })} />Start hidden</label>
      </fieldset>
      <details><summary>Advanced entry JSON</summary><label>Registry entry<textarea aria-label="Registry entry" rows={16} value={draft} onChange={(event) => {
        setDraft(event.target.value);
        try { const value = JSON.parse(event.target.value); setArgs(JSON.stringify(value?.start?.args ?? [])); syncListText(value); } catch { /* Keep invalid draft. */ }
      }} /></label></details>
      <p>Launch changes apply on the next start; other settings apply when Script Hub next reads the registry. Use Organize for tags and management, and Keep Alive for supervision.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="sh-actions"><button className="btn sm" type="submit" disabled={!loaded}>{saving ? "Saving..." : "Save entry"}</button><button className="btn sm ghost" type="button" onClick={onClose}>Cancel</button></div>
    </fieldset>
    {!loaded && error ? <p role="alert">{error} <button type="button" className="sh-link" onClick={onClose}>Close editor</button></p> : null}
  </form>;
}

function OrganizationEditor({ script, onSave, onClose }: { script: Script; onSave: (value: Organization) => Promise<void>; onClose: () => void }) {
  const [management, setManagement] = useState(script.management ?? (isAgentManaged(script) ? "agent" : "personal"));
  const [tags, setTags] = useState((script.tags ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="sh-organize" aria-label={`Organize ${script.displayName}`} onSubmit={async (event) => {
      event.preventDefault();
      setSaving(true);
      setError(null);
      try {
        await onSave({ management, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) });
        onClose();
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setSaving(false);
      }
    }}>
      <fieldset disabled={saving}>
        <label>Managed as<select className="mod-select" value={management} onChange={(event) => setManagement(event.target.value as Script["management"])}>
          <option value="personal">My app</option><option value="agent">Agent-managed</option>
        </select></label>
        <label>Tags (comma separated)<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="e.g. games, dashboard" /></label>
        <p>Labels organize this list. They do not change how the script runs.</p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="sh-actions"><button className="btn sm" type="submit">{saving ? "Saving..." : "Save organization"}</button><button className="btn sm ghost" type="button" onClick={onClose}>Cancel</button></div>
      </fieldset>
    </form>
  );
}

const LOG_LIMIT = 200_000;

/** A live tail of the script's output. The stream exists only while this panel is open. */
function LogPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [text, setText] = useState("Connecting…");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const source = new EventSource(moduleUrl("scripthub", `/scripts/${encodeURIComponent(id)}/logs`), { withCredentials: true });
    source.onmessage = (event) => {
      setError(null);
      const message = JSON.parse(event.data as string) as { type: "init" | "chunk"; text: string };
      setText((current) => (message.type === "init" ? message.text : (current + message.text).slice(-LOG_LIMIT)));
    };
    source.onerror = () => setError("The log stream dropped; reconnecting…");
    return () => source.close();
  }, [id]);
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className="sh-log">
      <div className="sh-log-head">
        <span>stdout / stderr</span>
        {error ? <span className="sh-log-error">{error}</span> : null}
        <button className="mod-icon-btn" onClick={onClose} aria-label="Close log">
          <Icon name="x" size={14} />
        </button>
      </div>
      <pre ref={box}>{text}</pre>
    </div>
  );
}
