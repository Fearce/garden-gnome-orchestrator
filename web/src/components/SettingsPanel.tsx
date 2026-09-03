import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { useStore } from "../store.js";
import { apiUrl } from "../lib/base.js";
import { CLAUDE_EFFORTS, CODEX_SUB_ID, GROK_SUB_ID, MODEL_ROLES, ZAI_EFFORTS, ZAI_SUB_ID, codexEffortsForModel, grokEffortsForModel, type CodexEffort, type Effort, type GrokEffort, type Role, type ZaiEffort } from "../types.js";
import { codexModelOptions, grokModelOptions, zaiModelOptions } from "../lib/models.js";
import { effortLabel } from "../lib/format.js";
import { ModelSelect, useModelOverrides } from "./ModelSelect.js";
import { FreeProviders } from "./FreeProviders.js";

type SettingsCategoryId = "general" | "pipeline" | "usage" | "subscriptions" | "free-ai" | "voice-alerts" | "office" | "interface";

interface SettingsCategory {
  id: SettingsCategoryId;
  section: "Orchestrator" | "Providers" | "Workspace";
  label: string;
  description: string;
  keywords: string;
}

const SETTINGS_CATEGORIES = [
  { id: "general", section: "Orchestrator", label: "General", description: "Set the director's identity and how agents communicate with you.", keywords: "name wording concise detailed communication tone" },
  { id: "pipeline", section: "Orchestrator", label: "Pipeline", description: "Control task execution, reviews, concurrency, and supervision.", keywords: "planner research implementor qa review auto push git parallel workers supervisor models" },
  { id: "usage", section: "Orchestrator", label: "Usage & limits", description: "Protect your allowances and choose how usage is balanced.", keywords: "tokens quota capacity allowance polling reset spread resume budget" },
  { id: "subscriptions", section: "Providers", label: "Subscriptions", description: "Manage paid AI accounts, models, effort caps, and routing limits.", keywords: "claude anthropic codex openai chatgpt grok xai zai glm api keys accounts models effort weekly safety" },
  { id: "free-ai", section: "Providers", label: "Free AI", description: "Connect free-tier providers for eligible task roles.", keywords: "free providers api keys quota models cerebras gemini openrouter" },
  { id: "voice-alerts", section: "Workspace", label: "Voice & alerts", description: "Configure spoken updates and phone notifications.", keywords: "speech microphone speaker tts volume sound wake discord telegram phone bot" },
  { id: "office", section: "Workspace", label: "Online office", description: "Connect this machine to collaborators working in other consoles.", keywords: "relay collaboration coworkers team machine url password presence chatroom" },
  { id: "interface", section: "Workspace", label: "Interface", description: "Choose what appears in the composer, board, and task feed.", keywords: "composer board completed drag reorder output model picker recent repositories ui" },
] as const satisfies readonly SettingsCategory[];

const SETTINGS_SECTIONS: readonly SettingsCategory["section"][] = ["Orchestrator", "Providers", "Workspace"];
const SETTINGS_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "summary",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

interface SettingsSearchResult {
  category: SettingsCategory;
  element: HTMLElement | null;
  hint: string;
  key: string;
  label: string;
  rank: number;
}

/** The gear-icon settings dialog. Categories keep the growing collection approachable while every
 *  control remains mounted, preserving in-progress credential and text drafts as the owner moves around. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const showCompleted = useStore((s) => s.showCompleted);
  const setShowCompleted = useStore((s) => s.setShowCompleted);
  const verbosity = useStore((s) => s.verbosity);
  const setVerbosity = useStore((s) => s.setVerbosity);
  const taskDragAndDrop = useStore((s) => s.taskDragAndDrop);
  const setTaskDragAndDrop = useStore((s) => s.setTaskDragAndDrop);
  const [activeCategoryId, setActiveCategoryId] = useState<SettingsCategoryId>("general");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SettingsSearchResult[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const desktopSearchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const activeCategory = SETTINGS_CATEGORIES.find((category) => category.id === activeCategoryId) ?? SETTINGS_CATEGORIES[0];
  const isSearching = normalizeSettingsSearchText(searchQuery).length > 0;

  const chooseCategory = (id: SettingsCategoryId) => {
    setSearchQuery("");
    setSearchResults([]);
    setActiveCategoryId(id);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  const updateSearch = (query: string) => {
    setSearchQuery(query);
    setSearchResults(query.trim() && dialogRef.current ? collectSettingsSearchResults(dialogRef.current, query) : []);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  const focusFirstSearchResult = () => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".settings-search-result")?.focus();
  };

  const openSearchResult = (result: SettingsSearchResult) => {
    chooseCategory(result.category.id);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const target = result.element;
      if (!target?.isConnected) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("settings-search-target");
      void target.offsetWidth;
      target.classList.add("settings-search-target");
      window.setTimeout(() => {
        if (target.isConnected) target.classList.remove("settings-search-target");
      }, 1800);
      const focusTarget = target.matches(SETTINGS_FOCUSABLE_SELECTOR)
        ? target
        : settingsFocusableControls(target)[0];
      focusTarget?.focus({ preventScroll: true });
    }));
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFirstControl = () => {
      const first = dialog ? settingsFocusableControls(dialog)[0] : undefined;
      (first ?? dialog)?.focus({ preventScroll: true });
    };
    const frame = window.requestAnimationFrame(focusFirstControl);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        const search = [desktopSearchRef.current, mobileSearchRef.current]
          .find((input) => input && input.getClientRects().length > 0);
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
          return;
        }
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;

      const focusable = settingsFocusableControls(dialog);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const current = document.activeElement;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey) {
        if (!current || !dialog.contains(current) || current === first) {
          e.preventDefault();
          last.focus();
        }
        return;
      }
      if (!current || !dialog.contains(current) || current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div
        ref={dialogRef}
        className="settings-pop"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        aria-labelledby="settings-dialog-title settings-page-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <span id="settings-dialog-title" className="settings-dialog-title-sr">Settings</span>
        <aside className="settings-sidebar" aria-label="Settings categories">
          <div className="settings-sidebar-title">
            <span className="settings-sidebar-mark" aria-hidden="true">G</span>
            <span>Settings</span>
          </div>
          <SettingsSearchField
            className="settings-search-desktop"
            inputRef={desktopSearchRef}
            query={searchQuery}
            onChange={updateSearch}
            onMoveToResults={focusFirstSearchResult}
          />
          <nav className="settings-nav">
            {SETTINGS_SECTIONS.map((section) => (
              <div className="settings-nav-section" key={section}>
                <div className="settings-nav-section-label">{section}</div>
                {SETTINGS_CATEGORIES.filter((category) => category.section === section).map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={"settings-nav-item" + (!isSearching && category.id === activeCategoryId ? " active" : "")}
                    data-settings-category={category.id}
                    aria-controls={`settings-category-${category.id}`}
                    aria-current={!isSearching && category.id === activeCategoryId ? "page" : undefined}
                    onClick={() => chooseCategory(category.id)}
                  >
                    <SettingsCategoryIcon category={category.id} />
                    <span>{category.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <section className="settings-main">
          <div className="settings-head">
            <div className="settings-head-copy">
              <div className="settings-head-kicker">Settings</div>
              <h3 id="settings-page-title">{isSearching ? "Search results" : activeCategory.label}</h3>
              <p aria-live="polite">
                {isSearching
                  ? `${searchResults.length} ${searchResults.length === 1 ? "match" : "matches"} for “${searchQuery.trim()}”`
                  : activeCategory.description}
              </p>
            </div>
            <button className="settings-x" aria-label="Close settings" onClick={onClose}>
              ✕
            </button>
          </div>

          <SettingsSearchField
            className="settings-search-mobile"
            inputRef={mobileSearchRef}
            query={searchQuery}
            onChange={updateSearch}
            onMoveToResults={focusFirstSearchResult}
          />

          <label className="settings-mobile-nav">
            <span>Category</span>
            <select
              aria-label="Settings category"
              value={isSearching ? "" : activeCategoryId}
              onChange={(event) => chooseCategory(event.target.value as SettingsCategoryId)}
            >
              <option value="" disabled>All settings</option>
              {SETTINGS_SECTIONS.map((section) => (
                <optgroup key={section} label={section}>
                  {SETTINGS_CATEGORIES.filter((category) => category.section === section).map((category) => (
                    <option key={category.id} value={category.id}>{category.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <div className="settings-content" ref={contentRef}>
            {isSearching ? (
              <SettingsSearchResults query={searchQuery} results={searchResults} onOpen={openSearchResult} />
            ) : null}
            <SettingsCategoryPanel id="general" active={!isSearching && activeCategoryId === "general"}>
              <Group label="Director">
                <TextRow
                  label="Director name"
                  hint="What your director is called across the console and office chat, whichever provider/model is currently running it."
                  value={settings.directorName}
                  placeholder="ChangeNameInSettings"
                  maxLength={40}
                  onChange={(v) => setSettings({ directorName: v })}
                />
              </Group>
              <Group label="Agent communication">
                <ToggleRow
                  label="Keep agent messages concise"
                  hint="On (default): every agent leads with the answer, uses short concrete sentences and plain language, and removes filler, repeated points, process narration, and avoidable jargon. Applies to Director chat, findings, handoffs, QA/review/supervisor messages, office chat, and task-status explanations."
                  on={settings.conciseAgentCommunication}
                  onChange={(v) => setSettings({ conciseAgentCommunication: v })}
                />
                <p className="settings-note tight">
                  Wording only. Agents still implement, investigate, test, and preserve blockers, errors, exact commands/IDs, safety caveats, and evidence in full.
                </p>
              </Group>
            </SettingsCategoryPanel>

            <SettingsCategoryPanel id="pipeline" active={!isSearching && activeCategoryId === "pipeline"}>
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
                  label="Auto-review fix rounds"
                  hint="When “Auto-review & mark done” hands a task back, how many times the implementor is sent in to fix the reviewer's issues before the task lands on you. The reviewer re-checks its work each round and still makes the final call. 0 = hand it straight back."
                  value={settings.maxReviewFixRounds}
                  min={0}
                  max={3}
                  onChange={(v) => setSettings({ maxReviewFixRounds: v })}
                />
                <ToggleRow
                  label="Different-provider QA"
                  hint="On: QA is reviewed by a DIFFERENT enabled provider than the one that implemented the task — so, e.g., GPT (Codex) reviews Claude's work and vice-versa — for an independent cross-provider check. Needs a second backend enabled (Codex/Grok/z.ai); with only one provider it quietly falls back to normal QA. Off by default."
                  on={settings.differentProviderQa}
                  onChange={(v) => setSettings({ differentProviderQa: v })}
                />
                <ToggleRow
                  label="QA also applies fixes"
                  hint="On: QA fixes issues directly instead of sending them back to the implementor. Every QA run that changes files gets another QA review until one makes no further code changes. For true provider alternation, also enable Different-provider QA with another backend ready; otherwise the verifier starts a fresh same-provider session. Off keeps the existing implementor↔QA handoff."
                  on={settings.qaAppliesFixes}
                  onChange={(v) => setSettings({ qaAppliesFixes: v })}
                />
                <NumberRow
                  label="Max concurrent tasks"
                  hint="Pipelines allowed to run at once. Dispatches beyond this wait in a queued lane and start as slots free."
                  value={settings.maxConcurrent}
                  min={1}
                  max={20}
                  onChange={(v) => setSettings({ maxConcurrent: v })}
                />
                <NumberRow
                  label="Max concurrent tasks per repo"
                  hint="How many tasks may run at once in a single repo. 0 = unlimited (only the global cap applies). Set to 1 to serialize a repo: a second task for the same repo waits until the first fully finishes, while tasks in other repos keep running."
                  value={settings.maxConcurrentPerRepo}
                  min={0}
                  max={20}
                  onChange={(v) => setSettings({ maxConcurrentPerRepo: v })}
                />
                <ToggleRow
                  label="Self-improve after tasks"
                  hint="On: once a task is accepted (QA pass, or a clean finish with QA off), the implementor runs one bonus round — 'what tools/skills/memories would have made this easier? Build them.' — before the task settles to done. Off by default; the extra round costs extra tokens."
                  on={settings.selfImproveEnabled}
                  onChange={(v) => setSettings({ selfImproveEnabled: v })}
                />
              </Group>
              <Group label="Auto model selection">
                <ToggleRow
                  label="Auto-select the implementor model"
                  hint="Off (default): the implementor runs on the model configured for its subscription, at the planner's effort. On: a smart judgement picks the director once (sticky until its provider caps), and the director picks each implementor's model + effort from every backend available right now. Both use a daily cached LiveBench category/effort prior; local outcomes and live availability remain stronger signals. Implementor picks are scored for the next decision."
                  on={settings.autoModelSelection}
                  onChange={(v) => setSettings({ autoModelSelection: v })}
                />
                <ModelScoreboard enabled={settings.autoModelSelection} />
              </Group>
              <Group label="Director Supervisor">
                <ToggleRow
                  label="Watch active tasks"
                  hint="Off (default): no background work at all. On: a lightweight watchdog checks active tasks — event-driven on state changes plus an adaptive-backoff sweep — and spends a cheap bounded agent judgement only on a new failure, a real stall/anomaly, or review/failed work that has been forgotten. It may append a comment, post an urgent correction, resume a stalled task the same way the Resume button does, or flag it for you — never cancel, retry, or touch anything you cancelled. Bounded by a per-task cooldown and a daily check-in budget. See the Supervisor tab for its live state and audit trail."
                  on={settings.directorSupervisorEnabled}
                  onChange={(v) => setSettings({ directorSupervisorEnabled: v })}
                />
                <p className="settings-note tight">
                  A normal review handoff may be delegated to Auto-review, which verifies the workspace and can mark it done only on an accepted reviewer verdict. The supervisor never directly accepts work.
                </p>
              </Group>
              <p className="settings-note settings-page-note">
                Agent toggles (planner · researcher · QA) live in the top bar. ON makes a stage available, not mandatory — the pipeline still chooses the smallest route each task needs. Turn a toggle OFF to hard-disable that stage for every task.
              </p>
            </SettingsCategoryPanel>

            <SettingsCategoryPanel id="usage" active={!isSearching && activeCategoryId === "usage"}>
              <Group label="Usage safeguards">
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
              </Group>
              <Group label="Usage routing">
                <ToggleRow
                  label="Fast usage polling"
                  hint="On: refresh the account usage meters every ~30s so the % and reset countdown track Claude's own UI within ~1-2%, instead of lagging up to 10 minutes behind a live burn. Costs a tiny extra Haiku ping per account. Off by default."
                  on={settings.fastUsagePolling}
                  onChange={(v) => setSettings({ fastUsagePolling: v })}
                />
                <ToggleRow
                  label="Spread usage"
                  hint="On: every dispatch targets the provider with the lowest weekly usage — across all enabled platforms (Claude subscriptions, Codex, Grok) and, within Claude, across your subs — so burn evens out everywhere. Off (default): burn the provider/sub whose weekly window resets soonest first, holding the others in reserve."
                  on={settings.spreadUsage}
                  onChange={(v) => setSettings({ spreadUsage: v })}
                />
              </Group>
            </SettingsCategoryPanel>

            <SettingsCategoryPanel id="subscriptions" active={!isSearching && activeCategoryId === "subscriptions"}>
              <Group label="Subscriptions">
                <SubscriptionsSection />
              </Group>
            </SettingsCategoryPanel>

            <SettingsCategoryPanel id="free-ai" active={!isSearching && activeCategoryId === "free-ai"}>
              <Group label="Free AI connections">
                <FreeProviders />
              </Group>
            </SettingsCategoryPanel>

            <SettingsCategoryPanel id="voice-alerts" active={!isSearching && activeCategoryId === "voice-alerts"}>
              <Group label="Voice mode">
                <VoiceSection />
              </Group>
              <Group label="Phone notifications">
                <PhoneNotificationsSection />
              </Group>
            </SettingsCategoryPanel>

            <SettingsCategoryPanel id="office" active={!isSearching && activeCategoryId === "office"}>
              <Group label="Online office">
                <OnlineOfficeSection />
              </Group>
            </SettingsCategoryPanel>

            <SettingsCategoryPanel id="interface" active={!isSearching && activeCategoryId === "interface"}>
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
            </SettingsCategoryPanel>
          </div>
        </section>
      </div>
    </div>
  );
}

function settingsFocusableControls(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.closest("[hidden]")) return false;
    return el.getClientRects().length > 0;
  });
}

const SETTINGS_SEARCH_CANDIDATE_SELECTOR = [
  ".settings-row",
  ".sub-card",
  ".sub-field",
  ".free-provider-card",
  ".office-field",
  ".office-join",
  ".office-joined",
].join(", ");

function normalizeSettingsSearchText(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function collectSettingsSearchResults(root: HTMLElement, query: string): SettingsSearchResult[] {
  const normalizedQuery = normalizeSettingsSearchText(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const results: SettingsSearchResult[] = [];
  SETTINGS_CATEGORIES.forEach((category) => {
    const panel = root.querySelector<HTMLElement>(`[data-settings-panel="${category.id}"]`);
    if (!panel) return;

    const matchingElements = Array.from(panel.querySelectorAll<HTMLElement>(SETTINGS_SEARCH_CANDIDATE_SELECTOR))
      .filter((element) => {
        // A free-provider card is collapsed by default. Return the card itself instead of an invisible
        // credential field nested inside it, so opening a result always lands on something visible.
        if (!element.classList.contains("free-provider-card") && element.closest(".free-provider-card")) return false;
        const searchable = normalizeSettingsSearchText(element.textContent ?? "");
        return tokens.every((token) => searchable.includes(token));
      });

    // Prefer the most specific matching row/field. A provider card is useful for a provider-name query,
    // but redundant when one of its individual settings already contains every search term.
    const specificElements = matchingElements.filter((element) => (
      !matchingElements.some((other) => other !== element && element.contains(other))
    ));

    for (const [elementIndex, element] of specificElements.entries()) {
      const baseLabel = settingsSearchElementLabel(element) || `${category.label} setting`;
      const context = element.matches(".sub-field, .office-field")
        ? element.closest(".sub-card")?.querySelector<HTMLElement>(".sub-name")?.textContent?.trim()
        : undefined;
      const label = context ? `${context}: ${baseLabel}` : baseLabel;
      results.push({
        category,
        element,
        hint: settingsSearchElementHint(element, baseLabel, category.description),
        key: `${category.id}:${elementIndex}:${label}`,
        label,
        rank: settingsSearchRank(label, normalizedQuery),
      });
    }

    const categoryText = normalizeSettingsSearchText(`${category.label} ${category.description} ${category.keywords}`);
    const categoryMatches = tokens.every((token) => categoryText.includes(token));
    const panelText = normalizeSettingsSearchText(panel.textContent ?? "");
    const panelOnlyMatch = specificElements.length === 0 && tokens.every((token) => panelText.includes(token));
    if (specificElements.length === 0 && (categoryMatches || panelOnlyMatch)) {
      results.push({
        category,
        element: null,
        hint: category.description,
        key: `${category.id}:category`,
        label: category.label,
        rank: settingsSearchRank(category.label, normalizedQuery),
      });
    }
  });

  return results
    .sort((a, b) => a.rank - b.rank
      || SETTINGS_CATEGORIES.findIndex((category) => category.id === a.category.id)
        - SETTINGS_CATEGORIES.findIndex((category) => category.id === b.category.id)
      || a.label.localeCompare(b.label))
    .slice(0, 40);
}

function settingsSearchElementLabel(element: HTMLElement) {
  const label = element.querySelector<HTMLElement>([
    ".settings-row-label",
    ".sub-name",
    ".free-provider-name",
    ".sub-label",
    ".office-field > span",
    ".office-state",
  ].join(", "))?.textContent?.trim();
  if (label) return label;
  if (element.classList.contains("office-join")) return "Join the online office";
  if (element.classList.contains("office-joined")) return "Online office status";
  return "";
}

function settingsSearchElementHint(element: HTMLElement, label: string, fallback: string) {
  const explicitHint = element.querySelector<HTMLElement>([
    ".settings-row-hint",
    ".sub-card-meta",
    ".free-provider-tier",
    ".sub-msg",
  ].join(", "))?.textContent?.trim();
  const raw = explicitHint || (element.textContent ?? "").replace(label, "").trim() || fallback;
  const compact = raw.replace(/\s+/g, " ");
  return compact.length > 180 ? `${compact.slice(0, 177).trimEnd()}…` : compact;
}

function settingsSearchRank(label: string, normalizedQuery: string) {
  const normalizedLabel = normalizeSettingsSearchText(label);
  if (normalizedLabel === normalizedQuery) return 0;
  if (normalizedLabel.startsWith(normalizedQuery)) return 1;
  if (normalizedLabel.includes(normalizedQuery)) return 2;
  return 3;
}

function SettingsSearchField({
  className,
  inputRef,
  query,
  onChange,
  onMoveToResults,
}: {
  className: string;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onChange: (query: string) => void;
  onMoveToResults: () => void;
}) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      onChange("");
      return;
    }
    if (event.key === "ArrowDown" && query) {
      event.preventDefault();
      onMoveToResults();
    }
  };

  return (
    <div className={`settings-search ${className}`} role="search">
      <svg className="settings-search-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        aria-label="Search settings"
        autoComplete="off"
        placeholder="Search settings"
        spellCheck={false}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {query ? (
        <button type="button" className="settings-search-clear" aria-label="Clear settings search" onClick={() => onChange("")}>×</button>
      ) : (
        <kbd className="settings-search-shortcut" aria-hidden="true">Ctrl F</kbd>
      )}
    </div>
  );
}

function SettingsSearchResults({
  query,
  results,
  onOpen,
}: {
  query: string;
  results: SettingsSearchResult[];
  onOpen: (result: SettingsSearchResult) => void;
}) {
  if (results.length === 0) {
    return (
      <div className="settings-search-empty" role="status">
        <SearchEmptyIcon />
        <strong>No settings found</strong>
        <span>Nothing matches “{query.trim()}”. Try a setting name or keyword like usage, Discord, or drag.</span>
      </div>
    );
  }

  return (
    <div className="settings-search-results" aria-label="Matching settings">
      {results.map((result) => (
        <button key={result.key} type="button" className="settings-search-result" onClick={() => onOpen(result)}>
          <span className="settings-search-result-icon"><SettingsCategoryIcon category={result.category.id} /></span>
          <span className="settings-search-result-copy">
            <span className="settings-search-result-category">{result.category.label}</span>
            <span className="settings-search-result-label">{result.label}</span>
            <span className="settings-search-result-hint">{result.hint}</span>
          </span>
          <span className="settings-search-result-arrow" aria-hidden="true">›</span>
        </button>
      ))}
    </div>
  );
}

function SearchEmptyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4 4M8.5 8.5l4 4m0-4-4 4" />
    </svg>
  );
}

function SettingsCategoryPanel({ id, active, children }: { id: SettingsCategoryId; active: boolean; children: ReactNode }) {
  return (
    <div
      className="settings-category-panel"
      id={`settings-category-${id}`}
      data-settings-panel={id}
      hidden={!active}
    >
      {children}
    </div>
  );
}

function SettingsCategoryIcon({ category }: { category: SettingsCategoryId }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (category === "general") return <svg {...common}><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="13" cy="18" r="2" /></svg>;
  if (category === "pipeline") return <svg {...common}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h8M18 8v8M6 8v7a3 3 0 0 0 3 3h7" /></svg>;
  if (category === "usage") return <svg {...common}><path d="M4.9 19a9 9 0 1 1 14.2 0" /><path d="m12 13 4-4" /><circle cx="12" cy="13" r="1.5" /></svg>;
  if (category === "subscriptions") return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></svg>;
  if (category === "free-ai") return <svg {...common}><path d="m12 3 1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8L12 3Z" /><path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /><path d="M5 14v6M2 17h6" /></svg>;
  if (category === "voice-alerts") return <svg {...common}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>;
  if (category === "office") return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></svg>;
  return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M9 10h12" /></svg>;
}

/**
 * Post to a Discord channel when a task finishes, needs you, or fails — so the console can reach a phone.
 * The bot token is write-only (typed here, stored server-side, never read back), so the field shows a
 * masked placeholder once one is stored. "Send test" is the only way to prove the whole chain — token,
 * channel, and the bot's permission to post there — without waiting for a task to settle.
 */
function PhoneNotificationsSection() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const testDiscord = useStore((s) => s.testDiscord);
  const result = useStore((s) => s.discordTest);
  const testing = useStore((s) => s.discordTesting);
  const [tokenDraft, setTokenDraft] = useState("");
  const [reveal, setReveal] = useState(false);

  const configured = settings.discordTokenPresent && !!settings.discordChannelId;
  const saveToken = () => {
    if (!tokenDraft.trim()) return;
    setSettings({ discordBotToken: tokenDraft.trim() });
    setTokenDraft("");
    setReveal(false);
  };

  return (
    <>
      <ToggleRow
        label="Post to Discord"
        hint="Off (default): nothing is posted. On: a message the moment a task finishes, parks for your review, asks you a question, or fails — so it reaches your phone. Routine pipeline events (cap failover, auto-resume) are never posted."
        on={settings.discordNotify}
        onChange={(v) => setSettings({ discordNotify: v })}
      />
      <TextRow
        label="Channel ID"
        hint="The Discord channel to post in — right-click it → Copy Channel ID, or just paste the channel's link."
        value={settings.discordChannelId}
        placeholder="1542104062156079144"
        // Long enough for a pasted channel LINK; the server lifts the id out of whatever arrives. A
        // 32-char cap silently truncated a paste to "https://discord.com/channels/142" and stored "142".
        maxLength={200}
        onChange={(v) => setSettings({ discordChannelId: v })}
      />

      <div className="sub-field">
        <label className="sub-label">Bot token</label>
        <div className="key-input">
          <input
            type={reveal ? "text" : "password"}
            value={tokenDraft}
            spellCheck={false}
            autoComplete="off"
            placeholder={settings.discordTokenPresent ? `••••••••${settings.discordTokenLast4 ?? ""}` : "your Discord bot token"}
            onChange={(e) => setTokenDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveToken();
            }}
          />
          <button
            type="button"
            className="key-eye"
            aria-label={reveal ? "Hide token" : "Reveal token"}
            title={reveal ? "Hide" : "Reveal"}
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? <EyeOff /> : <Eye />}
          </button>
        </div>
        <div className="sub-actions">
          <button className="sub-btn primary" disabled={!tokenDraft.trim()} onClick={saveToken}>
            {settings.discordTokenPresent ? "Replace token" : "Save token"}
          </button>
          <button className="sub-btn" disabled={testing || !configured} onClick={testDiscord}>
            {testing ? "Sending…" : "Send test"}
          </button>
          {settings.discordTokenPresent && (
            <button className="sub-btn ghost" onClick={() => setSettings({ discordBotToken: "" })}>
              Remove
            </button>
          )}
        </div>
        {result && <div className={"sub-msg" + (result.ok ? " ok" : " bad")}>{result.message}</div>}
        {!result && !configured && (
          <div className="sub-msg dim">
            {settings.discordTokenPresent ? "Token stored — add the channel ID above." : "Paste a bot token that can post in that channel."}
          </div>
        )}
        {!result && configured && (
          <div className="sub-msg dim">Token stored (••••{settings.discordTokenLast4 ?? ""}). Send a test to confirm it reaches your phone.</div>
        )}
      </div>
    </>
  );
}

/**
 * Join or leave the Online Office — the shared relay where agents on OTHER machines working the same
 * repository show up as coworkers. Two states, deliberately: a join form when this machine has no device
 * token, and a live status card once it has one. Joining is a one-time exchange of a code for a token, so
 * the form is what the operator sees once and the card is what they see forever after.
 */
function OnlineOfficeSection() {
  const office = useStore((s) => s.onlineOffice);
  const join = useStore((s) => s.joinOnlineOffice);
  const leave = useStore((s) => s.leaveOnlineOffice);
  const set = useStore((s) => s.setOnlineOffice);
  const pending = useStore((s) => s.officeJoining);
  const joinError = useStore((s) => s.officeJoinError);
  const [url, setUrl] = useState(office.url);
  const [code, setCode] = useState("");
  const [name, setName] = useState(office.instanceName);

  // The server is authoritative for both fields; adopt its values whenever they change under us (a
  // successful join, another browser tab, a reload) without clobbering something being typed.
  useEffect(() => {
    setUrl((u) => (u ? u : office.url));
    setName((n) => (n ? n : office.instanceName));
  }, [office.url, office.instanceName]);
  useEffect(() => {
    if (office.joined) setCode("");
  }, [office.joined]);

  if (!office.joined) {
    return (
      <div className="office-join">
        <p className="settings-note tight">
          Host a relay (see <code>relay/README.md</code>) and share its address plus one join code. Everyone pastes both
          once — from then on this machine holds a device token and reconnects on its own.
        </p>
        <label className="office-field">
          <span>Relay address</span>
          <input
            className="text-input"
            value={url}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://office.example.com"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className="office-field">
          <span>Join code</span>
          <input
            className="text-input"
            type="password"
            value={code}
            spellCheck={false}
            autoComplete="off"
            placeholder="from whoever runs the office"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label className="office-field">
          <span>This machine</span>
          <input
            className="text-input"
            value={name}
            spellCheck={false}
            autoComplete="off"
            maxLength={40}
            placeholder="Main workstation"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {joinError ?? office.error ? <p className="office-error">{joinError ?? office.error}</p> : null}
        <button
          className="btn primary sm"
          disabled={!url.trim() || !code.trim() || pending}
          onClick={() => join({ url, code, instanceName: name })}
        >
          {pending ? "Joining…" : "Join office"}
        </button>
      </div>
    );
  }

  return (
    <div className="office-joined">
      <div className="office-status">
        <span className={"office-dot " + office.state} />
        <span className="office-state">{stateWord(office)}</span>
        <span className="office-url">{office.url.replace(/^https?:\/\//, "")}</span>
      </div>
      {office.error ? <p className="office-error">{office.error}</p> : null}
      <ToggleRow
        label="Be visible in the office"
        hint="Off: stay joined but disconnect — your agents are hidden and remote coordination pauses. On: your live agents are advertised to the other machines in the office."
        on={office.enabled}
        onChange={(v) => set({ enabled: v })}
      />
      <TextRow
        label="This machine"
        hint="How the other machines see you in the office roster and on each message your agents send."
        value={office.instanceName}
        placeholder="Main workstation"
        maxLength={40}
        onChange={(v) => set({ instanceName: v })}
      />
      <RemoteRoster office={office} />
      <Row
        label="Leave the office"
        hint="Disconnects and forgets this machine's device token. Re-joining needs the join code again."
        control={
          <button className="btn sm" onClick={leave}>
            Leave
          </button>
        }
      />
    </div>
  );
}

function stateWord(office: import("../types.js").OnlineOfficeDTO): string {
  if (!office.enabled) return "Hidden";
  if (office.state === "online") return "Connected";
  if (office.state === "connecting") return "Connecting…";
  if (office.state === "error") return "Needs attention";
  return "Offline";
}

/** Who else is working right now, grouped by machine — the answer to "is my friend on this repo too?". */
function RemoteRoster({ office }: { office: import("../types.js").OnlineOfficeDTO }) {
  const byInstance = new Map<string, typeof office.remoteAgents>();
  for (const a of office.remoteAgents) byInstance.set(a.instanceName, [...(byInstance.get(a.instanceName) ?? []), a]);
  if (!byInstance.size) {
    return (
      <p className="settings-note tight">
        {office.state === "online" ? "Nobody else has an agent working right now." : "Not connected, so the roster is empty."}
      </p>
    );
  }
  return (
    <div className="office-roster">
      {[...byInstance.entries()].map(([instance, agents]) => (
        <div className="office-roster-row" key={instance}>
          <div className="office-roster-who">{instance}</div>
          <ul>
            {agents.map((a) => (
              <li key={`${a.instanceId}:${a.key}`}>
                <span className="office-roster-name">{a.name}</span>
                <span className="office-roster-role">{a.role}</span>
                <span className={"office-roster-repo" + (office.sharedRepos.some((r) => r.repoKey === a.repoKey) ? " shared" : "")}>
                  {a.repoLabel}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
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
  const options = CLAUDE_EFFORTS.filter((e) => e !== "xhigh" || xhighEnabled);
  const onChange = (v: string) => {
    const next: Record<string, Effort> = { ...caps };
    if (v === "max") delete next[accountId];
    else next[accountId] = v as Effort;
    setSettings({ accountEffortCaps: next });
  };
  return <EffortCapField value={value} options={options} onChange={onChange} />;
}

/** The soft WEEKLY-safety ceiling for one Claude account. At/above this weekly utilization the sub sheds new
 *  tasks to a fresher one — a transparent failover, never a freeze. 100 = off (hard-cap-only, unchanged). */
function AccountWeeklySafety({ accountId, value }: { accountId: string; value: number }) {
  const setAccountWeeklySafety = useStore((s) => s.setAccountWeeklySafety);
  return (
    <SubStepperField
      label="Weekly safety %"
      hint="Switch subs when weekly usage exceeds this threshold. Won't freeze tasks."
      value={value}
      min={1}
      max={100}
      onChange={(v) => setAccountWeeklySafety(accountId, v)}
    />
  );
}

/** Roles an alternate backend can run. Codex/Grok direct through the server command bridge; z.ai keeps
 *  the native MCP tools, so every provider can now own the director as well as pipeline roles. */
const CLI_ROLES: readonly Role[] = MODEL_ROLES;

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
              {effortLabel(v as Effort)}
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
  const grokUsage = useStore((s) => s.grokUsage);
  const zaiActive = settings.zaiEnabled && settings.zaiKeyPresent;
  const zaiUsage = useStore((s) => s.zaiUsage);
  const [zaiKeyDraft, setZaiKeyDraft] = useState("");
  const [zaiReveal, setZaiReveal] = useState(false);
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
              ? `Implementing tasks via the Codex CLI${settings.codexChatgptLogin ? " · ChatGPT plan login" : ""} · model ${settings.codexModel} · ${effortLabel(settings.codexEffort)} max effort`
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
        <CodexWeeklySafety />
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
        meta={grokSettingsMeta(settings, grokUsage)}
      >
        {settings.grokSignedIn ? (
          <div className="sub-msg ok">
            Signed in via <code>grok login</code>
            {settings.grokAccount ? ` as ${settings.grokAccount}` : ""}
            {grokUsage?.plan ? ` · ${grokUsage.plan}` : ""}.
          </div>
        ) : (
          <div className="sub-msg dim">
            Run <code>grok login</code> in a terminal to authenticate the Grok CLI, then enable it here.
          </div>
        )}

        {settings.grokSignedIn ? <GrokUsageReadout usage={grokUsage} /> : null}

        <GrokModels />
        <EffortCapField value={settings.grokEffort} options={grokEffortsForModel(settings.grokModel)} onChange={(v) => setSettings({ grokEffort: v as GrokEffort })} />
        <GrokWeeklySafety />
      </SubCard>

      <SubCard
        name="z.ai (GLM Coding Plan)"
        vendor="Zhipu"
        on={settings.zaiEnabled}
        active={zaiActive}
        activeLabel="in rotation"
        toggleDisabled={!settings.zaiEnabled && !settings.zaiKeyPresent}
        toggleTitle={!settings.zaiKeyPresent ? "Add a z.ai API key first" : undefined}
        onToggle={(v) => setSettings({ zaiEnabled: v })}
        meta={zaiSettingsMeta(settings, zaiUsage)}
      >
        <div className="sub-msg dim">
          Runs GLM models through z.ai's Anthropic-compatible endpoint on the Claude Agent SDK — so it keeps the in-app tools
          (findings, deliverables, office chat) and can also take failover for the planner/researcher/QA when every Claude sub is capped.
        </div>

        <div className="sub-field">
          <label className="sub-label">z.ai API key</label>
          <div className="key-input">
            <input
              type={zaiReveal ? "text" : "password"}
              value={zaiKeyDraft}
              spellCheck={false}
              autoComplete="off"
              placeholder={settings.zaiKeyPresent ? `••••••••${settings.zaiKeyLast4 ?? ""}` : "your z.ai API key"}
              onChange={(e) => setZaiKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && zaiKeyDraft.trim()) {
                  setSettings({ zaiApiKey: zaiKeyDraft.trim() });
                  setZaiKeyDraft("");
                  setZaiReveal(false);
                }
              }}
            />
            <button
              type="button"
              className="key-eye"
              aria-label={zaiReveal ? "Hide key" : "Reveal key"}
              title={zaiReveal ? "Hide" : "Reveal"}
              onClick={() => setZaiReveal((r) => !r)}
            >
              {zaiReveal ? <EyeOff /> : <Eye />}
            </button>
          </div>
          <div className="sub-actions">
            <button
              className="sub-btn primary"
              disabled={!zaiKeyDraft.trim()}
              onClick={() => {
                setSettings({ zaiApiKey: zaiKeyDraft.trim() });
                setZaiKeyDraft("");
                setZaiReveal(false);
              }}
            >
              {settings.zaiKeyPresent ? "Replace key" : "Save key"}
            </button>
            {settings.zaiKeyPresent && (
              <button
                className="sub-btn ghost"
                onClick={() => {
                  setSettings({ zaiApiKey: "" });
                  setZaiKeyDraft("");
                }}
              >
                Remove
              </button>
            )}
          </div>
          {settings.zaiKeyPresent && !zaiKeyDraft.trim() && (
            <div className="sub-msg dim">Key stored (••••{settings.zaiKeyLast4 ?? ""}).</div>
          )}
        </div>

        {settings.zaiKeyPresent ? <ZaiUsageReadout usage={zaiUsage} /> : null}

        <ZaiModels />
        <EffortCapField value={settings.zaiEffort} options={ZAI_EFFORTS} onChange={(v) => setSettings({ zaiEffort: v as ZaiEffort })} />
        <ZaiWeeklySafety />
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
      {acct.enabled && <AccountWeeklySafety accountId={acct.id} value={acct.weeklySafetyPct} />}
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

/** The z.ai per-role model grid — mirrors the Codex/Grok one, over the curated GLM model set. */
function ZaiModels() {
  const liveModels = useStore((s) => s.settings.zaiModels);
  const options = zaiModelOptions(liveModels);
  return (
    <>
      <SubRoleModels subId={ZAI_SUB_ID} models={options} defaultLabelFor={() => "z.ai default"} roles={CLI_ROLES} />
      <div className="sub-msg dim">Unset roles use z.ai's default model.</div>
    </>
  );
}

/** The soft weekly-safety ceiling for the z.ai backend, backed by the live GLM Coding Plan weekly meter. */
function ZaiWeeklySafety() {
  const value = useStore((s) => s.settings.zaiWeeklySafetyPct);
  const setSettings = useStore((s) => s.setSettings);
  return (
    <SubStepperField
      label="Weekly safety %"
      hint="Switch backends when z.ai's weekly usage reaches this threshold. Won't freeze tasks."
      value={value}
      min={1}
      max={100}
      onChange={(v) => setSettings({ zaiWeeklySafetyPct: v })}
    />
  );
}

/** One-line z.ai usage for the Settings card meta (mirrors the Grok/Claude cards' weekly · 5h line). */
function zaiSettingsMeta(
  settings: { zaiEnabled: boolean; zaiKeyPresent: boolean; zaiModel: string; zaiEffort: string },
  usage: import("../types.js").ZaiUsageDTO | null,
): string {
  if (!settings.zaiEnabled) return "Off — enable to add z.ai to the implementor + role-failover rotation.";
  if (!settings.zaiKeyPresent) return "Enabled but no API key — add your z.ai key before tasks can route here.";
  const plan = usage?.plan ? ` · ${usage.plan}` : "";
  const weekly = usage?.sevenDay != null ? `weekly ${Math.round(usage.sevenDay)}%` : "weekly —";
  const fiveHour = usage?.fiveHour != null ? `5h ${Math.round(usage.fiveHour)}%` : "5h —";
  const err = usage?.error && usage.sevenDay == null && usage.fiveHour == null ? ` · usage: ${usage.error}` : "";
  return `In rotation${plan} · ${weekly} · ${fiveHour} · model ${settings.zaiModel} · ${settings.zaiEffort} max effort${err}`;
}

/** Live z.ai meters inside the Settings → z.ai card so usage is visible without scanning the top bar. */
function ZaiUsageReadout({ usage }: { usage: import("../types.js").ZaiUsageDTO | null }) {
  if (!usage) {
    return <div className="sub-msg dim">Waiting for z.ai usage ping…</div>;
  }
  if (usage.fiveHour == null && usage.sevenDay == null) {
    return (
      <div className={"sub-msg" + (usage.error ? " bad" : " dim")}>
        {usage.error ? `Usage unavailable: ${usage.error}` : "Polling z.ai quota…"}
      </div>
    );
  }
  const weekly = usage.sevenDay != null ? `${Math.round(usage.sevenDay)}% used` : "—";
  const fiveHour = usage.fiveHour != null ? `${Math.round(usage.fiveHour)}% used` : "—";
  return (
    <div className="sub-msg ok" title={usage.stale ? "Last known reading — refresh pending" : "Live z.ai usage"}>
      Usage{usage.stale ? " (stale)" : ""}: 5h {fiveHour}
      {usage.fiveHourReset != null ? ` · resets ${new Date(usage.fiveHourReset).toLocaleString()}` : ""}
      {" · "}
      weekly {weekly}
      {usage.sevenDayReset != null ? ` · resets ${new Date(usage.sevenDayReset).toLocaleString()}` : ""}.
    </div>
  );
}

/** The Codex reasoning-effort CAP: the director/planner picks each task's effort, clamped to this max. */
function CodexEffortField() {
  const effort = useStore((s) => s.settings.codexEffort);
  const model = useStore((s) => s.settings.codexModel);
  const modelEfforts = useStore((s) => s.settings.codexModelEfforts);
  const setSettings = useStore((s) => s.setSettings);
  const options = modelEfforts[model] ?? codexEffortsForModel(model);
  return (
    <>
      <EffortCapField value={effort} options={options} onChange={(v) => setSettings({ codexEffort: v as CodexEffort })} />
      <div className="sub-msg dim">
        {options.includes("ultra")
          ? "Ultra adds automatic task delegation for this model."
          : options.includes("max")
            ? "This model supports Max."
            : "This model supports up to Extra High."}
      </div>
    </>
  );
}

/** The soft WEEKLY-safety ceiling for the Codex backend. At/above this Codex weekly utilization, new tasks
 *  route to another backend instead of Codex — a transparent failover, never a freeze. 100 = off. */
function CodexWeeklySafety() {
  const value = useStore((s) => s.settings.codexWeeklySafetyPct);
  const setSettings = useStore((s) => s.setSettings);
  return (
    <SubStepperField
      label="Weekly safety %"
      hint="Switch backends when Codex's weekly usage exceeds this threshold. Won't freeze tasks."
      value={value}
      min={1}
      max={100}
      onChange={(v) => setSettings({ codexWeeklySafetyPct: v })}
    />
  );
}

/** The soft weekly-safety ceiling for the Grok backend, backed by the live SuperGrok weekly meter. */
function GrokWeeklySafety() {
  const value = useStore((s) => s.settings.grokWeeklySafetyPct);
  const setSettings = useStore((s) => s.setSettings);
  return (
    <SubStepperField
      label="Weekly safety %"
      hint="Switch backends when SuperGrok's weekly usage reaches this threshold. Won't freeze tasks."
      value={value}
      min={1}
      max={100}
      onChange={(v) => setSettings({ grokWeeklySafetyPct: v })}
    />
  );
}

/** One-line SuperGrok usage for the Settings card meta (mirrors Claude account cards' weekly · 5h line). */
function grokSettingsMeta(
  settings: { grokEnabled: boolean; grokSignedIn: boolean; grokAccount?: string | null; grokModel: string; grokEffort: string },
  usage: import("../types.js").GrokUsageDTO | null,
): string {
  if (!settings.grokEnabled) return "Off — enable to add Grok to the implementor + role-failover rotation.";
  if (!settings.grokSignedIn) return "Enabled but not signed in — run `grok login` before tasks can route here.";
  const who = settings.grokAccount ? ` · ${settings.grokAccount}` : "";
  const weekly = usage?.sevenDay != null ? `weekly ${Math.round(usage.sevenDay)}%` : "weekly —";
  const monthly =
    usage?.monthlyUsed != null && usage.monthlyLimit != null && usage.monthlyLimit > 0
      ? `monthly ${usage.monthlyUsed}/${usage.monthlyLimit} credits`
      : "monthly —";
  const plan = usage?.plan ? ` · ${usage.plan}` : "";
  const err = usage?.error && usage.sevenDay == null && usage.monthlyUsed == null ? ` · usage: ${usage.error}` : "";
  return `In rotation${who}${plan} · ${weekly} · ${monthly} · model ${settings.grokModel} · ${settings.grokEffort} max effort${err}`;
}

/** Live SuperGrok meters inside the Settings → Grok card so usage is visible without scanning the top bar. */
function GrokUsageReadout({ usage }: { usage: import("../types.js").GrokUsageDTO | null }) {
  if (!usage) {
    return <div className="sub-msg dim">Waiting for SuperGrok usage ping…</div>;
  }
  const weekly = usage.sevenDay != null ? `${Math.round(usage.sevenDay)}% used` : "—";
  const monthly =
    usage.monthlyUsed != null && usage.monthlyLimit != null && usage.monthlyLimit > 0
      ? `${usage.monthlyUsed}/${usage.monthlyLimit} credits (${Math.round((100 * usage.monthlyUsed) / usage.monthlyLimit)}%)`
      : "—";
  if (usage.sevenDay == null && usage.monthlyUsed == null) {
    return (
      <div className={"sub-msg" + (usage.error ? " bad" : " dim")}>
        {usage.error ? `Usage unavailable: ${usage.error}` : "Polling SuperGrok weekly + monthly usage…"}
      </div>
    );
  }
  return (
    <div className="sub-msg ok" title={usage.stale ? "Last known reading — refresh pending" : "Live SuperGrok usage"}>
      Usage{usage.stale ? " (stale)" : ""}: weekly {weekly}
      {usage.sevenDayReset != null ? ` · resets ${new Date(usage.sevenDayReset).toLocaleString()}` : ""}
      {" · "}
      monthly {monthly}
      {usage.monthlyReset != null ? ` · period ends ${new Date(usage.monthlyReset).toLocaleDateString()}` : ""}.
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

/** What each auto-picked model has actually delivered — the evidence the next pick is made from, shown so
 *  the selection loop isn't a black box. Read-only: the server owns every number. Stays visible after the
 *  setting is switched off (the history is still worth reading), and disappears only when there's neither. */
function formatCompact(n: number): string {
  return new Intl.NumberFormat("en", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

function ModelScoreboard({ enabled }: { enabled: boolean }) {
  const stats = useStore((s) => s.modelStats);
  if (!enabled && !stats.length) return null;
  if (!stats.length)
    return (
      <div className="settings-note">
        No graded tasks yet. Each auto-picked task is scored when it settles — 100 when it's accepted with no human
        involvement, 12 less for every QA fix-round past the first, 40 when it ends up on your desk — and the averages
        appear here.
      </div>
    );
  return (
    <div className="ams-board">
      <div className="ams-row ams-head">
        <span>Model</span>
        <span>Tasks</span>
        <span>Score</span>
        <span>Accepted</span>
        <span>QA</span>
        <span>Cost</span>
        <span>Tokens</span>
      </div>
      {stats.map((s) => (
        <div className="ams-row" key={`${s.provider}:${s.model}`}>
          <span className="ams-model" title={`${s.provider} · ${s.avgMinutes} min average`}>
            {s.model}
          </span>
          <span className="mono">{s.picks}</span>
          <span className="mono">{s.avgScore}</span>
          <span className="mono">{Math.round(s.doneRate * 100)}%</span>
          <span className="mono">{s.avgQaRounds}</span>
          <span className="mono">${s.avgCostUsd.toFixed(2)}</span>
          <span className="mono" title={s.avgTotalTokens == null ? `No complete provider token payload recorded yet (${Math.round(s.tokenSampleRate * 100)}% coverage)` : `${s.avgInputTokens ?? 0} input · ${s.avgOutputTokens ?? 0} output · ${s.avgCacheTokens ?? 0} cache · ${s.avgReasoningTokens ?? 0} reasoning · ${Math.round(s.tokenSampleRate * 100)}% complete-run coverage`}>
            {s.avgTotalTokens == null ? "—" : formatCompact(s.avgTotalTokens)}
          </span>
        </div>
      ))}
    </div>
  );
}

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

/** A numeric stepper laid out for a subscription card (label above control, like EffortCapField) rather
 *  than NumberRow's label-left/control-right settings row. Keeps a local draft so typing is smooth, and
 *  clamps + commits to [min, max] on blur / Enter (Escape reverts). */
function SubStepperField({
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
    <div className="sub-field">
      <label className="sub-label">{label}</label>
      <div className="stepper">
        <button aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => step(-1)}>
          −
        </button>
        <input
          type="number"
          className="stepper-val mono"
          aria-label={label}
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
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
      <div className="sub-msg dim">{hint}</div>
    </div>
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
