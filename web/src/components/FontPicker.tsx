import type { KeyboardEvent } from "react";
import type { FontMeta } from "../lib/font.js";

/** Arrow keys move a radio group's selection; Tab enters and leaves it. So only the chosen row is
 *  tabbable, and an arrow both selects and focuses the next one. Same contract as ThemePicker. */
const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export interface FontPickerProps<Id extends string> {
  fonts: readonly FontMeta<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  /** Names the group for a screen reader, e.g. "Interface typeface". */
  ariaLabel: string;
  /** The specimen line under each option. Interface faces get prose, mono faces get code. */
  sample: string;
}

/**
 * The Settings → Appearance typeface chooser, used once for the interface face and once for the
 * monospace face. Presentational on purpose: the store wiring lives at the call site, so the rows
 * can be rendered and asserted without a browser (`test:fonts`).
 *
 * Every row is set in the face it is selling, including while another face is active, so the list is
 * a specimen sheet rather than a dropdown of names. The one thing it may not do is paint a specimen
 * from a copied approximation of the face: the stack comes from the same `FontMeta` the CSS rule is
 * written from, which is what stops the sample drifting from what selecting it actually installs.
 */
export function FontPicker<Id extends string>({ fonts, value, onChange, ariaLabel, sample }: FontPickerProps<Id>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const from = fonts.findIndex((f) => f.id === value);
    const next = fonts[(from + step + fonts.length) % fonts.length]!;
    onChange(next.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-font-option="${next.id}"]`)?.focus();
  };

  return (
    <div className="font-picker" role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {fonts.map((font) => {
        const active = font.id === value;
        return (
          <button
            key={font.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={"font-option" + (active ? " on" : "")}
            data-font-option={font.id}
            onClick={() => onChange(font.id)}
          >
            <span className="font-option-glyph" style={{ fontFamily: font.stack }} aria-hidden="true">
              Aa
            </span>
            <span className="font-option-copy">
              <span className="font-option-head">
                <span className="font-option-name" style={{ fontFamily: font.stack }}>
                  {font.name}
                </span>
                <span className="font-option-cat">{font.category}</span>
                {active ? <span className="font-option-active">Active</span> : null}
              </span>
              <span className="font-option-note">{font.note}</span>
              <span className="font-option-sample" style={{ fontFamily: font.stack }}>
                {sample}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
