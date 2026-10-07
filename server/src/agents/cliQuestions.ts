/** Same payload as the bus ask_user tool, bounded before it reaches storage/UI. */
export interface CliQuestion {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export function parseCliQuestion(raw: unknown): CliQuestion | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const q = raw as Record<string, unknown>;
  if (typeof q.header !== "string" || !q.header.trim() || q.header.length > 40) return undefined;
  if (typeof q.question !== "string" || !q.question.trim() || q.question.length > 12_000) return undefined;
  if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") return undefined;
  const options = q.options ?? [];
  if (!Array.isArray(options) || options.length > 20) return undefined;
  for (const option of options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) return undefined;
    if (typeof option.label !== "string" || !option.label.trim() || option.label.length > 200) return undefined;
    if (option.description !== undefined && (typeof option.description !== "string" || option.description.length > 2_000)) return undefined;
  }
  return { header: q.header.trim(), question: q.question.trim(), options, multiSelect: q.multiSelect === true };
}

/** Hold CLI completion until every chip is answered, then queue answers into the same session. */
export class CliQuestionGate {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly ask: ((question: CliQuestion) => Promise<string>) | undefined,
    private readonly reply: (text: string) => void,
  ) {}

  submit(question: CliQuestion): void {
    let answer: Promise<string>;
    try {
      if (!this.ask) throw new Error("Question bridge unavailable for this run");
      answer = this.ask(question);
    } catch (error) { answer = Promise.reject(error); }
    const pending = answer.then(
      (value) => this.reply(`Owner answered your question "${question.question}": ${value}`),
      (error) => this.reply(`Your question could not be posted: ${String(error)}. Do not guess the owner's answer; report the blocker.`),
    ).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  get waiting(): boolean { return this.pending.size > 0; }

  async wait(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
  }
}
