import type { ClientMessage } from "./streamClient.js";

type Send = (message: ClientMessage) => void;

export const MODIFIER_CODES = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"] as const;
export type ModifierCode = (typeof MODIFIER_CODES)[number];

// Zero-width spaces: the textarea is never empty, so a Backspace on "nothing" still shows up as a
// deletion, and no visible character sits in front of the caret to steer autocapitalisation.
const SENTINEL = "​​";
const RESET_AFTER_CHARS = 64;

/**
 * Keyboard input for the remote PC through one hidden textarea.
 *
 * A physical keyboard sends real key codes, forwarded as scancodes so the PC's own layout applies. A
 * touch keyboard mostly reports "Unidentified" keys and composes words, so its text is read by diffing
 * the textarea after every input: removed characters become Backspaces, added ones are typed as text.
 * Latched modifiers (the on-screen Ctrl/Alt/Shift/Win) wrap the next key or character as a shortcut.
 */
export class KeyboardSink {
  private previous = SENTINEL;
  private composing = false;
  private latched = new Set<ModifierCode>();
  private readonly detach: () => void;

  constructor(private readonly input: HTMLTextAreaElement, private readonly send: Send, private readonly onLatchChange: (latched: ReadonlySet<ModifierCode>) => void) {
    this.reset();
    const listeners: [string, EventListener][] = [
      ["keydown", (e) => this.onKeyDown(e as KeyboardEvent)],
      ["keyup", (e) => this.onKeyUp(e as KeyboardEvent)],
      ["input", () => { if (!this.composing) this.sync(); }],
      ["compositionstart", () => { this.composing = true; }],
      ["compositionend", () => { this.composing = false; this.sync(); }],
      ["blur", () => this.send({ t: "release" })],
    ];
    for (const [type, listener] of listeners) input.addEventListener(type, listener);
    this.detach = () => {
      for (const [type, listener] of listeners) input.removeEventListener(type, listener);
    };
  }

  dispose(): void {
    this.detach();
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** Toggle an on-screen modifier. Tapping a latched one again with nothing in between sends it alone. */
  toggleModifier(code: ModifierCode): void {
    if (this.latched.has(code)) {
      this.latched.delete(code);
      this.tapKey(code, false);
    } else {
      this.latched.add(code);
    }
    this.onLatchChange(new Set(this.latched));
  }

  /** An on-screen key (Esc, arrows, Delete…): pressed with whatever modifiers are latched. */
  pressKey(code: string): void {
    this.tapKey(code, true);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229 || e.key === "Unidentified" || !e.code) return;
    e.preventDefault();
    if (this.latched.size && !e.repeat) return this.tapKey(e.code, true);
    this.send({ t: "key", code: e.code, down: true });
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229 || e.key === "Unidentified" || !e.code) return;
    e.preventDefault();
    this.send({ t: "key", code: e.code, down: false });
  }

  private sync(): void {
    const current = this.input.value;
    const previous = this.previous;
    let common = 0;
    while (common < previous.length && common < current.length && previous[common] === current[common]) common++;
    for (let i = common; i < previous.length; i++) this.tapKey("Backspace", false);
    const inserted = current.slice(common).replace(/​/g, "");
    if (inserted) this.type(inserted);
    this.previous = current;
    if (!current.startsWith(SENTINEL) || current.length > RESET_AFTER_CHARS) this.reset();
  }

  private type(text: string): void {
    if (!this.latched.size) return this.send({ t: "text", text });
    // A shortcut like Ctrl+C needs the key itself; Unicode text would type a bare "c".
    for (const char of text) {
      const code = codeForChar(char);
      if (code) this.tapKey(code, true);
      else this.send({ t: "text", text: char });
    }
  }

  private tapKey(code: string, withLatched: boolean): void {
    const modifiers = withLatched ? [...this.latched] : [];
    for (const modifier of modifiers) this.send({ t: "key", code: modifier, down: true });
    this.send({ t: "key", code, down: true });
    this.send({ t: "key", code, down: false });
    for (const modifier of modifiers.reverse()) this.send({ t: "key", code: modifier, down: false });
    if (modifiers.length) {
      this.latched.clear();
      this.onLatchChange(new Set());
    }
  }

  private reset(): void {
    this.input.value = SENTINEL;
    this.input.setSelectionRange(SENTINEL.length, SENTINEL.length);
    this.previous = SENTINEL;
  }
}

function codeForChar(char: string): string | null {
  if (/^[a-z]$/i.test(char)) return `Key${char.toUpperCase()}`;
  if (/^[0-9]$/.test(char)) return `Digit${char}`;
  if (char === " ") return "Space";
  if (char === "\n") return "Enter";
  return null;
}
