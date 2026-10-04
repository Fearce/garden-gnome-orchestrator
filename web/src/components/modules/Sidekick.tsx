import { useCallback, useState } from "react";
import { Field, Icon, Loading, ModuleDialog, ModuleFrame, Notice } from "./ModuleFrame.js";
import { usePoll } from "./hooks.js";
import { ModuleRequestError, errorText, formatAgo, moduleJson } from "./moduleApi.js";

interface Companion {
  id: string | null;
  name: string;
  exePath: string | null;
  arguments: string | null;
  workingDirectory: string | null;
  hubId: string | null;
  alreadyRunningProcess: string | null;
  alreadyRunningPort: number | null;
  running?: boolean | null;
}

interface Rule {
  id: string | null;
  name: string;
  enabled: boolean;
  triggerProcess: string;
  debounceSeconds: number;
  closeCompanionsOnExit: boolean;
  companions: Companion[];
  triggerRunning?: boolean | null;
}

interface SidekickState {
  generatedAt: string;
  installed: boolean;
  exePath: string | null;
  running: boolean;
  startOnLogin: boolean;
  settingsPath: string;
  configured: boolean;
  settingsRevision: string | null;
  settingsError: string | null;
  defaultDebounceSeconds: number;
  rules: Rule[];
  log: { path: string; updatedAt: string | null; entries: { time: string | null; level: string; message: string }[] };
  hubError: string | null;
  hubScripts: { id: string; name: string }[];
}

type Editing = { rule: Rule; isNew: boolean };

export function Sidekick() {
  return (
    <ModuleFrame id="sidekick" title="Sidekick" lede="Sidekick starts companion programs when a game or app you name launches, and can close them when it exits. Its settings file stays the source of truth; edits here write straight to it.">
      {() => <SidekickBody />}
    </ModuleFrame>
  );
}

function SidekickBody() {
  const [editing, setEditing] = useState<Editing | null>(null);
  const state = usePoll((signal) => moduleJson<SidekickState>("sidekick", "/state", { signal }), 10_000, editing === null);
  const [power, setPower] = useState<"start" | "stop" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const data = state.data;

  const togglePower = useCallback(async () => {
    if (!data) return;
    const action = data.running ? "stop" : "start";
    setPower(action);
    setActionError(null);
    try {
      await moduleJson("sidekick", `/power/${action}`, { method: "POST", body: {} });
      await state.refresh();
      window.setTimeout(() => void state.refresh(), 2_500);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setPower(null);
    }
  }, [data, state]);

  const remove = useCallback(
    async (rule: Rule) => {
      if (!data || !rule.id || !window.confirm(`Delete the Sidekick task "${rule.name}"?`)) return;
      setActionError(null);
      try {
        await moduleJson("sidekick", `/rules/${encodeURIComponent(rule.id)}?revision=${encodeURIComponent(data.settingsRevision ?? "")}`, { method: "DELETE" });
        await state.refresh();
      } catch (error) {
        setActionError(errorText(error));
        await state.refresh();
      }
    },
    [data, state],
  );

  if (!data) {
    if (state.error) {
      return (
        <Notice tone="bad" title="Sidekick's state could not be read" onRetry={() => void state.refresh()}>
          {errorText(state.error)}
        </Notice>
      );
    }
    return <Loading label="Reading Sidekick's tasks…" />;
  }

  return (
    <div className="sk">
      <div className="sk-bar">
        <span className={`mod-chip${data.running ? " on" : ""}`}>
          <span className="mod-dot" aria-hidden="true" />
          {data.running ? "Running" : data.installed ? "Not running" : "Not installed"}
        </span>
        <span className={`mod-chip${data.startOnLogin ? " on" : ""}`}>{data.startOnLogin ? "Starts at sign-in" : "Does not start at sign-in"}</span>
        <span className="sk-bar-spacer" />
        <button className={`btn sm${data.running ? " danger" : " success"}`} disabled={power !== null || !data.installed || Boolean(data.hubError)} onClick={() => void togglePower()} title={data.hubError ? "Starting and stopping Sidekick goes through Script Hub, which is not answering" : undefined}>
          <Icon name="power" size={13} /> {power ? (power === "start" ? "Starting…" : "Stopping…") : data.running ? "Stop Sidekick" : "Start Sidekick"}
        </button>
        <button className="btn primary sm" disabled={Boolean(data.settingsError)} onClick={() => setEditing({ rule: blankRule(data.defaultDebounceSeconds), isNew: true })}>
          <Icon name="plus" size={13} /> New task
        </button>
      </div>

      {state.error ? (
        <Notice tone="bad" title="The last refresh failed" onRetry={() => void state.refresh()}>
          {errorText(state.error)} The tasks below are from {formatAgo(data.generatedAt)}.
        </Notice>
      ) : null}
      {actionError ? <Notice tone="bad" title="Sidekick refused that">{actionError}</Notice> : null}
      {data.hubError ? (
        <Notice tone="warn" title="Script Hub is not answering">
          Sidekick is started and stopped through Script Hub, and companions can name Script Hub entries; both wait until it is back. ({data.hubError})
        </Notice>
      ) : null}
      {!data.installed && !data.hubError ? <Notice tone="warn" title="Sidekick is not installed">Script Hub has no Sidekick entry with a program that exists on this PC.</Notice> : null}
      {data.settingsError ? (
        <Notice tone="bad" title="Sidekick's settings file could not be read">
          {data.settingsError} Fix <code>{data.settingsPath}</code> by hand; GGO will not overwrite it while it is invalid.
        </Notice>
      ) : null}

      {data.rules.length === 0 ? (
        <div className="mod-empty">
          <p>{data.configured ? "Sidekick has no tasks yet." : "Sidekick has not written a settings file yet. Creating a task makes one."}</p>
        </div>
      ) : (
        <div className="sk-rules">
          {data.rules.map((rule, index) => (
            <RuleCard key={rule.id ?? index} rule={rule} hubScripts={data.hubScripts} onEdit={() => setEditing({ rule: structuredClone(rule), isNew: false })} onDelete={() => void remove(rule)} />
          ))}
        </div>
      )}

      <LogTail log={data.log} />

      {editing ? (
        <RuleDialog
          editing={editing}
          revision={data.settingsRevision}
          hubScripts={data.hubScripts}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
          onReload={() => {
            setEditing(null);
            void state.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function blankRule(debounce: number): Rule {
  return { id: null, name: "", enabled: true, triggerProcess: "", debounceSeconds: debounce, closeCompanionsOnExit: true, companions: [blankCompanion()] };
}

function blankCompanion(): Companion {
  return { id: null, name: "", exePath: null, arguments: null, workingDirectory: null, hubId: null, alreadyRunningProcess: null, alreadyRunningPort: null };
}

function RunningDot({ running }: { running: boolean | null | undefined }) {
  const label = running === true ? "running" : running === false ? "not running" : "not checked";
  return <span className={`sk-run sk-run-${running === true ? "on" : running === false ? "off" : "unknown"}`} title={label} aria-label={label} />;
}

function RuleCard({ rule, hubScripts, onEdit, onDelete }: { rule: Rule; hubScripts: SidekickState["hubScripts"]; onEdit: () => void; onDelete: () => void }) {
  const hubName = (id: string | null) => (id ? (hubScripts.find((s) => s.id === id)?.name ?? id) : null);
  return (
    <article className={`sk-rule${rule.enabled ? "" : " is-off"}`}>
      <header className="sk-rule-head">
        <h4>{rule.name || "Unnamed task"}</h4>
        <span className={`mod-badge mod-badge-${rule.enabled ? "running" : "stopped"}`}>{rule.enabled ? "enabled" : "off"}</span>
        <button className="mod-icon-btn" onClick={onEdit} aria-label={`Edit ${rule.name}`} title="Edit">
          <Icon name="pencil" size={14} />
        </button>
        <button className="mod-icon-btn danger" onClick={onDelete} aria-label={`Delete ${rule.name}`} title="Delete">
          <Icon name="trash" size={14} />
        </button>
      </header>
      <div className="sk-trigger">
        <RunningDot running={rule.triggerRunning} />
        When <code>{rule.triggerProcess || "—"}</code> starts
        <span className="faint">
          {" "}
          · after {rule.debounceSeconds}s{rule.closeCompanionsOnExit ? " · closes companions when it exits" : ""}
        </span>
      </div>
      <ul className="sk-companions">
        {rule.companions.map((companion, index) => (
          <li key={companion.id ?? index}>
            <RunningDot running={companion.running} />
            <strong>{companion.name || hubName(companion.hubId) || "Unnamed companion"}</strong>
            <span className="mono faint">{companion.hubId ? `Script Hub · ${hubName(companion.hubId)}` : companion.exePath}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function RuleDialog(props: { editing: Editing; revision: string | null; hubScripts: SidekickState["hubScripts"]; onClose: () => void; onSaved: () => void; onReload: () => void }) {
  const [rule, setRule] = useState<Rule>(props.editing.rule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);
  const patchCompanion = (index: number, patch: Partial<Companion>) => setRule((r) => ({ ...r, companions: r.companions.map((c, i) => (i === index ? { ...c, ...patch } : c)) }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { revision: props.revision, rule: toRequest(rule) };
    try {
      if (props.editing.isNew) await moduleJson("sidekick", "/rules", { method: "POST", body });
      else await moduleJson("sidekick", `/rules/${encodeURIComponent(rule.id!)}`, { method: "PUT", body });
      props.onSaved();
    } catch (err) {
      const stale = err instanceof ModuleRequestError && (err.body.code === "stale_config" || err.body.code === "revision_required");
      setError({ text: errorText(err), stale });
      setSaving(false);
    }
  };

  return (
    <ModuleDialog
      title={props.editing.isNew ? "New Sidekick task" : `Edit ${props.editing.rule.name || "task"}`}
      wide
      onClose={props.onClose}
      footer={
        <>
          {error ? <span className="mod-dialog-error">{error.text}</span> : null}
          {error?.stale ? (
            <button className="btn ghost sm" onClick={props.onReload}>
              Reload tasks
            </button>
          ) : null}
          <button className="btn ghost sm" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save task"}
          </button>
        </>
      }
    >
      <div className="mod-fields">
        <Field label="Task name">
          <input className="mod-input" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Trigger program" hint="The image name, such as Example.exe. * and ? are wildcards.">
          <input className="mod-input mono" value={rule.triggerProcess} onChange={(e) => setRule({ ...rule, triggerProcess: e.target.value })} />
        </Field>
        <Field label="Wait before starting (seconds)">
          <input className="mod-input" type="number" min={0} max={3600} value={rule.debounceSeconds} onChange={(e) => setRule({ ...rule, debounceSeconds: Number(e.target.value) || 0 })} />
        </Field>
        <div className="mod-field mod-field-checks">
          <label className="mod-check">
            <input type="checkbox" checked={rule.enabled} onChange={(e) => setRule({ ...rule, enabled: e.target.checked })} /> Enabled
          </label>
          <label className="mod-check">
            <input type="checkbox" checked={rule.closeCompanionsOnExit} onChange={(e) => setRule({ ...rule, closeCompanionsOnExit: e.target.checked })} /> Close companions when it exits
          </label>
        </div>
      </div>

      <datalist id="sk-hub-scripts">
        {props.hubScripts.map((script) => (
          <option key={script.id} value={script.id}>
            {script.name}
          </option>
        ))}
      </datalist>

      {rule.companions.map((companion, index) => (
        <fieldset className="mod-fieldset" key={companion.id ?? `new-${index}`}>
          <legend>Companion {index + 1}</legend>
          <div className="mod-fields">
            <Field label="Name" hint="Blank uses the Script Hub entry or program name.">
              <input className="mod-input" value={companion.name} onChange={(e) => patchCompanion(index, { name: e.target.value })} />
            </Field>
            <Field label="Script Hub entry" hint="Started and stopped through Script Hub. Or give a program path instead.">
              <input className="mod-input mono" list="sk-hub-scripts" value={companion.hubId ?? ""} onChange={(e) => patchCompanion(index, { hubId: e.target.value || null })} />
            </Field>
            <Field label="Program path" wide>
              <input className="mod-input mono" value={companion.exePath ?? ""} onChange={(e) => patchCompanion(index, { exePath: e.target.value || null })} placeholder="C:\Tools\Example\example.exe" />
            </Field>
            <Field label="Arguments">
              <input className="mod-input mono" value={companion.arguments ?? ""} onChange={(e) => patchCompanion(index, { arguments: e.target.value || null })} />
            </Field>
            <Field label="Working folder">
              <input className="mod-input mono" value={companion.workingDirectory ?? ""} onChange={(e) => patchCompanion(index, { workingDirectory: e.target.value || null })} />
            </Field>
            <Field label="Already running if this program runs">
              <input className="mod-input mono" value={companion.alreadyRunningProcess ?? ""} onChange={(e) => patchCompanion(index, { alreadyRunningProcess: e.target.value || null })} />
            </Field>
            <Field label="…or this local port answers">
              <input className="mod-input" type="number" min={1} max={65535} value={companion.alreadyRunningPort ?? ""} onChange={(e) => patchCompanion(index, { alreadyRunningPort: e.target.value ? Number(e.target.value) : null })} />
            </Field>
          </div>
          <button className="btn danger sm" onClick={() => setRule((r) => ({ ...r, companions: r.companions.filter((_, i) => i !== index) }))}>
            <Icon name="trash" size={13} /> Remove companion
          </button>
        </fieldset>
      ))}
      <button className="btn ghost sm mod-add" onClick={() => setRule((r) => ({ ...r, companions: [...r.companions, blankCompanion()] }))}>
        <Icon name="plus" size={13} /> Add a companion
      </button>
    </ModuleDialog>
  );
}

/** The editor's rule as the API takes it: status fields dropped, blank strings sent as null. */
function toRequest(rule: Rule) {
  return {
    ...(rule.id ? { id: rule.id } : {}),
    name: rule.name,
    enabled: rule.enabled,
    triggerProcess: rule.triggerProcess,
    debounceSeconds: rule.debounceSeconds,
    closeCompanionsOnExit: rule.closeCompanionsOnExit,
    companions: rule.companions.map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      name: c.name.trim() || null,
      exePath: c.exePath,
      arguments: c.arguments,
      workingDirectory: c.workingDirectory,
      hubId: c.hubId,
      alreadyRunningProcess: c.alreadyRunningProcess,
      alreadyRunningPort: c.alreadyRunningPort,
    })),
  };
}

function LogTail({ log }: { log: SidekickState["log"] }) {
  return (
    <section className="sk-log">
      <header>
        <h4>Recent activity</h4>
        <span className="mono faint">{log.updatedAt ? `log written ${formatAgo(log.updatedAt)}` : "no log yet"}</span>
      </header>
      {log.entries.length ? (
        <ol>
          {[...log.entries].reverse().map((entry, index) => (
            <li key={index} className={`sk-log-${entry.level.toLowerCase()}`}>
              <span className="mono faint">{entry.time ?? ""}</span>
              <span className="sk-log-level mono">{entry.level}</span>
              <span>{entry.message}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="faint">Sidekick has not logged anything yet.</p>
      )}
    </section>
  );
}
