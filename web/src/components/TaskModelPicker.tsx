import { useEffect, useMemo, useRef, useState } from "react";
import { modelLabel } from "../lib/format.js";
import { mergeModelOptions } from "../lib/models.js";
import { useStore } from "../store.js";
import type { ImplementorProvider, ModelRequest, OrchestratorSettings, Thread } from "../types.js";

const PROVIDERS: ImplementorProvider[] = ["claude", "codex", "grok", "zai"];
const PROVIDER_LABEL: Record<ImplementorProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  zai: "z.ai",
};

export interface TaskModelTarget {
  provider: ImplementorProvider;
  label: string;
  models: string[];
  enabled: boolean;
}

/** The task picker uses the same server-published catalogs as Settings and Co-work. Keep a task's
 * existing pin visible even when its provider was disabled or its model later left the live roster,
 * so the owner can understand and clear/change it instead of seeing a blank form. */
export function taskModelTargets(settings: OrchestratorSettings, current?: ModelRequest | null): TaskModelTarget[] {
  const configured: Record<ImplementorProvider, readonly string[]> = {
    claude: settings.claudeModels.length
      ? settings.claudeModels
      : [settings.modelDefaults.implementor].filter((model): model is string => !!model),
    codex: settings.codexModels,
    grok: settings.grokModels,
    zai: settings.zaiModels,
  };
  const enabled: Record<ImplementorProvider, boolean> = {
    claude: true,
    codex: settings.codexEnabled,
    grok: settings.grokEnabled,
    zai: settings.zaiEnabled,
  };

  return PROVIDERS
    .map((provider) => ({
      provider,
      label: PROVIDER_LABEL[provider],
      enabled: enabled[provider],
      models: mergeModelOptions(
        configured[provider],
        current?.provider === provider && current.model ? [current.model] : [],
      ),
    }))
    .filter((target) => target.models.length > 0 && (target.enabled || current?.provider === target.provider));
}

function ModelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  );
}

export function TaskModelPicker({ thread, active }: { thread: Thread; active: boolean }) {
  const settings = useStore((state) => state.settings);
  const setTaskModel = useStore((state) => state.setTaskModel);
  const targets = useMemo(() => taskModelTargets(settings, thread.modelRequest), [settings, thread.modelRequest]);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ImplementorProvider>("claude");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const target = targets.find((item) => item.provider === provider) ?? targets[0];
  const request = thread.modelRequest;
  const exactPin = !!request?.provider && !!request.model;
  // An unresolved strict request is not Auto routing: it still blocks substitution until the owner
  // chooses an exact target or explicitly clears it. Keep that legacy state visible on the trigger.
  const constrained = !!request;
  const currentLabel = exactPin
    ? `${PROVIDER_LABEL[request.provider!]} · ${modelLabel(request.model)}`
    : request
      ? `Unresolved · ${request.requested}`
      : "Auto routing";

  const openPicker = () => {
    const initial = (request?.provider && targets.find((item) => item.provider === request.provider)) || targets.find((item) => item.enabled) || targets[0];
    if (initial) {
      setProvider(initial.provider);
      setModel(request?.provider === initial.provider && request.model && initial.models.includes(request.model) ? request.model : initial.models[0] ?? "");
    }
    setError("");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const apply = async (nextProvider: ImplementorProvider | null, nextModel: string | null) => {
    if (active) {
      setError("Interrupt the running implementor first. A provider process cannot switch models safely mid-run.");
      return;
    }
    setError("");
    setBusy(true);
    const ok = await setTaskModel(thread.id, nextProvider, nextModel);
    setBusy(false);
    if (ok) setOpen(false);
    else setError("The task did not accept this model change. Check the task notice and try again.");
  };

  return (
    <div className="task-model-picker" ref={rootRef}>
      <button
        type="button"
        className={`task-model-trigger${constrained ? " pinned" : ""}`}
        aria-label="Choose task provider and model"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Task model: ${currentLabel}. Click to choose the exact provider and model.`}
        data-task-model={request?.model ?? request?.requested ?? "auto"}
        onClick={() => open ? setOpen(false) : openPicker()}
      >
        <ModelIcon />
        <span className="task-model-dot" aria-hidden="true" />
      </button>
      {open ? (
        <div className="task-model-popover" role="dialog" aria-label="Choose exact task model">
          <div className="task-model-head">
            <div>
              <strong>Task model</strong>
              <span>{currentLabel}</span>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close model picker">×</button>
          </div>
          <div className="task-model-fields">
            <label>
              <span>Provider</span>
              <select
                aria-label="Task provider"
                value={target?.provider ?? ""}
                disabled={busy || !targets.length}
                onChange={(event) => {
                  const next = event.target.value as ImplementorProvider;
                  setProvider(next);
                  setModel(targets.find((item) => item.provider === next)?.models[0] ?? "");
                }}
              >
                {targets.map((item) => (
                  <option key={item.provider} value={item.provider} disabled={!item.enabled}>
                    {item.label}{item.enabled ? "" : " (disabled)"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Model</span>
              <select
                aria-label="Task model"
                value={model}
                disabled={busy || !target?.enabled || !target.models.length}
                onChange={(event) => setModel(event.target.value)}
              >
                {(target?.models ?? []).map((option) => <option key={option} value={option}>{modelLabel(option)}</option>)}
              </select>
            </label>
          </div>
          <p className={active ? "task-model-warning active" : "task-model-warning"}>
            {active
              ? "Interrupt the current implementor before changing this pin. Its files and saved task history stay intact."
              : "An exact pin never falls back. If that model is unavailable or capped, this task waits or stops visibly."}
          </p>
          {error ? <div className="task-model-error" role="alert">{error}</div> : null}
          <div className="task-model-actions">
            <button type="button" className="btn ghost sm" disabled={busy || active || !request} onClick={() => void apply(null, null)}>
              Use Auto
            </button>
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || active || !target?.enabled || !model}
              onClick={() => void apply(target?.provider ?? null, model || null)}
            >
              {busy ? "Saving…" : "Pin exact model"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
