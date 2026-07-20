// Client-side cron helpers for the Scheduled Tasks UI: a friendly recurrence builder that compiles to a
// 5-field cron string, a best-effort parse back for editing, a human description, and a validity check
// that mirrors the server's parser (server/src/orchestrator/cron.ts) so the form never submits a cron the
// server would reject.

export type Freq = "minutes" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

export interface Recurrence {
  freq: Freq;
  interval: number; // every N minutes (minutes) or every N hours (hourly)
  minute: number; // 0-59
  hour: number; // 0-23
  days: number[]; // 0-6, Sun=0 (weekly)
  dom: number; // 1-31 (monthly)
  raw: string; // custom cron
}

export const DEFAULT_RECURRENCE: Recurrence = {
  freq: "daily",
  interval: 30,
  minute: 0,
  hour: 9,
  days: [1, 2, 3, 4, 5],
  dom: 1,
  raw: "0 9 * * *",
};

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th", "13th", "14th", "15th", "16th", "17th", "18th", "19th", "20th", "21st", "22nd", "23rd", "24th", "25th", "26th", "27th", "28th", "29th", "30th", "31st"];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/** Compile the builder state to a 5-field cron string. */
export function recurrenceToCron(r: Recurrence): string {
  switch (r.freq) {
    case "minutes":
      return `*/${clamp(r.interval, 1, 59)} * * * *`;
    case "hourly":
      return `${clamp(r.minute, 0, 59)} */${clamp(r.interval, 1, 23)} * * *`;
    case "daily":
      return `${clamp(r.minute, 0, 59)} ${clamp(r.hour, 0, 23)} * * *`;
    case "weekly": {
      const days = r.days.length ? [...new Set(r.days)].sort((a, b) => a - b).join(",") : "*";
      return `${clamp(r.minute, 0, 59)} ${clamp(r.hour, 0, 23)} * * ${days}`;
    }
    case "monthly":
      return `${clamp(r.minute, 0, 59)} ${clamp(r.hour, 0, 23)} ${clamp(r.dom, 1, 31)} * *`;
    case "custom":
      return r.raw.trim();
  }
}

/** Best-effort parse of a cron string back into builder state, so editing an existing schedule prefills
 *  the friendly controls. Anything that doesn't fit a known shape falls back to the Custom tab. */
export function cronToRecurrence(cron: string): Recurrence {
  const base = { ...DEFAULT_RECURRENCE, raw: cron.trim() };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return { ...base, freq: "custom" };
  const [mi, ho, dom, mon, dow] = f;
  const stepOf = (s: string) => (/^\*\/\d+$/.test(s) ? Number(s.slice(2)) : null);

  // Every N minutes: */N * * * *
  const minStep = stepOf(mi!);
  if (minStep && ho === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...base, freq: "minutes", interval: minStep };
  }
  // Every N hours at :M — M */N * * *
  const hourStep = stepOf(ho!);
  if (/^\d+$/.test(mi!) && hourStep && dom === "*" && mon === "*" && dow === "*") {
    return { ...base, freq: "hourly", interval: hourStep, minute: Number(mi) };
  }
  // From here on both minute + hour must be plain numbers.
  if (!/^\d+$/.test(mi!) || !/^\d+$/.test(ho!) || mon !== "*") return { ...base, freq: "custom" };
  const minute = Number(mi);
  const hour = Number(ho);
  // Weekly: M H * * <days>  (dom = *)
  if (dom === "*" && dow !== "*" && /^[0-6](,[0-6])*$/.test(dow!)) {
    return { ...base, freq: "weekly", minute, hour, days: dow!.split(",").map(Number) };
  }
  // Monthly: M H <dom> * *  (dow = *)
  if (dow === "*" && /^\d+$/.test(dom!)) {
    return { ...base, freq: "monthly", minute, hour, dom: Number(dom) };
  }
  // Daily: M H * * *
  if (dom === "*" && dow === "*") {
    return { ...base, freq: "daily", minute, hour };
  }
  return { ...base, freq: "custom" };
}

// ---- a compact mirror of the server's parser, for client-side validation ----

function parseField(spec: string, min: number, max: number): boolean {
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (!part) return false;
    const [range, stepStr, ...rest] = part.split("/");
    if (rest.length) return false;
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) return false;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
    if (lo < min || hi > max || lo > hi) return false;
  }
  return true;
}

/** Whether a 5-field cron string parses — mirrors the server so the UI can gate submission. */
export function isValidCron(expr: string): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  return (
    parseField(f[0]!, 0, 59) &&
    parseField(f[1]!, 0, 23) &&
    parseField(f[2]!, 1, 31) &&
    parseField(f[3]!, 1, 12) &&
    parseField(f[4]!, 0, 7)
  );
}

/** A human-readable description of a cron string ("Daily at 09:00", "Every 30 minutes", …). Falls back
 *  to the raw expression for shapes it doesn't special-case, so it's always safe to render. */
export function describeCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [mi, ho, dom, mon, dow] = f;
  const stepOf = (s: string) => (/^\*\/\d+$/.test(s) ? Number(s.slice(2)) : null);

  const minStep = stepOf(mi!);
  if (minStep && ho === "*" && dom === "*" && mon === "*" && dow === "*") {
    return minStep === 1 ? "Every minute" : `Every ${minStep} minutes`;
  }
  const hourStep = stepOf(ho!);
  if (/^\d+$/.test(mi!) && hourStep && dom === "*" && mon === "*" && dow === "*") {
    return hourStep === 1 ? `Hourly at :${pad(Number(mi))}` : `Every ${hourStep} hours at :${pad(Number(mi))}`;
  }
  if (ho === "*" && mi === "0" && dom === "*" && mon === "*" && dow === "*") return "Hourly, on the hour";

  if (/^\d+$/.test(mi!) && /^\d+$/.test(ho!) && mon === "*") {
    const time = hhmm(Number(ho), Number(mi));
    if (dom === "*" && dow === "*") return `Daily at ${time}`;
    if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow!)) {
      const days = dow!.split(",").map((d) => WEEKDAY_LABELS[Number(d)]);
      const isEveryWeekday = dow === "1,2,3,4,5";
      return `${isEveryWeekday ? "Weekdays" : days.join(", ")} at ${time}`;
    }
    if (dow === "*" && /^\d+$/.test(dom!)) return `Monthly on the ${ORDINALS[Number(dom)] ?? dom} at ${time}`;
  }
  return cron;
}
