/**
 * Which review-parked tasks a usage-window rollover is allowed to continue by itself.
 *
 * Most capacity stops already carry the durable `⏳ Auto-resume pending` marker, and the cap supervisor
 * owns those. This module covers the OTHER shape: an implementor that stopped for a capacity reason the
 * park pipeline never marked, i.e. a per-session turn or cost ceiling, or a provider's own "session
 * limit · resets 7pm" text lifted verbatim into the park message by `implementorParkReason`. Those
 * parked plainly in `review`, nothing woke them, and the owner was hand-dispatching sweep tasks at every
 * rollover to continue them.
 *
 * The bias is deliberately one-way. A missed wake costs one click; a wrong wake spends a whole
 * implementor session on work a person had already decided to look at themselves. So a park qualifies
 * only when it is BOTH an implementor park AND names a capacity reason AND carries no marker that means
 * a human owns it. Anything ambiguous stays parked.
 */

/** The opening `ThreadManager.implementorParkReason` writes on every implementor park, matched without
 *  its trailing separator so a punctuation change cannot silently empty this class. Requiring it is what
 *  keeps a QA park out: a QA park lifts the QA run's OWN error text, which can name the same capacity
 *  reason, and waking the implementor for a stalled review would be wrong. */
const IMPLEMENTOR_PARK_OPENING = "Implementor ended without completing";

/** Reasons that mean "the allowance ran out", not "the work is wrong". The first two are the SDK's own
 *  involuntary cutoffs as `runError.ts` renders them; the rest are the provider wording the CLI backends
 *  return in a result, which `runErrorText` prefers over any canned line. */
const CAPACITY_REASONS: RegExp[] = [
  /per-session turn ceiling/i, // error_max_turns
  /per-session cost ceiling/i, // error_max_budget_usd
  /session limit/i,
  /usage limit/i,
  /rate[- ]?limit/i,
  /\bquota\b/i,
  /\bresets?\s+(?:at|in|on|\d)/i, // "resets 7pm", "resets at 19:00", "resets in 2h"
];

/** Text that means a person owns this park. Checked before the reasons and never overridden, so a
 *  message that happens to mention a limit while ALSO asking for the owner stays with the owner. */
const OWNER_OWNED: RegExp[] = [
  /needs your review/i,
  /hard deadline/i,
  /⏰/,
];

/**
 * How many times one task may be continued this way. The stall can repeat, since an implementor that hit
 * the turn ceiling once often hits it again, so without a bound a rollover would wake the same task every
 * five hours forever. That is the exact spend this mechanism exists to stop. Three attempts is enough for
 * a long task to finish across a couple of windows; past that it stays parked for a person.
 */
export const MAX_CAPACITY_STALL_RESUMES = 3;

/** True when a park is an unmarked, capacity-shaped implementor stop that a rollover may continue. */
export function isCapacityStallPark(error: string | null | undefined): boolean {
  const text = (error ?? "").trim();
  if (!text.startsWith(IMPLEMENTOR_PARK_OPENING)) return false;
  if (OWNER_OWNED.some((re) => re.test(text))) return false;
  return CAPACITY_REASONS.some((re) => re.test(text));
}
