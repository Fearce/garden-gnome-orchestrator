import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import type { ModelOverrides, Role } from "../types.js";

/** Shared read/update surface for the per-(subscription x role) model matrix. Sends the full overrides
 *  map on each change (it's small), which the server sanitizes and persists. */
export function useModelOverrides() {
  const overrides = useStore((s) => s.settings.modelOverrides);
  const setSettings = useStore((s) => s.setSettings);
  const setModel = (subId: string, role: Role, model: string) => {
    const next: ModelOverrides = {};
    for (const [sid, roles] of Object.entries(overrides ?? {})) next[sid] = { ...roles };
    const sub = { ...(next[subId] ?? {}) };
    if (model) sub[role] = model;
    else delete sub[role];
    if (Object.keys(sub).length) next[subId] = sub;
    else delete next[subId];
    setSettings({ modelOverrides: next });
  };
  return { overrides: overrides ?? {}, setModel };
}

const CUSTOM = "__custom__";

/** A model dropdown. When `allowInherit`, a leading option ("" value) is the inherit/default fallback
 *  labelled by `defaultLabel`. The live model list follows; a "Custom..." entry reveals a free-text
 *  field for any id not in the list. */
export function ModelSelect({
  value,
  options,
  onChange,
  allowInherit = true,
  defaultLabel = "",
  ariaLabel,
  title,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  allowInherit?: boolean;
  defaultLabel?: string;
  ariaLabel?: string;
  title?: string;
}) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(value);
  // Don't clobber an in-progress custom-entry draft if a settings rebroadcast changes `value` mid-type.
  useEffect(() => {
    if (!custom) setDraft(value);
  }, [value, custom]);

  if (custom) {
    const commit = () => {
      onChange(draft.trim());
      setCustom(false);
    };
    return (
      <input
        className="model-input"
        autoFocus
        value={draft}
        spellCheck={false}
        autoComplete="off"
        aria-label={ariaLabel}
        title={title}
        placeholder="type a model id..."
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setCustom(false);
          }
        }}
      />
    );
  }

  const known = new Set(options);
  return (
    <select
      className={"model-select" + (allowInherit && !value ? " inherited" : "")}
      value={value}
      aria-label={ariaLabel}
      title={title}
      onChange={(e) => {
        const v = e.target.value;
        if (v === CUSTOM) {
          setDraft("");
          setCustom(true);
        } else onChange(v);
      }}
    >
      {allowInherit && <option value="">{defaultLabel}</option>}
      {value && !known.has(value) && <option value={value}>{value}</option>}
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      <option value={CUSTOM}>Custom...</option>
    </select>
  );
}
