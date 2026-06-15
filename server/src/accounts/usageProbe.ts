import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface AccountUsageSnapshot {
  email?: string;
  subscriptionType?: string;
  available: boolean; // rate_limits_available (false for API-key sessions)
  fiveHour: number | null; // utilization 0-100
  fiveHourResetsAt?: string | null;
  sevenDay: number | null; // utilization 0-100 (the scarce weekly window)
  sevenDayResetsAt?: string | null;
  sevenDayOpus?: number | null;
  sevenDaySonnet?: number | null;
  error?: string | null;
}

// Keeps streaming-input mode open without ever sending a user message, so the
// session inits and we can call the /usage control method with zero model cost.
async function* idleInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Read one account's plan rate-limit utilization (5-hour + 7-day windows) via the
 * SDK /usage control request. Pass the account's OAuth token; an empty token
 * inherits the logged-in CLI account. No prompt is sent, so this costs no model
 * tokens — just a CLI spawn + the claude.ai usage fetch.
 */
export async function probeUsage(token: string, timeoutMs = 30_000): Promise<AccountUsageSnapshot> {
  const abort = new AbortController();
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;

  const q = query({
    prompt: idleInput(abort.signal),
    options: {
      model: "claude-haiku-4-5",
      settingSources: [],
      includePartialMessages: false,
      permissionMode: "bypassPermissions",
      env,
      abortController: abort,
    },
  });

  const withTimeout = <T>(p: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new Error("usage probe timeout")), timeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };

  try {
    await withTimeout(q.initializationResult());
    const usage = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET());
    let email: string | undefined;
    let subFromAccount: string | undefined;
    try {
      const acct = await withTimeout(q.accountInfo());
      email = acct.email;
      subFromAccount = acct.subscriptionType;
    } catch {
      /* accountInfo is best-effort */
    }
    const rl = usage.rate_limits;
    return {
      email,
      subscriptionType: usage.subscription_type ?? subFromAccount,
      available: usage.rate_limits_available,
      fiveHour: rl?.five_hour?.utilization ?? null,
      fiveHourResetsAt: rl?.five_hour?.resets_at ?? null,
      sevenDay: rl?.seven_day?.utilization ?? null,
      sevenDayResetsAt: rl?.seven_day?.resets_at ?? null,
      sevenDayOpus: rl?.seven_day_opus?.utilization ?? null,
      sevenDaySonnet: rl?.seven_day_sonnet?.utilization ?? null,
      error: null,
    };
  } catch (e) {
    return {
      available: false,
      fiveHour: null,
      sevenDay: null,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    abort.abort();
    try {
      q.close();
    } catch {
      /* already torn down */
    }
  }
}
