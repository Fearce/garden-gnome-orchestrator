import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "../store.js";
import { apiUrl } from "../lib/base.js";
import { CODEX_EFFORTS, CODEX_SUB_ID, EFFORTS, GROK_EFFORTS, GROK_SUB_ID, MODEL_ROLES, type CodexEffort, type Effort, type GrokEffort, type Role } from "../types.js";
import { codexModelOptions, grokModelOptions } from "../lib/models.js";
import { ModelSelect, useModelOverrides } from "./ModelSelect.js";

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
            label="Self-improve after tasks"
            hint="On: once a task is accepted (QA pass, or a clean finish with QA off), the implementor runs one bonus round — 'what tools/skills/memories would have made this easier? Build them.' — before the task settles to done. Off by default; the extra round costs extra tokens."
            on={settings.selfImproveEnabled}
            onChange={(v) => setSettings({ selfImproveEnabled: v })}
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
          <ToggleRow
            label="Auto-resume on token reset"
            hint="On: when usage crosses the threshold below, schedule a wakeup at the window's reset that resumes any paused or cap-parked tasks — so work picks back up on its own after the window frees, even if you're away. Off by default."
            on={settings.autoResumeOnTokenReset}
            onChange={(v) => setSettings({ autoResumeOnTokenReset: v })}
          />
          {settings.autoResumeOnTokenReset && (
            <NumberRow
              label="Resume threshold %"
              hint="Usage level at which the reset-timed resume is armed. When live burn crosses this, a wakeup is scheduled for the soonest window reset to continue frozen work."
              value={settings.autoResumeThresholdPercent}
              min={50}
              max={95}
              onChange={(v) => setSettings({ autoResumeThresholdPercent: v })}
            />
          )}
          <ToggleRow
            label="Fast usage polling"
            hint="On: refresh the account usage meters every ~30s so the % and reset countdown track Claude's own UI within ~1-2%, instead of lagging up to 10 minutes behind a live burn. Costs a tiny extra Haiku ping per account. Off by default."
            on={settings.fastUsagePolling}
            onChange={(v) => setSettings({ fastUsagePolling: v })}
          />
        </Group>

        <Group label="Director">
          <TextRow
            label="Director name"
            hint="What your Sonnet director is called across the console and the office chat. Pick a name so it reads as yours."
            value={settings.directorName}
            placeholder="ChangeNameInSettings"
            maxLength={40}
            onChange={(v) => setSettings({ directorName: v })}
          />
        </Group>

        <Group label="Voice mode">
          <VoiceSection />
        </Group>

        <Group label="Subscriptions">
          <SubscriptionsSection />
        </Group>

        <Group label="Composer">
          <ToggleRow
            label="Show model & effort pickers"
            hint="Off (default): the director composer stays compact. On: show the quick implementor model dropdowns (Claude/Codex) and, in skip-director mode, the effort dropdowns."
            on={settings.showComposerPickers}
            onChange={(v) => setSettings({ showComposerPickers: v })}
          />
          <ToggleRow
            label="Name skipped tasks with Haiku"
            hint="When the director is skipped, mint a concise task title with one cheap Haiku call instead of using the raw first line. Off: keep the verbatim first line and spend zero extra tokens."
            on={settings.skipDirectorRetitle}
            onChange={(v) => setSettings({ skipDirectorRetitle: v })}
          />
          <NumberRow
            label="Recent repo chips"
            hint="How many recent-repo shortcuts show under the composer. The list and the skip-director toggles persist server-side, so they survive a reload on any surface."
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
          <ToggleRow
            label="Show agent model"
            hint={'On: agent labels in the task feed name the model they ran on — "QA (Tor, Opus 4.8 High)". Off: just the agent name.'}
            on={settings.showAgentModel}
            onChange={(v) => setSettings({ showAgentModel: v })}
          />
        </Group>

        <p className="settings-note">
          Agent toggles (planner · researcher · QA) live in the top bar — flip them per task before dispatching.
        </p>
      </div>
    </div>
  );
}

interface VoiceSettingsDTO {
  audio: { input_device: string | null; output_device: string | null; volume: number; inputs: string[]; outputs: string[] };
  wake: { wake_phrases: string[] };
}

/** Voice-mode-only settings, stored in the voice-gateway (not OrchestratorSettings): which mic the
 *  wake listener + PTT record from, which speaker replies play on, and the wake phrase that opens a
 *  conversation. Lives behind the /api/voice/settings bridge; when the gateway is down the section
 *  is a single dim line and nothing outside voice mode is affected. */
function VoiceSection() {
  const [dto, setDto] = useState<VoiceSettingsDTO | "loading" | "offline">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch(apiUrl("/api/voice/settings"), { cache: "no-store" });
        if (!r.ok) throw new Error();
        const j = (await r.json()) as VoiceSettingsDTO;
        if (live) setDto(j);
      } catch {
        if (live) setDto("offline");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const push = async (patch: object) => {
    setError(null);
    try {
      const r = await fetch(apiUrl("/api/voice/settings"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = (await r.json()) as VoiceSettingsDTO & { error?: string };
      if (!r.ok) {
        setError(j?.error || "The voice gateway rejected that change.");
        return;
      }
      setDto(j);
    } catch {
      setError("Voice gateway unreachable — change not saved.");
    }
  };

  if (dto === "loading") return <p className="settings-note">Checking the voice gateway…</p>;
  if (dto === "offline")
    return (
      <p className="settings-note">
        Voice gateway offline — these controls appear when voice mode is available (start voice-gateway in Script Hub). Everything
        outside voice mode works as usual.
      </p>
    );

  return (
    <>
      <DeviceRow
        label="Microphone"
        hint="Input device the wake listener and push-to-talk record from. Applies live."
        value={dto.audio.input_device}
        options={dto.audio.inputs}
        onChange={(v) => void push({ audio: { input_device: v } })}
      />
      <DeviceRow
        label="Speaker"
        hint="Output device the director's spoken replies and cues play on. Applies live."
        value={dto.audio.output_device}
        options={dto.audio.outputs}
        onChange={(v) => void push({ audio: { output_device: v } })}
      />
      <SliderRow
        label="Volume"
        hint="Playback loudness for spoken replies and cues. 100% is full scale; lower to soften without touching the system mixer."
        value={dto.audio.volume ?? 1}
        onChange={(v) => void push({ audio: { volume: v } })}
      />
      <TextRow
        label="Wake phrase"
        hint='What you say to open a conversation. Comma-separate variants the transcriber might mishear (e.g. "hey claude, hey cloud").'
        value={dto.wake.wake_phrases.join(", ")}
        placeholder="hey claude"
        maxLength={200}
        onChange={(v) => {
          const phrases = v.split(",").map((s) => s.trim()).filter(Boolean);
          if (phrases.length) void push({ wake: { wake_phrases: phrases } });
          else setError("At least one wake phrase is required.");
        }}
      />
      {error && <div className="sub-msg bad">{error}</div>}
      <p className="settings-note">Only affects hands-free voice mode (desk mic + spoken replies) — typing in the console is untouched.</p>
    </>
  );
}

/** An audio-device dropdown: system default plus the gateway's device list. The gateway matches the
 *  stored name as a SUBSTRING, so a configured value that isn't verbatim in the list still resolves —
 *  it stays visible as its own option, flagged "(not connected)" only when nothing matches it. */
function DeviceRow({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
}) {
  const exact = value != null && options.includes(value);
  const resolves = value != null && options.some((o) => o.toLowerCase().includes(value.toLowerCase()));
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <select className="model-select voice-device" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">System default</option>
          {value != null && !exact && <option value={value}>{resolves ? value : `${value} (not connected)`}</option>}
          {options.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      }
    />
  );
}

/** A 0–100% volume slider. Drags update the local draft continuously (smooth thumb + live readout)
 *  but only commit to the gateway on release — each POST reopens audio and echoes a fresh DTO, so
 *  firing one per drag frame would fight the drag. Stored as a 0.0–1.0 gain. */
function SliderRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const toPct = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100);
  const [draft, setDraft] = useState(toPct(value));
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setDraft(toPct(value));
  }, [value, dragging]);

  const commit = (pct: number) => {
    setDragging(false);
    if (pct !== toPct(value)) onChange(pct / 100);
  };
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <div className="slider">
          <input
            type="range"
            className="slider-range"
            aria-label={label}
            style={{ "--fill": `${draft}%` } as CSSProperties}
            min={0}
            max={100}
            step={1}
            value={draft}
            onChange={(e) => {
              setDragging(true);
              setDraft(Number(e.target.value));
            }}
            onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onPointerCancel={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onBlur={(e) => commit(Number((e.target as HTMLInputElement).value))}
          />
          <span className="slider-val mono">{draft}%</span>
        </div>
      }
    />
  );
}

/** Per-(subscription × role) model overrides, collapsed by default. One grid shared by every subscription
 *  card — a Claude account, Codex, or Grok — so each role can run a different model on that subscription.
 *  An unset row inherits the subscription's default (the built-in per-role Claude model, or a CLI backend's
 *  configured default), labelled by `defaultLabelFor`. There is no longer a global "default" override layer:
 *  a role either has a per-subscription pick here or falls straight through to the built-in default. */
function SubRoleModels({
  subId,
  models,
  defaultLabelFor,
  roles = MODEL_ROLES,
}: {
  subId: string;
  models: string[];
  defaultLabelFor: (role: Role) => string;
  roles?: readonly Role[];
}) {
  const [open, setOpen] = useState(false);
  const { overrides, setModel } = useModelOverrides();
  const sub = overrides[subId] ?? {};
  const count = roles.filter((r) => sub[r]).length;
  return (
    <div className="sub-field">
      <button className={"sub-disclosure" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <Caret /> Per-role models{count ? ` · ${count} overriding` : " · all inherit default"}
      </button>
      {open && (
        <div className="sub-models">
          {roles.map((role) => (
            <div className="sub-model-row" key={role}>
              <span className="sub-model-label">{role}</span>
              <ModelSelect
                value={sub[role] ?? ""}
                options={models}
                defaultLabel={`Inherit (${defaultLabelFor(role)})`}
                onChange={(m) => setModel(subId, role, m)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const Caret = () => (
  <svg className="caret" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 1l5 4-5 4" />
  </svg>
);

/** Per-role model overrides for one Claude subscription — each row inherits the built-in per-role default
 *  unless set. Lets the operator run, e.g., a heavier model for implementor on one sub. */
function AccountModels({ accountId }: { accountId: string }) {
  const models = useStore((s) => s.settings.claudeModels);
  const defaults = useStore((s) => s.settings.modelDefaults);
  return <SubRoleModels subId={accountId} models={models} defaultLabelFor={(role) => defaults[role] ?? "—"} />;
}

/** The MAX reasoning-effort cap for one Claude account. `max` means uncapped, so it's dropped from the
 *  persisted map (kept lean). xhigh is only offered when the ENABLE_XHIGH opt-in is on. */
function AccountEffort({ accountId }: { accountId: string }) {
  const caps = useStore((s) => s.settings.accountEffortCaps);
  const xhighEnabled = useStore((s) => s.settings.xhighEnabled);
  const setSettings = useStore((s) => s.setSettings);
  const value = caps[accountId] ?? "max";
  const options = EFFORTS.filter((e) => e !== "xhigh" || xhighEnabled);
  const onChange = (v: string) => {
    const next: Record<string, Effort> = { ...caps };
    if (v === "max") delete next[accountId];
    else next[accountId] = v as Effort;
    setSettings({ accountEffortCaps: next });
  };
  return <EffortCapField value={value} options={options} onChange={onChange} />;
}

/** Roles a CLI backend (Codex/Grok) can run. Director is excluded — it drives the console via MCP
 *  dispatch/memory tools no CLI adapter provides, so it always runs on Claude. */
const CLI_ROLES: readonly Role[] = MODEL_ROLES.filter((r) => r !== "director");

/** A per-subscription MAX reasoning-effort cap. The director/planner still picks the per-task effort;
 *  this only bounds it, so a tiny task stays cheap while nothing on this sub exceeds the chosen tier. */
function EffortCapField({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (v: string) => void }) {
  return (
    <div className="sub-field">
      <label className="sub-label">Max reasoning effort</label>
      <div className="sub-segment">
        <div className="segment">
          {options.map((v) => (
            <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="sub-msg dim">The director picks each task's effort up to this cap — tiny tasks still run low.</div>
    </div>
  );
}

/** The implementor + role backends. Each Claude account (Anthropic subscription) is an independently
 *  toggleable card — disabling one holds it out of the dispatch/failover rotation. Codex (OpenAI) and Grok
 *  (xAI), when enabled with valid auth, join the rotation: they implement tasks, and any role (planner/
 *  researcher/QA) fails over to them when every Claude sub is maxed. The server enforces all of this as a
 *  hard gate — these aren't just UI state. */
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
  const grokActive = settings.grokEnabled && settings.grokSignedIn;
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
              ? `Implementing tasks via the Codex CLI${settings.codexChatgptLogin ? " · ChatGPT plan login" : ""} · model ${settings.codexModel} · ${settings.codexEffort} max effort`
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

        <CodexModels />
        <CodexEffortField />
      </SubCard>

      <SubCard
        name="Grok (SuperGrok)"
        vendor="xAI"
        on={settings.grokEnabled}
        active={grokActive}
        activeLabel="in rotation"
        toggleDisabled={!settings.grokEnabled && !settings.grokSignedIn}
        toggleTitle={!settings.grokSignedIn ? "Sign in with `grok login` first" : undefined}
        onToggle={(v) => setSettings({ grokEnabled: v })}
        meta={
          settings.grokEnabled
            ? settings.grokSignedIn
              ? `In the rotation via the Grok CLI${settings.grokAccount ? ` · ${settings.grokAccount}` : ""} · model ${settings.grokModel} · ${settings.grokEffort} max effort`
              : "Enabled but not signed in — run `grok login` before tasks can route here."
            : "Off — enable to add Grok to the implementor + role-failover rotation."
        }
      >
        {settings.grokSignedIn ? (
          <div className="sub-msg ok">
            Signed in via <code>grok login</code>
            {settings.grokAccount ? ` as ${settings.grokAccount}` : ""}.
          </div>
        ) : (
          <div className="sub-msg dim">
            Run <code>grok login</code> in a terminal to authenticate the Grok CLI, then enable it here.
          </div>
        )}

        <GrokModels />
        <EffortCapField value={settings.grokEffort} options={GROK_EFFORTS} onChange={(v) => setSettings({ grokEffort: v as GrokEffort })} />
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
      {acct.enabled && <AccountModels accountId={acct.id} />}
      {acct.enabled && <AccountEffort accountId={acct.id} />}
    </div>
  );
}

/** The Codex per-role model grid — one dropdown per agent role (director/planner/researcher/implementor/qa),
 *  each a live-refreshed list of the OpenAI models the key can access (curated flagships first) with a Custom
 *  escape hatch. Writes into the model matrix (codex.<role>); an unset row inherits Codex's configured
 *  default. Roles run on Codex when the role layer routes them here (e.g. every Claude sub is maxed). */
function CodexModels() {
  const liveModels = useStore((s) => s.settings.codexModels);
  const options = codexModelOptions(liveModels);
  return (
    <>
      <SubRoleModels subId={CODEX_SUB_ID} models={options} defaultLabelFor={() => "Codex default"} roles={CLI_ROLES} />
      <div className="sub-msg dim">Models your key can access appear automatically — or pick Custom to type any id. Unset roles use Codex's default model.</div>
    </>
  );
}

/** The Grok per-role model grid — mirrors the Codex one, over the Grok models the CLI can access. */
function GrokModels() {
  const liveModels = useStore((s) => s.settings.grokModels);
  const options = grokModelOptions(liveModels);
  return (
    <>
      <SubRoleModels subId={GROK_SUB_ID} models={options} defaultLabelFor={() => "Grok default"} roles={CLI_ROLES} />
      <div className="sub-msg dim">Unset roles use Grok's default model.</div>
    </>
  );
}

/** The Codex reasoning-effort CAP: the director/planner picks each task's effort, clamped to this max. */
function CodexEffortField() {
  const effort = useStore((s) => s.settings.codexEffort);
  const setSettings = useStore((s) => s.setSettings);
  return <EffortCapField value={effort} options={CODEX_EFFORTS} onChange={(v) => setSettings({ codexEffort: v as CodexEffort })} />;
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

/** A free-text setting that commits on blur / Enter (not per keystroke), so a name change is sent once.
 *  An empty value is allowed through — the server falls back to its default placeholder for it. */
function TextRow({
  label,
  hint,
  value,
  placeholder,
  maxLength,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v !== value) onChange(v);
    else setDraft(value);
  };
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <input
          className="text-input"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(value);
            }
          }}
        />
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
