/**
 * Unit gate — the auto-select judgement starts on a parked Claude process instead of booting a CLI.
 *
 * Auto-select runs one structured Opus call before every unpinned task start. Booting its CLI took 7–16 s
 * of that on the loaded box; a spare the SDK warmed ahead of time (`prewarm()`) answers its claim in ~1 s
 * (measured 2026-10-10: 7.7–12.7 s warm against 18.8–21.7 s cold for the same judgement). The SDK fixes
 * host-level options at prewarm, so a spare may only serve a run with exactly the options it was warmed
 * with, and a claim it refuses never ran the prompt: the caller has to make the call again cold.
 *
 * Run: npm run test:warm-spares   (from server/)
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Options, SDKUserMessage, SpareProcess } from "@anthropic-ai/claude-agent-sdk";
import { AgentRun } from "../agents/runner.js";
import { claimNeverRan, WarmSpares } from "../agents/warmSpares.js";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Claim = Parameters<SpareProcess["claim"]>[0];
type FakeSpare = SpareProcess & { closed: boolean; claims: Claim[]; firstPrompt?: SDKUserMessage; exit(): void };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A spare that answers its claim with one structured result, or refuses it the way the SDK does. */
function fakeSpare(refusal?: string): FakeSpare {
  const claimed = deferred<{ cwd: string; sessionId: string; sdkMcpSettled: boolean }>();
  const exited = deferred<void>();
  claimed.promise.catch(() => {});
  const spare = {
    closed: false,
    claims: [] as Claim[],
    firstPrompt: undefined as SDKUserMessage | undefined,
    claimed: claimed.promise,
    exited: exited.promise,
    exit: () => exited.resolve(),
    close() {
      spare.closed = true;
      claimed.reject(new Error("spare_closed"));
      exited.resolve();
    },
    claim(params: Claim) {
      if (spare.closed) throw new Error("spare_closed");
      spare.claims.push(params);
      if (refusal) claimed.reject(new Error(refusal));
      else claimed.resolve({ cwd: params.options.cwd, sessionId: "spare-session", sdkMcpSettled: true });
      async function* answer(): AsyncGenerator<Record<string, unknown>> {
        if (typeof params.prompt !== "string") {
          for await (const message of params.prompt) {
            spare.firstPrompt = message;
            break;
          }
        }
        yield refusal
          ? { type: "result", subtype: "error_during_execution", is_error: true, result: `not_claimed: ${refusal}`, num_turns: 0 }
          : { type: "result", subtype: "success", is_error: false, result: "", structured_output: { model: "picked" }, num_turns: 1 };
      }
      return Object.assign(answer(), { interrupt: async () => {} });
    },
    [Symbol.asyncDispose]: async () => {},
  };
  return spare as unknown as FakeSpare;
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const options = (extra: Partial<Options> = {}): Options => ({
  model: "claude-opus-5-5",
  cwd: join(tmpdir(), "director-sandbox"),
  permissionMode: "plan",
  outputFormat: { type: "json_schema", schema: { type: "object" } },
  ...extra,
});

function pool(idleMs = 60_000): { spares: WarmSpares; made: FakeSpare[]; warmedWith: Options[] } {
  const made: FakeSpare[] = [];
  const warmedWith: Options[] = [];
  const spares = new WarmSpares(async (opts) => {
    warmedWith.push(opts);
    const spare = fakeSpare();
    made.push(spare);
    return spare;
  }, idleMs);
  return { spares, made, warmedWith };
}

async function poolBehaviour(): Promise<void> {
  console.log("\nThe spare pool\n");
  {
    const { spares, made, warmedWith } = pool();
    const first = await spares.take(options());
    check("the first call boots cold and warms a spare for the next", first === undefined && made.length === 1);
    check("the spare is warmed without the session folder", warmedWith[0]?.cwd === undefined && warmedWith[0]?.model === "claude-opus-5-5");
    await tick();
    const second = await spares.take(options());
    check("a call with the same host options gets that spare", second === made[0]);
    check("taking it warms the replacement", made.length === 2);
    const third = await spares.take(options({ cwd: join(tmpdir(), "another-folder") }));
    check("a different session folder is a claim option, not a miss", third === made[1]);
    spares.discard();
  }
  {
    const { spares, made } = pool();
    await spares.take(options());
    await tick();
    const other = await spares.take(options({ outputFormat: { type: "json_schema", schema: { type: "array" } } }));
    check("different host options miss", other === undefined);
    check("the mismatched parked spare is closed", made[0]?.closed === true && made.length === 2);
    spares.discard();
  }
  {
    const { spares, made } = pool();
    const resumed = await spares.take(options({ resume: "session-1" }));
    const withHooks = await spares.take(options({ hooks: {} }));
    check("resumes and runs with callbacks never use a spare, nor warm one", resumed === undefined && withHooks === undefined && made.length === 0);
  }
  {
    const { spares, made } = pool();
    await spares.take(options());
    await tick();
    made[0]!.exit();
    await tick();
    check("a spare that died is not handed out", (await spares.take(options())) === undefined);
    spares.discard();
  }
  {
    const { spares, made } = pool(20);
    await spares.take(options());
    await tick(60);
    check("an unclaimed spare is closed after its idle lifetime", made[0]?.closed === true);
    check("and is not handed out afterwards", (await spares.take(options())) === undefined);
    spares.discard();
  }
  {
    const { spares, made } = pool(20);
    await spares.take(options());
    await tick();
    const taken = await spares.take(options());
    await tick(60);
    check("a spare already handed out is not closed by its idle timer", taken === made[0] && made[0]?.closed === false);
    spares.discard();
  }
  {
    const pending = deferred<SpareProcess>();
    const spare = fakeSpare();
    let starts = 0;
    const spares = new WarmSpares(() => (starts++ === 0 ? pending.promise : Promise.resolve(fakeSpare())));
    await spares.take(options());
    const taking = spares.take(options());
    pending.resolve(spare);
    check("a spare still starting is awaited rather than booting cold beside it", (await taking) === spare);
    spares.discard();
  }
  {
    let starts = 0;
    const spares = new WarmSpares(() => (starts++ === 0 ? Promise.reject(new Error("prewarm unsupported")) : Promise.resolve(fakeSpare())));
    await spares.take(options());
    await tick();
    check("a failed prewarm boots the next call cold", (await spares.take(options())) === undefined);
    spares.discard();
  }
  {
    const pending = deferred<SpareProcess>();
    const spare = fakeSpare();
    const spares = new WarmSpares(() => pending.promise);
    await spares.take(options());
    spares.discard();
    pending.resolve(spare);
    await tick();
    check("discarding while a spare is still starting closes it once it is up", spare.closed);
  }
  {
    const spare = fakeSpare();
    const spares = new WarmSpares(() => Promise.resolve(spare));
    await spares.take(options());
    await tick();
    spares.discard();
    check("discarding a started spare closes it at once, as a process exit handler needs", spare.closed);
  }
  check("option_not_applied means the prompt already ran", !claimNeverRan(new Error("option_not_applied: model")));
  check("a refused or dead spare never ran the prompt", claimNeverRan(new Error("cwd_not_found")) && claimNeverRan(new Error("spare_exited")));
}

async function claimPath(): Promise<void> {
  console.log("\nAgentRun on a spare\n");
  // A folder that does not exist: should the run ever fall through to query(), the CLI cannot start a session.
  const cwd = join(tmpdir(), "warm-spares-gate-missing-folder");
  {
    const spare = fakeSpare();
    const agent = new AgentRun({ model: "claude-opus-5-5", cwd, permissionMode: "plan", outputFormat: { type: "json_schema", schema: { type: "object" } } });
    agent.start("pick a model", spare);
    const result = await agent.result();
    const claim = spare.claims[0]?.options;
    check("the run claims the spare with only the per-session options", claim?.cwd === cwd && claim?.model === "claude-opus-5-5" && claim?.permissionMode === "plan" && Object.keys(claim ?? {}).length === 3, JSON.stringify(claim));
    check("the first message reaches the spare", JSON.stringify(spare.firstPrompt?.message?.content) === JSON.stringify("pick a model"));
    check("the spare's structured answer is the run's result", JSON.stringify(result?.structuredOutput) === JSON.stringify({ model: "picked" }));
    check("a claimed spare reports that the prompt ran", (await agent.spareClaimNeverRan) === false);
    await agent.stop();
  }
  {
    const spare = fakeSpare("project_settings_not_claimable");
    const agent = new AgentRun({ model: "claude-opus-5-5", cwd, permissionMode: "plan" });
    agent.start("pick a model", spare);
    await agent.result();
    check("a refused claim tells the caller to run the call again cold", (await agent.spareClaimNeverRan) === true);
    await agent.stop();
  }
  {
    const agent = new AgentRun({ model: "claude-opus-5-5", cwd, permissionMode: "plan", outputFormat: { type: "json_schema", schema: { type: "object" } } });
    const opts = agent.queryOptions();
    check("queryOptions carries what a spare must be warmed with", opts.model === "claude-opus-5-5" && opts.cwd === cwd && opts.permissionMode === "plan" && !!opts.outputFormat && !!opts.env);
  }
}

async function main(): Promise<void> {
  await poolBehaviour();
  await claimPath();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
