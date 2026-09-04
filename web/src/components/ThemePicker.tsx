import type { KeyboardEvent } from "react";
import { THEMES, type ThemeId } from "../lib/theme.js";

/** Arrow keys move a radio group's selection; Tab enters and leaves it. So only the chosen tile is
 *  tabbable, and an arrow both selects and focuses the next one. */
const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The Settings → Appearance chooser. Presentational on purpose — the store wiring lives at the call
 * site, so the tiles can be rendered and asserted without a browser (`test:themes`).
 *
 * Each tile is painted by the tokens of the theme it advertises (`data-theme-preview`), not by a
 * copied swatch, so it can't drift from the theme it is selling.
 */
export function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (theme: ThemeId) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const from = THEMES.findIndex((t) => t.id === value);
    const next = THEMES[(from + step + THEMES.length) % THEMES.length]!;
    onChange(next.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-theme-option="${next.id}"]`)?.focus();
  };

  return (
    <div className="theme-picker" role="radiogroup" aria-label="Console theme" onKeyDown={onKeyDown}>
      {THEMES.map((theme) => {
        const active = theme.id === value;
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={"theme-option" + (active ? " on" : "")}
            data-theme-option={theme.id}
            onClick={() => onChange(theme.id)}
          >
            <ThemeSample theme={theme.id} />
            <span className="theme-option-copy">
              <span className="theme-option-head">
                <span className="theme-option-name">{theme.name}</span>
                {active ? <span className="theme-option-active">Active</span> : null}
              </span>
              <span className="theme-option-tagline">{theme.tagline}</span>
              <span className="theme-option-desc">{theme.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A miniature of the console — top bar, director rail, two task cards — drawn in the theme's palette. */
function ThemeSample({ theme }: { theme: ThemeId }) {
  return (
    <span className="theme-preview" data-theme-preview={theme} aria-hidden="true">
      <span className="theme-preview-bar">
        <span className="theme-preview-mark">GG</span>
        <span className="theme-preview-pill" />
        <span className="theme-preview-pill accent" />
      </span>
      <span className="theme-preview-body">
        <span className="theme-preview-rail">
          <span />
          <span />
          <span />
        </span>
        <span className="theme-preview-cards">
          <span className="theme-preview-card running">
            <span className="tp-title" />
            <span className="tp-line" />
          </span>
          <span className="theme-preview-card done">
            <span className="tp-title" />
            <span className="tp-line" />
          </span>
        </span>
      </span>
    </span>
  );
}
