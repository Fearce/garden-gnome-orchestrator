// Reads one JavaScript object/array literal out of a source file WITHOUT executing it — for upstream
// data tables published as `export const x = { ... }` modules. Accepts quoted or bare keys, single/double/
// backtick strings, comments and trailing commas; anything that is code rather than data throws.

export type JsLiteral = string | number | boolean | null | JsLiteral[] | { [key: string]: JsLiteral };

/** Parse the literal assigned to `const <name> =` in `source`. */
export function readAssignedLiteral(source: string, name: string): JsLiteral {
  const declaration = new RegExp(`\\b${name}\\s*=\\s*`).exec(source);
  if (!declaration) throw new Error(`${name} is not assigned in this source`);
  return new JsLiteralReader(source, declaration.index + declaration[0].length).value();
}

export function recordOf(value: JsLiteral | undefined): { [key: string]: JsLiteral } | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

class JsLiteralReader {
  constructor(private readonly src: string, private pos: number) {}

  value(): JsLiteral {
    this.skipSpace();
    const ch = this.src[this.pos];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"' || ch === "'" || ch === "`") return this.string();
    const number = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(this.src.slice(this.pos, this.pos + 40));
    if (number) {
      this.pos += number[0].length;
      return Number(number[0]);
    }
    const word = this.identifier();
    if (word === "true" || word === "false") return word === "true";
    if (word === "null" || word === "undefined") return null;
    throw new Error(`unsupported value "${word}" at ${this.pos}`);
  }

  private object(): { [key: string]: JsLiteral } {
    const out: { [key: string]: JsLiteral } = {};
    this.pos++;
    for (;;) {
      this.skipSpace();
      if (this.src[this.pos] === "}") {
        this.pos++;
        return out;
      }
      const ch = this.src[this.pos];
      const key = ch === '"' || ch === "'" ? this.string() : this.identifier();
      this.expect(":");
      out[key] = this.value();
      this.endOfItem("}");
    }
  }

  private array(): JsLiteral[] {
    const out: JsLiteral[] = [];
    this.pos++;
    for (;;) {
      this.skipSpace();
      if (this.src[this.pos] === "]") {
        this.pos++;
        return out;
      }
      out.push(this.value());
      this.endOfItem("]");
    }
  }

  private string(): string {
    const quote = this.src[this.pos++];
    let out = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos++]!;
      if (ch === quote) return out;
      if (quote === "`" && ch === "$" && this.src[this.pos] === "{") throw new Error("template interpolation is code, not data");
      out += ch === "\\" ? this.escaped(this.src[this.pos++] ?? "") : ch;
    }
    throw new Error("unterminated string");
  }

  private escaped(ch: string): string {
    if (ch === "u" && /^[0-9a-f]{4}$/i.test(this.src.slice(this.pos, this.pos + 4))) {
      this.pos += 4;
      return String.fromCharCode(parseInt(this.src.slice(this.pos - 4, this.pos), 16));
    }
    return ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[ch] ?? ch;
  }

  private identifier(): string {
    const m = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.pos, this.pos + 200));
    if (!m) throw new Error(`unexpected "${this.src[this.pos] ?? "end of input"}" at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private endOfItem(close: string): void {
    this.skipSpace();
    if (this.src[this.pos] === ",") this.pos++;
    else if (this.src[this.pos] !== close) throw new Error(`expected "," or "${close}" at ${this.pos}`);
  }

  private expect(ch: string): void {
    this.skipSpace();
    if (this.src[this.pos] !== ch) throw new Error(`expected "${ch}" at ${this.pos}`);
    this.pos++;
  }

  private skipSpace(): void {
    for (;;) {
      const next = this.src.slice(this.pos, this.pos + 2);
      if (/^\s/.test(next)) this.pos++;
      else if (next === "//") this.pos = this.after("\n", this.pos);
      else if (next === "/*") this.pos = this.after("*/", this.pos + 2);
      else return;
    }
  }

  private after(token: string, from: number): number {
    const at = this.src.indexOf(token, from);
    return at < 0 ? this.src.length : at + token.length;
  }
}
