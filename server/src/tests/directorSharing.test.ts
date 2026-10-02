// Director sharing: the donor's rules (authorization, independent per-subscription shares, expiry at the
// exact deadline, deadline edits, stop, concurrency and hourly limits, restart and downtime across the
// deadline), the recipient's refusals, and the Director never falling back to a private subscription.
// Free: a fake provider `fetch`, a loopback in place of the relay (relay routing has its own gate,
// test:relay-core), and a real Director on a throwaway database.
process.env.CAP_RETRY_MS = "0";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Scheduler } from "../orchestrator/scheduler.js";
import type { OperatorNotes } from "../orchestrator/notes.js";
import type { RelayShareMessage, ServerFrame } from "../office/onlineProtocol.js";
import type { ShareClientFrame } from "../office/directorShare/client.js";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { Director } = await import("../orchestrator/director.js");
const { DirectorShareHost, SHARE_MAX_HORIZON_MS } = await import("../office/directorShare/host.js");
const { DirectorShareClient } = await import("../office/directorShare/client.js");
const { directorShareSubscriptions, directorShareEndpoint } = await import("../office/directorShare/policy.js");
const { SharedDirectorRun, fitToLimit } = await import("../agents/sharedDirectorRun.js");
const { DIRECTOR_CLI_SCHEMA } = await import("../orchestrator/directorCliBridge.js");

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: string): void => {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? `: ${detail}` : ""}`); }
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const dir = mkdtempSync(join(tmpdir(), "director-sharing-"));
const OPENAI_KEY = "sk-test-donor-secret-key-000000";
const XAI_KEY = "xai-test-donor-secret-key-111111";
const HOUR = 60 * 60_000;
/** Every database this gate opens, closed before the temp folder is removed (Windows refuses otherwise). */
const dbs: Array<InstanceType<typeof Db>> = [];
const openDb = (path: string): InstanceType<typeof Db> => {
  const db = new Db(path);
  dbs.push(db);
  return db;
};

/** A provider that answers each request on demand, so a test can hold calls in flight. */
class FakeProvider {
  requests: Array<{ url: string; body: { model: string; messages: RelayShareMessage[] }; auth: string; signal: AbortSignal; answer: (text: string) => void; fail: (status: number, code?: string) => void }> = [];
  fetch = (url: string, init: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
    const signal = init.signal as AbortSignal;
    if (url.endsWith("/models")) {
      resolve(new Response(JSON.stringify({ data: [{ id: "gpt-test-mini" }, { id: "text-embedding-3-small" }, { id: "gpt-test-codex" }] }), { status: 200 }));
      return;
    }
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    this.requests.push({
      url,
      body: JSON.parse(String(init.body)),
      auth: String((init.headers as Record<string, string>).authorization),
      signal,
      answer: (text) => resolve(new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }), { status: 200 })),
      fail: (status, code) => resolve(new Response(JSON.stringify({ error: { code, message: `upstream says ${OPENAI_KEY.slice(0, 8)}...` } }), { status })),
    });
  });
}

interface Donor {
  db: InstanceType<typeof Db>;
  host: InstanceType<typeof DirectorShareHost>;
  sent: ShareClientFrame[];
  provider: FakeProvider;
  clock: { now: number };
}

function makeDonor(name: string, clock = { now: Date.UTC(2026, 9, 2, 12, 0, 0) }, dbPath = join(dir, `${name}.sqlite`)): Donor {
  const db = openDb(dbPath);
  const sent: ShareClientFrame[] = [];
  const provider = new FakeProvider();
  const sources = { claudeAccounts: [{ id: "max1", label: "Max one" }], openaiApiKey: OPENAI_KEY, codexChatgptLogin: true, xaiApiKey: XAI_KEY, grokLogin: true, zaiConfigured: true };
  const host = new DirectorShareHost({
    db,
    subscriptions: () => directorShareSubscriptions(sources),
    endpoint: (id) => directorShareEndpoint(id, sources),
    send: (frame) => { sent.push(frame); return true; },
    changed: () => {},
    fetch: provider.fetch,
    now: () => clock.now,
  });
  host.start();
  return { db, host, sent, provider, clock };
}

const terms = (clock: { now: number }, extra: Partial<{ expiresAt: number; maxConcurrent: number; maxRequestsPerHour: number }> = {}) => ({
  expiresAt: clock.now + HOUR,
  timeZone: "Europe/Copenhagen",
  maxConcurrent: 2,
  maxRequestsPerHour: 60,
  ...extra,
});

const call = (shareId: string, callId: string, from = "recipient-a", content = "Return a JSON reply."): Extract<ServerFrame, { t: "share.call" }> =>
  ({ t: "share.call", from, fromName: `Owner of ${from}`, callId, shareId, messages: [{ role: "user", content }] });

const replyTo = (d: Donor, callId: string) => d.sent.find((f) => f.t === "share.reply" && f.callId === callId) as Extract<ShareClientFrame, { t: "share.reply" }> | undefined;
const shareOf = (d: Donor, id: string) => d.host.view().find((v) => v.subscription.id === id)?.share ?? null;

try {
  console.log("\n=== which subscriptions may be shared ===\n");
  {
    const d = makeDonor("eligibility");
    const view = d.host.view();
    const byId = new Map(view.map((v) => [v.subscription.id, v.subscription]));
    check("only the API-key subscriptions are shareable", view.filter((v) => v.subscription.shareable).map((v) => v.subscription.id).join(",") === "openai-api,xai-api");
    check("plan sign-ins are listed with the provider's reason", ["claude:max1", "codex-chatgpt", "grok-login", "zai"].every((id) => byId.get(id) && !byId.get(id)!.shareable && byId.get(id)!.reason.length > 20 && byId.get(id)!.sourceUrl.startsWith("https://")));
    check("every subscription defaults to private", view.every((v) => v.share === null));
    check("nothing is advertised by default", d.host.offers().length === 0);
    const refused = d.host.share("claude:max1", "claude-opus", terms(d.clock));
    check("a Claude plan cannot be shared", !refused.ok && /Anthropic/.test(refused.error), JSON.stringify(refused));
    check("an unknown subscription cannot be shared", !d.host.share("nope", "gpt-test-mini", terms(d.clock)).ok);
    const models = await d.host.models("openai-api");
    check("the model picker lists chat models only", models.ok && models.models.join(",") === "gpt-test-mini", JSON.stringify(models));
    check("a non-shareable subscription lists no models", !(await d.host.models("codex-chatgpt")).ok);
    check("a ChatGPT-plan key is not an API key", directorShareSubscriptions({ claudeAccounts: [], openaiApiKey: "eyJhbGciOi", codexChatgptLogin: false, grokLogin: false, zaiConfigured: false }).length === 0);
  }

  console.log("\n=== deadlines and independent subscriptions ===\n");
  {
    const d = makeDonor("terms");
    check("a past deadline is refused", !d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { expiresAt: d.clock.now - 1 })).ok);
    check("a deadline under a minute away is refused", !d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { expiresAt: d.clock.now + 30_000 })).ok);
    check("a deadline past 30 days is refused", !d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { expiresAt: d.clock.now + SHARE_MAX_HORIZON_MS + 1 })).ok);
    check("concurrency outside 1..4 is refused", !d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { maxConcurrent: 5 })).ok);
    check("a NaN deadline is refused", !d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { expiresAt: Number.NaN })).ok);
    check("nothing was shared by the refusals", d.host.offers().length === 0);

    const openaiDeadline = d.clock.now + HOUR;
    const xaiDeadline = d.clock.now + 3 * HOUR;
    check("the OpenAI key can be shared", d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { expiresAt: openaiDeadline })).ok);
    check("the xAI key is shared independently with its own deadline", d.host.share("xai-api", "grok-test", terms(d.clock, { expiresAt: xaiDeadline, maxConcurrent: 1 })).ok);
    const o = shareOf(d, "openai-api")!;
    const x = shareOf(d, "xai-api")!;
    check("each share keeps its own deadline, timezone and limits", o.expiresAt === openaiDeadline && x.expiresAt === xaiDeadline && x.maxConcurrent === 1 && o.timeZone === "Europe/Copenhagen");
    check("each share has its own id", o.shareId !== x.shareId);
    check("an already-shared subscription is not re-shared silently", !d.host.share("openai-api", "gpt-test-mini", terms(d.clock)).ok);
    const offers = d.host.offers();
    check("both live shares are advertised", offers.length === 2);
    check("an offer carries no key", !JSON.stringify(offers).includes(OPENAI_KEY) && !JSON.stringify(offers).includes(XAI_KEY));
    check("the view carries no key", !JSON.stringify(d.host.view()).includes(OPENAI_KEY));

    const extended = openaiDeadline + 2 * HOUR;
    check("a live deadline can be extended", d.host.update("openai-api", terms(d.clock, { expiresAt: extended })).ok && shareOf(d, "openai-api")!.expiresAt === extended);
    check("an edit keeps the share id", shareOf(d, "openai-api")!.shareId === o.shareId);
    check("an edit to a past deadline is refused", !d.host.update("openai-api", terms(d.clock, { expiresAt: d.clock.now - 5 })).ok && shareOf(d, "openai-api")!.expiresAt === extended);
    check("the xAI share was untouched by the OpenAI edit", shareOf(d, "xai-api")!.expiresAt === xaiDeadline);
    check("stopping one share leaves the other live", d.host.stop("xai-api").ok && shareOf(d, "xai-api")!.status === "stopped" && shareOf(d, "openai-api")!.status === "shared");
    check("a stopped share is no longer advertised", d.host.offers().map((x) => x.shareId).join() === o.shareId);
    check("a stopped share cannot be edited back to life", !d.host.update("xai-api", terms(d.clock)).ok);
  }

  console.log("\n=== the expiry boundary ===\n");
  {
    const d = makeDonor("boundary");
    const deadline = d.clock.now + HOUR;
    d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { expiresAt: deadline }));
    const shareId = shareOf(d, "openai-api")!.shareId;

    d.clock.now = deadline - 1;
    void d.host.handleCall(call(shareId, "c-before"));
    await tick();
    check("a call one millisecond before the deadline reaches the provider", d.provider.requests.length === 1);
    check("the donor's key is used on the donor's host only", d.provider.requests[0]?.auth === `Bearer ${OPENAI_KEY}` && d.provider.requests[0]?.body.model === "gpt-test-mini");

    d.clock.now = deadline;
    void d.host.handleCall(call(shareId, "c-at"));
    await tick();
    check("a call AT the deadline is refused as expired", replyTo(d, "c-at")?.code === "expired" && d.provider.requests.length === 1, JSON.stringify(replyTo(d, "c-at")));
    check("the call in flight at the deadline is cancelled at the provider", d.provider.requests[0]!.signal.aborted);
    check("its caller is told the share expired", replyTo(d, "c-before")?.code === "expired", JSON.stringify(replyTo(d, "c-before")));
    check("the share reads as expired", shareOf(d, "openai-api")?.status === "expired");
    check("an expired share is not advertised", d.host.offers().length === 0);
    check("an expired share cannot be extended", !d.host.update("openai-api", terms(d.clock)).ok);
    check("sharing again is a fresh opt-in with a new id", d.host.share("openai-api", "gpt-test-mini", terms(d.clock)).ok && shareOf(d, "openai-api")!.shareId !== shareId);
    void d.host.handleCall(call(shareId, "c-stale"));
    await tick();
    check("the old share id is refused after the fresh opt-in", replyTo(d, "c-stale")?.ok === false && d.provider.requests.length === 1, JSON.stringify(replyTo(d, "c-stale")));
    check("the fresh share starts with zeroed usage", shareOf(d, "openai-api")!.usage.requests === 0);
  }

  console.log("\n=== a reply that lands after the deadline is withheld ===\n");
  {
    const d = makeDonor("late-reply");
    const deadline = d.clock.now + HOUR;
    d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { expiresAt: deadline }));
    const shareId = shareOf(d, "openai-api")!.shareId;
    const done = d.host.handleCall(call(shareId, "c-late"));
    await tick();
    d.clock.now = deadline + 5; // no read has swept yet: the reply path itself must re-check
    d.provider.requests[0]!.answer('{"kind":"reply","message":"too late"}');
    await done;
    const r = replyTo(d, "c-late");
    check("the provider's text is not delivered past the deadline", r?.ok === false && r.code === "expired" && !r.text, JSON.stringify(r));
  }

  console.log("\n=== usage, concurrency and the hourly limit ===\n");
  {
    const d = makeDonor("limits");
    d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { expiresAt: d.clock.now + 3 * HOUR, maxConcurrent: 1, maxRequestsPerHour: 2 }));
    const shareId = shareOf(d, "openai-api")!.shareId;
    const first = d.host.handleCall(call(shareId, "u1"));
    await tick();
    void d.host.handleCall(call(shareId, "u2", "recipient-b"));
    await tick();
    check("a second concurrent call is refused as busy", replyTo(d, "u2")?.code === "busy");
    check("the offer reports the slot in use", d.host.offers()[0]?.inFlight === 1);
    d.provider.requests[0]!.answer('{"kind":"reply","message":"hi"}');
    await first;
    const ok = replyTo(d, "u1");
    check("a live call is answered with the model's text", ok?.ok === true && ok.text === '{"kind":"reply","message":"hi"}');
    check("the reply carries token usage", ok?.usage?.inputTokens === 120 && ok.usage.outputTokens === 30);
    const second = d.host.handleCall(call(shareId, "u3", "recipient-b"));
    await tick();
    d.provider.requests[1]!.fail(500);
    await second;
    check("a provider failure is reported without the provider's body", replyTo(d, "u3")?.code === "provider-error" && !JSON.stringify(replyTo(d, "u3")).includes("sk-test"));
    void d.host.handleCall(call(shareId, "u4"));
    await tick();
    check("the hourly request limit refuses the third call", replyTo(d, "u4")?.code === "rate-limited");
    const usage = shareOf(d, "openai-api")!.usage;
    check("usage counts requests, denials and tokens", usage.requests === 2 && usage.denied === 2 && usage.inputTokens === 120 && usage.outputTokens === 30, JSON.stringify(usage));
    check("usage is attributed per recipient", usage.recipients["recipient-a"]?.requests === 1 && usage.recipients["recipient-b"]?.requests === 1);
    d.clock.now += HOUR + 1;
    void d.host.handleCall(call(shareId, "u5"));
    await tick();
    check("the hourly window rolls over", d.provider.requests.length === 3, JSON.stringify(replyTo(d, "u5")));
  }

  console.log("\n=== stop, cancel and isolation ===\n");
  {
    const d = makeDonor("stop");
    d.host.share("openai-api", "gpt-test-mini", terms(d.clock, { maxConcurrent: 3 }));
    const shareId = shareOf(d, "openai-api")!.shareId;
    void d.host.handleCall(call(shareId, "s1"));
    void d.host.handleCall(call(shareId, "s2", "recipient-b"));
    await tick();
    d.host.handleCancel({ t: "share.cancel", from: "recipient-b", callId: "s1" });
    check("a cancel naming another caller's call is ignored", !d.provider.requests[0]!.signal.aborted);
    d.host.handleCancel({ t: "share.cancel", from: "recipient-b", callId: "s2" });
    check("a caller can cancel its own call", d.provider.requests[1]!.signal.aborted);
    check("Stop sharing succeeds", d.host.stop("openai-api").ok);
    check("Stop sharing aborts the provider call in flight", d.provider.requests[0]!.signal.aborted);
    check("its caller is told the donor stopped", replyTo(d, "s1")?.code === "not-shared");
    void d.host.handleCall(call(shareId, "s3"));
    await tick();
    check("a call after the stop is refused", replyTo(d, "s3")?.code === "not-shared" && d.provider.requests.length === 2);
    check("the recipient's messages are forwarded exactly, with nothing of the donor's added", JSON.stringify(d.provider.requests[0]!.body.messages) === JSON.stringify(call(shareId, "x").messages));
  }

  console.log("\n=== restart and downtime across the deadline ===\n");
  {
    const clock = { now: Date.UTC(2026, 9, 2, 12, 0, 0) };
    const path = join(dir, "restart.sqlite");
    const before = makeDonor("restart", clock, path);
    const deadline = clock.now + 2 * HOUR;
    before.host.share("openai-api", "gpt-test-mini", terms(clock, { expiresAt: deadline }));
    const shareId = shareOf(before, "openai-api")!.shareId;
    before.host.dispose();

    const restarted = makeDonor("restart", clock, path);
    check("a share survives a restart before its deadline", shareOf(restarted, "openai-api")?.status === "shared" && shareOf(restarted, "openai-api")!.shareId === shareId);
    restarted.host.dispose();

    clock.now = deadline + 6 * HOUR; // the server was down across the deadline
    const afterDowntime = makeDonor("restart", clock, path);
    check("a deadline passed while down is applied at boot", shareOf(afterDowntime, "openai-api")?.status === "expired");
    check("nothing is advertised after the downtime", afterDowntime.host.offers().length === 0);
    void afterDowntime.host.handleCall(call(shareId, "r1"));
    await tick();
    check("a cached offer from before the downtime is refused", replyTo(afterDowntime, "r1")?.code === "expired" && afterDowntime.provider.requests.length === 0);
    check("the expiry is recorded as the exact deadline", shareOf(afterDowntime, "openai-api")?.endedAt === deadline && shareOf(afterDowntime, "openai-api")?.expiresAt === deadline);
    afterDowntime.host.dispose();
  }

  console.log("\n=== the recipient client ===\n");
  {
    const clock = { now: Date.UTC(2026, 9, 2, 12, 0, 0) };
    const db = openDb(join(dir, "recipient.sqlite"));
    const sent: ShareClientFrame[] = [];
    let relay: "office-offline" | "relay-unsupported" | "ready" = "ready";
    let donorOnline = true;
    const client = new DirectorShareClient({ db, send: (f) => { sent.push(f); return true; }, relayState: () => relay, instanceOnline: () => donorOnline, changed: () => {}, now: () => clock.now });
    const offer = { instanceId: "donor-1", instanceName: "Kevin's PC", donorName: "Kevin", shareId: "share-1", providerLabel: "OpenAI API", model: "gpt-test-mini", expiresAt: clock.now + HOUR, maxConcurrent: 2, inFlight: 0 };
    client.setOffers([offer, { ...offer, shareId: "share-old", expiresAt: clock.now - 1 }]);
    check("an expired entry in a cached roster is not offered", client.offers().map((o) => o.shareId).join() === "share-1");
    check("an offer that is not listed cannot be selected", !client.select("donor-1", "share-old").ok && client.selection() === null);
    check("selection is explicit", client.select("donor-1", "share-1").ok && client.availability() === "available");
    const pending = client.call([{ role: "user", content: "hi" }]);
    const frame = sent.at(-1) as Extract<ShareClientFrame, { t: "share.call" }>;
    check("a call is addressed to the selected donor and share", frame.t === "share.call" && frame.to === "donor-1" && frame.shareId === "share-1");
    client.handleReply({ t: "share.reply", from: "someone-else", callId: frame.callId, ok: true, text: "forged" });
    client.handleReply({ t: "share.reply", from: "donor-1", callId: frame.callId, ok: true, text: "real" });
    const r = await pending;
    check("only the donor's own reply is accepted", r.ok && r.text === "real");

    const aborter = new AbortController();
    const aborted = client.call([{ role: "user", content: "hi" }], aborter.signal);
    aborter.abort();
    check("aborting a call cancels it at the donor", (await aborted).ok === false && sent.at(-1)?.t === "share.cancel");

    client.setOffers([]);
    check("a withdrawn share reads as withdrawn", client.availability() === "withdrawn");
    const w = await client.call([{ role: "user", content: "hi" }]);
    check("a call to a withdrawn share is refused locally", !w.ok && w.code === "not-shared");
    donorOnline = false;
    check("an offline donor reads as offline", client.availability() === "donor-offline");
    relay = "relay-unsupported";
    check("an older relay reads as unsupported", client.availability() === "relay-unsupported");
    relay = "ready";
    client.setOffers([offer]);
    clock.now = offer.expiresAt;
    check("the selection expires at its deadline even with a stale roster", client.availability() === "expired");
    const sentBefore = sent.length;
    const e = await client.call([{ role: "user", content: "hi" }]);
    check("a call past the deadline never leaves this console", !e.ok && e.code === "expired" && sent.length === sentBefore);
    clock.now = offer.expiresAt - HOUR;
    const inFlight = client.call([{ role: "user", content: "hi" }]);
    client.disconnected();
    check("a dropped office connection settles the call in flight", (await inFlight).ok === false);
    client.clearSelection();
    check("Use my own subscriptions clears the pick", client.selection() === null);
  }

  console.log("\n=== the shared Director run ===\n");
  {
    const seen: RelayShareMessage[][] = [];
    let hold: ((v: { ok: true; text: string }) => void) | undefined;
    const run = new SharedDirectorRun({
      schema: DIRECTOR_CLI_SCHEMA,
      call: (messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        return new Promise((resolve) => { hold = resolve; });
      },
    });
    const result = run.nextResult();
    run.start("Owner: hello");
    run.send("Owner: actually, also this");
    hold!({ ok: true, text: '{"kind":"reply","message":"first"}' });
    await tick();
    hold!({ ok: true, text: '{"kind":"reply","message":"second"}' });
    const r = await result;
    check("steering mid-call is folded into one follow-up call", seen.length === 2 && seen[1]!.some((m) => m.content.includes("actually, also this")));
    check("only the command proposed after the steering is executed", (r?.structuredOutput as { message?: string })?.message === "second");
    check("the run ends after its result", run.finished);

    const failing = new SharedDirectorRun({ schema: DIRECTOR_CLI_SCHEMA, call: async () => ({ ok: false, code: "expired", message: "This shared Director expired." }) });
    const fr = failing.nextResult();
    failing.start("Owner: hi");
    const f = await fr;
    check("a refused call ends the run with an error result", f?.isError === true && f.result === "This shared Director expired.");

    const long = [{ role: "user" as const, content: "S".repeat(10) }, ...Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i}`.padEnd(1000, "x") }))];
    const fitted = fitToLimit(long, 5_000);
    check("an over-long transcript keeps the opening message and the newest turns", fitted[0]!.content === long[0]!.content && fitted.at(-1)!.content === long.at(-1)!.content && fitted.reduce((n, m) => n + m.content.length, 0) <= 5_000);
  }

  console.log("\n=== the Director never falls back to a private subscription ===\n");
  {
    const ddir = join(dir, "director");
    mkdirSync(join(ddir, "memory"), { recursive: true });
    const db = openDb(join(ddir, "orchestrator.sqlite"));
    const hub = new EventHub();
    const accounts = {
      onUsageRefresh(): void {}, effectiveUtilization(): number | null { return 10; }, soonestResetAt(): number | null { return null; },
      hasHeadroom(): boolean { return true; }, setPingInterval(): void {}, applyEnabled(): void {}, applyWeeklySafetyPct(): void {},
      setSpreadUsage(): void {}, setProfileToken(): void {}, isModelLimited(): boolean { return false; },
      dispatchPreview(): Record<string, unknown> { return { account: { id: "c1", label: "Claude one", token: "stub" }, hasHeadroom: true, fiveHour: 10, sevenDay: 10, fiveHourReset: null, sevenDayReset: null, weeklySafetyPct: 100 }; },
      dto(): Array<Record<string, unknown>> { return [{ id: "c1", enabled: true, rateLimited: false, fiveHour: 10, sevenDay: 10 }]; },
      isRateLimited(): boolean { return false; }, byId(): undefined { return undefined; },
    };
    const mgr = new ThreadManager(db, hub, new FileMemoryService(join(ddir, "memory")), accounts as unknown as AccountManager);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = mgr as any;
    let privateRuns = 0;
    internals.createDirectorAgent = () => { privateRuns++; throw new Error("a private Director run was started"); };
    let selection: ReturnType<InstanceType<typeof DirectorShareClient>["selection"]> = {
      instanceId: "donor-1", shareId: "share-1", instanceName: "Kevin's PC", donorName: "Kevin", providerLabel: "OpenAI API", model: "gpt-test-mini", expiresAt: Date.now() + HOUR, selectedAt: Date.now(),
    };
    let answer: () => Promise<{ ok: true; text: string } | { ok: false; code: "expired"; message: string }> = async () => ({ ok: true, text: '{"kind":"reply","message":"Hello from the shared Director."}' });
    const calls: RelayShareMessage[][] = [];
    const director = new Director(mgr, db, hub, {} as Scheduler, {} as OperatorNotes);
    director.attachSharing({ selection: () => selection, call: async (m) => { calls.push(m); return answer(); } });
    const notes = (): string[] => db.listDirectorMessages(50).filter((m) => m.role === "director").sort((a, b) => b.createdAt - a.createdAt).map((m) => m.content);
    const settled = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 20));
      for (let i = 0; i < 200 && director.activeWorkCount() > 0; i++) await new Promise((r) => setTimeout(r, 5));
    };

    const status = director.status();
    check("the status names the donor before any turn", status?.provider === "shared" && status.shared?.donorName === "Kevin" && status.model === "gpt-test-mini", JSON.stringify(status));
    director.handleUserMessage("hi there");
    await settled();
    check("a turn on the shared Director completes", notes().includes("Hello from the shared Director."), JSON.stringify(notes()));
    check("the shared call carries the Director's own protocol (bootstrapped on this console)", calls[0]?.[0]?.content.includes("JSON") === true);

    answer = async () => ({ ok: false, code: "expired", message: "This shared Director expired at 2026-10-02T13:00:00.000Z." });
    director.handleUserMessage("still there?");
    await settled();
    const last = notes()[0] ?? "";
    check("an expired share ends the turn with the donor's reason", /expired at 2026-10-02T13:00:00.000Z/.test(last) && /Nothing was sent to your own subscriptions/.test(last), last);
    check("no private subscription was used", privateRuns === 0);

    selection = null;
    check("dropping the pick returns the status to this console's own", director.status()?.provider !== "shared");
  }
} finally {
  for (const db of dbs) db.raw.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
process.exit(0);
