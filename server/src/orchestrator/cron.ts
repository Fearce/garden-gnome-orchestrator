// A small, dependency-free evaluator for standard 5-field cron expressions
// (minute hour day-of-month month day-of-week), computing the next fire time in the
// SERVER'S LOCAL time zone — which is what an operator means by "every day at 9am".
//
// Supported per field: `*`, a single number, `a,b,c` lists, `a-b` ranges, and `*/n`
// or `a-b/n` steps. Day-of-week is 0-6 with 0 = Sunday; 7 is accepted as Sunday too.
// When BOTH day-of-month and day-of-week are restricted, a minute matches if EITHER
// matches (the standard Vixie-cron OR rule); otherwise both must match.

interface CronField {
  values: Set<number>;
  restricted: boolean; // false when the source was "*", so it never constrains the OR rule
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
} as const;

function parseField(spec: string, min: number, max: number, name: string): CronField {
  const restricted = spec.trim() !== "*";
  const values = new Set<number>();
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (!part) throw new Error(`cron ${name}: empty term`);
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length) throw new Error(`cron ${name}: malformed step "${part}"`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${name}: bad step "${part}"`);

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart!.includes("-")) {
      const [a, b] = rangePart!.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`cron ${name}: non-integer "${part}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`cron ${name}: "${part}" out of ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) throw new Error(`cron ${name}: no values`);
  return { values, restricted };
}

/** Parse a 5-field cron string, throwing a descriptive Error on anything malformed. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron: expected 5 fields, got ${fields.length}`);
  const [minute, hour, dom, month, dowRaw] = fields;
  const dow = parseField(dowRaw!, 0, 7, "day-of-week");
  // 7 is a legal alias for Sunday — fold it into 0 so the getDay() (0-6) match works.
  if (dow.values.delete(7)) dow.values.add(0);
  return {
    minute: parseField(minute!, ...RANGES.minute, "minute"),
    hour: parseField(hour!, ...RANGES.hour, "hour"),
    dom: parseField(dom!, ...RANGES.dom, "day-of-month"),
    month: parseField(month!, ...RANGES.month, "month"),
    dow,
  };
}

/** Whether an expression parses — the cheap boolean gate for validation at the API boundary. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function matches(p: ParsedCron, d: Date): boolean {
  if (!p.minute.values.has(d.getMinutes())) return false;
  if (!p.hour.values.has(d.getHours())) return false;
  if (!p.month.values.has(d.getMonth() + 1)) return false;
  const domOk = p.dom.values.has(d.getDate());
  const dowOk = p.dow.values.has(d.getDay());
  // Vixie-cron OR rule: with both day fields restricted, either satisfies; otherwise the unrestricted
  // one is always-true (its set covers the whole range), so the effect is a plain AND.
  if (p.dom.restricted && p.dow.restricted) return domOk || dowOk;
  return domOk && dowOk;
}

// A minute-stepping search is simple and provably correct; the cap bounds the pathological
// "matches nothing reachable" case (e.g. Feb 30) at ~4 years of minutes instead of looping forever.
const MAX_MINUTES = 366 * 4 * 24 * 60;

/**
 * The next epoch-ms this cron fires, strictly after `afterMs` (local time). Returns null if no match
 * exists within ~4 years (an impossible expression like `0 0 30 2 *`). Seconds/millis are zeroed —
 * cron granularity is one minute — and the search starts at the next whole minute after `afterMs`.
 */
export function nextRun(expr: string, afterMs: number): number | null {
  const p = parseCron(expr);
  const d = new Date(afterMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after — never re-fire the current minute
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (matches(p, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
