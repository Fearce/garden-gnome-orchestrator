import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../store.js";
import { CODEX_MODELS } from "../types.js";

/** The gear-icon panel: everything that isn't a per-task agent toggle (those live in the topbar).
 *  A light popover anchored under the topbar with a click-anywhere-outside backdrop to dismiss. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const showCompleted = useStore((s) => s.showCompleted);
  const setShowCompleted = useStore((s) => s.setShowCompleted);
  const verbosity = useStore((s) => s.verbosity);
  const setVerbosity = useStore((s) => s.setVerbosity);
  const taskDragAndDrop = useStore((s) => s.taskDragAndDrop);
  const setTaskDragAndDrop = useStore((s) => s.setTaskDragAndDrop);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings-pop" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Settings</h3>
          <button className="settings-x" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </div>

        <Group label="Pipeline">
          <ToggleRow
            label="Auto-push"
            hint="On: completed tasks commit AND push. Off: implementor commits locally only — you push manually."
            on={settings.autoPush}
            onChange={(v) => setSettings({ autoPush: v })}
          />
          <NumberRow
            label="Max QA rounds"
            hint="How many implementor↔QA fix-rounds before a task settles to review."
            value={settings.maxQaRounds}
            min={1}
            max={12}
            onChange={(v) => setSettings({ maxQaRounds: v })}
          />
          <NumberRow
            label="Max concurrent tasks"
            hint="Pipelines allowed to run at once. Dispatches beyond this wait in a queued lane and start as slots free."
            value={settings.maxConcurrent}
            min={1}
            max={20}
            onChange={(v) => setSettings({ maxConcurrent: v })}
          />
          <ToggleRow
            label="Token safety limit"
            hint="On: when live token usage reaches the threshold below, every running task is stopped automatically to protect your remaining allowance. Off by default."
            on={settings.tokenLimitEnabled}
            onChange={(v) => setSettings({ tokenLimitEnabled: v })}
          />
          {settings.tokenLimitEnabled && (
            <NumberRow
              label="Stop at usage %"
              hint="The token-usage threshold that trips the safety stop. Tracks the same live burn as the account meters; refreshes on the ~10-min usage ping, so it can lag a fast burn by minutes."
              value={settings.tokenLimitPercent}
              min={50}
              max={99}
              onChange={(v) => setSettings({ tokenLimitPercent: v })}
            />
          )}
        </Group>

        <Group label="Subscriptions">
          <SubscriptionsSection />
        </Group>

        <Group label="Composer">
          <NumberRow
            label="Recent repo chips"
            hint="How many recent-repo shortcuts show under the composer. The list and the skip-director toggle persist server-side, so they survive a reload on any surface."
            value={settings.maxRecentRepos}
            min={1}
            max={20}
            onChange={(v) => setSettings({ maxRecentRepos: v })}
          />
        </Group>

        <Group label="Board">
          <ToggleRow
            label="Show completed tasks"
            hint="Off: done & cancelled tasks are hidden from the board (still in the DB / Closed list)."
            on={showCompleted}
            onChange={setShowCompleted}
          />
          <SegmentRow
            label="Task output"
            hint="Compact: cards show only their state. Full: cards show the agent's latest streaming line."
            value={verbosity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "full", label: "Full" },
            ]}
            onChange={setVerbosity}
          />
          <ToggleRow
            label="Drag to reorder"
            hint="On: a grip appears on each card — drag to arrange the board by hand. Suspends the automatic most-recent-first ordering and remembers your order."
            on={taskDragAndDrop}
            onChange={setTaskDragAndDrop}
          />
        </Group>

        <p className="settings-note">
          Agent toggles (planner · researcher · QA) live in the top bar — flip them per task before dispatching.
        </p>
      </div>
    </div>
  );
}

/** The implementor backends. Each Claude account (Anthropic subscription) is an independently
 *  toggleable card — disabling one holds it out of the dispatch/failover rotation; Claude always
 *  powers the planner/researcher/QA. Codex (OpenAI), when enabled with a valid key, takes over
 *  implementing tasks. The server enforces all of this as a hard gate — these aren't just UI state. */
function SubscriptionsSection() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const accounts = useStore((s) => s.accounts);
  const setAccountEnabled = useStore((s) => s.setAccountEnabled);
  const testCodex = useStore((s) => s.testCodex);
  const codexTest = useStore((s) => s.codexTest);
  const codexTesting = useStore((s) => s.codexTesting);

  const [keyDraft, setKeyDraft] = useState("");
  const [reveal, setReveal] = useState(false);

  // Codex auth is usable via EITHER a ChatGPT-plan `codex login` (preferred — no API billing) or a key.
  const codexHasAuth = settings.codexChatgptLogin || settings.hasOpenaiKey;
  const codexActive = settings.codexEnabled && codexHasAuth;
  const enabledAccounts = accounts.filter((a) => a.enabled).length;
  const draftValid = /^sk-\S{8,}$/.test(keyDraft.trim());
  const draftBad = keyDraft.trim().length > 0 && !keyDraft.trim().startsWith("sk-");

  const saveKey = () => {
    if (!draftValid) return;
    setSettings({ openaiApiKey: keyDraft.trim() });
    setKeyDraft("");
    setReveal(false);
  };
  const clearKey = () => {
    setSettings({ openaiApiKey: "" });
    setKeyDraft("");
  };

  return (
    <div className="subs">
      {accounts.map((acct) => (
        <AccountCard
          key={acct.id}
          acct={acct}
          implementing={!codexActive}
          canDisable={enabledAccounts > 1}
          onToggle={(v) => setAccountEnabled(acct.id, v)}
        />
      ))}

      <SubCard
        name="ChatGPT Codex"
        vendor="OpenAI"
        on={settings.codexEnabled}
        active={codexActive}
        activeLabel="implementing"
        toggleDisabled={!settings.codexEnabled && !codexHasAuth}
        toggleTitle={!codexHasAuth ? "Sign in with `codex login` (ChatGPT plan) or add an API key first" : undefined}
        onToggle={(v) => setSettings({ codexEnabled: v })}
        meta={
          settings.codexEnabled
            ? codexHasAuth
              ? `Implementing tasks via the Codex CLI${settings.codexChatgptLogin ? " · ChatGPT plan login" : ""} · model ${settings.codexModel}`
              : "Enabled but no usable auth — sign in with `codex login` or add a key below before tasks can route here."
            : "Off — enable to implement tasks with the Codex CLI instead of Claude."
        }
      >
        {settings.codexChatgptLogin && (
          <div className="sub-msg ok">
            Authenticated via your ChatGPT plan (<code>codex login</code>) — no API key needed. The key below is only used as a fallback if that login is removed.
          </div>
        )}

        <div className="sub-field">
          <label className="sub-label">OpenAI API key{settings.codexChatgptLogin ? " (optional fallback)" : ""}</label>
          <div className={"key-input" + (draftBad ? " bad" : "")}>
            <input
              type={reveal ? "text" : "password"}
              value={keyDraft}
              spellCheck={false}
              autoComplete="off"
              placeholder={settings.hasOpenaiKey ? `sk-••••••••${settings.openaiKeyLast4 ?? ""}` : "sk-…"}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveKey();
              }}
            />
            <button
              type="button"
              className="key-eye"
              aria-label={reveal ? "Hide key" : "Reveal key"}
              title={reveal ? "Hide" : "Reveal"}
              onClick={() => setReveal((r) => !r)}
            >
              {reveal ? <EyeOff /> : <Eye />}
            </button>
          </div>
          <div className="sub-actions">
            <button className="sub-btn primary" disabled={!draftValid} onClick={saveKey}>
              {settings.hasOpenaiKey ? "Replace key" : "Save key"}
            </button>
            <button className="sub-btn" disabled={codexTesting || (!keyDraft.trim() && !settings.hasOpenaiKey)} onClick={() => testCodex(keyDraft.trim() || undefined)}>
              {codexTesting ? "Testing…" : "Test connection"}
            </button>
            {settings.hasOpenaiKey && (
              <button className="sub-btn ghost" onClick={clearKey}>
                Remove
              </button>
            )}
          </div>
          {draftBad && <div className="sub-msg bad">An OpenAI key starts with sk-.</div>}
          {codexTest && !draftBad && <div className={"sub-msg" + (codexTest.ok ? " ok" : " bad")}>{codexTest.message}</div>}
          {!codexTest && settings.hasOpenaiKey && !draftBad && <div className="sub-msg dim">Key stored (••••{settings.openaiKeyLast4 ?? ""}). Test it to confirm it works.</div>}
        </div>

        <ModelField value={settings.codexModel} onCommit={(m) => setSettings({ codexModel: m })} />
      </SubCard>
    </div>
  );
}

/** One Claude account (Anthropic subscription) as a toggleable card with its live 5h/weekly burn. */
function AccountCard({
  acct,
  implementing,
  canDisable,
  onToggle,
}: {
  acct: import("../types.js").AccountDTO;
  implementing: boolean;
  canDisable: boolean;
  onToggle: (v: boolean) => void;
}) {
  const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n)}%`);
  const lockedOn = acct.enabled && !canDisable;
  const meta = !acct.enabled
    ? "Disabled — held out of the dispatch & failover rotation."
    : acct.rateLimited
      ? "Rate-limited right now — skipped until its window resets."
      : `weekly ${pct(acct.sevenDay)} · 5h ${pct(acct.fiveHour)}${acct.stale ? " · usage stale" : ""}`;
  return (
    <div className={"sub-card" + (implementing && acct.active && acct.enabled ? " active" : "")}>
      <div className="sub-card-head">
        <div className="sub-id">
          <span className="sub-name">{acct.label}</span>
          <span className="sub-vendor">Anthropic · Claude</span>
          {acct.active && acct.enabled && <span className="sub-badge">{implementing ? "implementing" : "active"}</span>}
          {acct.rateLimited && <span className="sub-badge warn">rate-limited</span>}
        </div>
        <button
          className={"switch" + (acct.enabled ? " on" : "")}
          role="switch"
          aria-checked={acct.enabled}
          aria-label={`${acct.label} account`}
          disabled={lockedOn}
          title={lockedOn ? "Can't disable the last active Claude account" : undefined}
          onClick={() => !lockedOn && onToggle(!acct.enabled)}
        >
          <span className="switch-knob" />
        </button>
      </div>
      <div className="sub-card-meta">{meta}</div>
    </div>
  );
}

/** Free-text Codex model field with flagship suggestions — commits on blur / Enter / pick so a change
 *  isn't sent on every keystroke. Any model id the OpenAI key can access is valid. */
function ModelField({ value, onCommit }: { value: string; onCommit: (m: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
    else if (!v) setDraft(value);
  };
  return (
    <div className="sub-field">
      <label className="sub-label">Model</label>
      <input
        className="model-input"
        list="codex-model-suggestions"
        value={draft}
        spellCheck={false}
        autoComplete="off"
        placeholder="gpt-5.5"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <datalist id="codex-model-suggestions">
        {CODEX_MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <div className="sub-msg dim">Flagship suggestions in the list — or type any model your key can access.</div>
    </div>
  );
}

function SubCard({
  name,
  vendor,
  on,
  active,
  activeLabel,
  meta,
  onToggle,
  toggleDisabled,
  toggleTitle,
  children,
}: {
  name: string;
  vendor: string;
  on: boolean;
  active: boolean;
  activeLabel: string;
  meta: string;
  onToggle: (v: boolean) => void;
  toggleDisabled?: boolean;
  toggleTitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className={"sub-card" + (active ? " active" : "")}>
      <div className="sub-card-head">
        <div className="sub-id">
          <span className="sub-name">{name}</span>
          <span className="sub-vendor">{vendor}</span>
          {active && <span className="sub-badge">{activeLabel}</span>}
        </div>
        <button
          className={"switch" + (on ? " on" : "")}
          role="switch"
          aria-checked={on}
          aria-label={`${name} subscription`}
          disabled={toggleDisabled}
          title={toggleTitle}
          onClick={() => !toggleDisabled && onToggle(!on)}
        >
          <span className="switch-knob" />
        </button>
      </div>
      <div className="sub-card-meta">{meta}</div>
      {children}
    </div>
  );
}

const Eye = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOff = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68M6.6 6.6A13.3 13.3 0 0 0 2 12s3.5 7 10 7a9.1 9.1 0 0 0 4.4-1.1" />
    <path d="m9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="M2 2l20 20" />
  </svg>
);

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="settings-group">
      <div className="settings-group-label">{label}</div>
      {children}
    </div>
  );
}

function Row({ label, hint, control }: { label: string; hint: string; control: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        <div className="settings-row-hint">{hint}</div>
      </div>
      {control}
    </div>
  );
}

function ToggleRow({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <button
          className={"switch" + (on ? " on" : "")}
          role="switch"
          aria-checked={on}
          aria-label={label}
          onClick={() => onChange(!on)}
        >
          <span className="switch-knob" />
        </button>
      }
    />
  );
}

function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    if (!draft.trim()) {
      setDraft(String(value));
      return;
    }
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(Math.round(n));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  const step = (delta: number) => {
    const next = clamp(value + delta);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <div className="stepper">
          <button aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => step(-1)}>
            −
          </button>
          <input
            className="stepper-val mono"
            aria-label={label}
            inputMode="numeric"
            pattern="[0-9]*"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft(String(value));
              }
            }}
          />
          <button aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => step(1)}>
            +
          </button>
        </div>
      }
    />
  );
}

function SegmentRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <div className="segment">
          {options.map((o) => (
            <button key={o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      }
    />
  );
}
