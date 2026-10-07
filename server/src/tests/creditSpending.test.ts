/** Prepaid fallback admission, provider billing reads, and runner cap behavior; no paid requests. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "credit-spending-"));
process.env.DATA_DIR = dir;
process.env.CODEX_HOME_DIR = join(dir, "codex");
process.env.CODEX_SOURCE_HOME = join(dir, "source");
const { parsePrepaidCredits, prepaidCreditsReady, fetchPrepaidCredits } = await import("../accounts/prepaidCredits.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { EventHub } = await import("../events.js");
const { AgentRun } = await import("../agents/runner.js");
const { Db } = await import("../db/db.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { noteCodexPing } = await import("../agents/codexUsage.js");
const { clientCommandSchema } = await import("../ws/protocol.js");
const now = Date.now(), reset = now + 3600000;
const funds = parsePrepaidCredits({ amount: 25000, currency: "USD", auto_reload_settings: { enabled: false } }, true)!;
assert.equal(funds.balance, 250);
assert.equal(prepaidCreditsReady(funds), true);
for (const bad of [null, {}, { amount: 1, currency: "USD" }, { amount: Infinity, currency: "USD", auto_reload_settings: {enabled:false} }]) assert.equal(parsePrepaidCredits(bad, true), null);
for (const bad of [{...funds,balance:0}, {...funds,autoReload:true}, {...funds,enabled:false}, {...funds,readAt:now-1200001}, {...funds,readAt:now+10000}]) assert.equal(prepaidCreditsReady(bad, now), false);
assert(clientCommandSchema.safeParse({type:"settings.set",settings:{allowCreditSpending:{codex:true,acct1:false}}}).success);
assert(!clientCommandSchema.safeParse({type:"settings.set",settings:{allowCreditSpending:{codex:"yes"}}}).success);
const accounts = [{id:"acct1",label:"Claude A",token:"test-a"},{id:"acct2",label:"Claude B",token:"test-b"}];
const saved = new Map();
const hub = new EventHub();
const manager = new AccountManager(accounts, hub, 600000, {persist:{load:(id)=>saved.get(id)??null,save:(id,value)=>saved.set(id,value)}});
const a = manager as any;
for (const st of a.states.values()) Object.assign(st,{fiveHour:100,sevenDay:100,fiveHourReset:reset,sevenDayReset:reset,usageAt:now});
a.prepaidCredits.set("acct1",funds);
assert.equal(manager.hasHeadroom(), false); // default off
let otherIncluded = true;
manager.setCreditSpending({acct1:true},()=>!otherIncluded);
assert.equal(manager.hasHeadroom(), false); // other subscription before money
otherIncluded = false;
assert.equal(manager.hasHeadroom(), true);
manager.setTokenSafetyLimit(90);
assert.equal(manager.select().account.id, "acct1");
assert.equal(manager.capacityOptions({label:"work",expectedDurationMs:60000,expectedBurnPct:1,reservePct:0,substantial:false})[0]?.hasHeadroom,true);
assert.equal(manager.creditFallbackForToken("test-a"),true);
manager.updateFromRateLimit("acct1",{status:"rejected",rateLimitType:"overage",resetsAt:reset});
assert.equal(manager.hasHeadroom(),false); // real prepaid rejection is held
const restored = new AccountManager(accounts, hub, 600000, {persist:{load:(id)=>saved.get(id)??null,save:()=>{}}});
for(const st of (restored as any).states.values()) Object.assign(st,{fiveHour:100,sevenDay:100,fiveHourReset:reset,sevenDayReset:reset});
(restored as any).prepaidCredits.set("acct1",funds);restored.setCreditSpending({acct1:true},()=>true);
assert.equal(restored.hasHeadroom(),false); // cooldown survives restart
// A request that is covered by overage must not masquerade as a usage rejection.
for (const enabled of [false,true]) {
 const run = new AgentRun({model:"claude-opus-5-5",cwd:dir,allowCredits:enabled});
 (run as any).handle({type:"rate_limit_event",rate_limit_info:{status:"rejected",overageStatus:"allowed",rateLimitType:"seven_day"}});
 assert.equal(run.rateLimited,!enabled);
}
const rejected = new AgentRun({model:"claude-opus-5-5",cwd:dir,allowCredits:true});
(rejected as any).handle({type:"rate_limit_event",rate_limit_info:{status:"rejected",overageStatus:"rejected"}});
assert.equal(rejected.rateLimited,true);
// Read-only billing calls, matching org, and unknown/mismatched auto-reload fail closed.
const originalFetch=globalThis.fetch;const calls:string[]=[];
try {
 globalThis.fetch = (async (url,opts) => {
  if (String(url).endsWith("/v1/messages")) {
   assert.equal(opts?.method,"POST");calls.push(String(url));
   return new Response("{}",{status:429});
  }
  assert.equal(opts?.method??"GET","GET");calls.push(String(url));
  return new Response(JSON.stringify(String(url).endsWith("/profile")?{organization:{uuid:"org-test"}}:
    String(url).endsWith("/credits")?{amount:25000,currency:"USD",auto_reload_settings:{enabled:false}}:{extra_usage:{is_enabled:true}}));
 }) as typeof fetch;
 assert.equal((await fetchPrepaidCredits("test-token","org-test"))?.balance,250);
 assert.equal(calls.length,3);
 calls.length=0;
 assert.equal(await fetchPrepaidCredits("test-token","wrong-org"),null);
 assert.equal(calls.length,1);
 // Exhausted meters: a routine ping is skipped only when usage credits are verified ON (it would be
 // billed); a banked-reset redemption still forces the read so refilled meters are seen.
 calls.length=0;
 const pingable = new AccountManager([{id:"p1",label:"P",token:"test-p"}], hub, 600000);
 const ps = (pingable as any).states.get("p1");
 Object.assign(ps,{fiveHour:100,sevenDay:50,fiveHourReset:reset,sevenDayReset:reset});
 await (pingable as any).pingOne(ps.account);
 assert.equal(calls.filter((u)=>u.endsWith("/v1/messages")).length,1); // credits not known on: free 429 read
 (pingable as any).prepaidCredits.set("p1",funds);calls.length=0;
 Object.assign(ps,{fiveHour:100,fiveHourReset:reset});
 await (pingable as any).pingOne(ps.account);
 assert.equal(calls.length,0);
 Object.assign(ps,{fiveHour:100,fiveHourReset:reset});
 await (pingable as any).pingOne(ps.account,false,false,true);
 assert.equal(calls.filter((u)=>u.endsWith("/v1/messages")).length,1);
 pingable.stop();
 // First boot has no persisted org: wait for the inference identity before reading prepaid funds.
 globalThis.fetch = (async (url) => {
  if (String(url).endsWith("/v1/messages")) {
   await new Promise((resolve) => setTimeout(resolve, 10));
   return new Response("{}", {headers:{"anthropic-ratelimit-unified-5h-utilization":"0",
    "anthropic-ratelimit-unified-7d-utilization":"0", "anthropic-organization-id":"org-test"}});
  }
  return new Response(JSON.stringify(String(url).endsWith("/profile")?{organization:{uuid:"org-test"}}:
   String(url).endsWith("/credits")?{amount:25000,currency:"USD",auto_reload_settings:{enabled:false}}:{extra_usage:{is_enabled:true}}));
 }) as typeof fetch;
 const fresh = new AccountManager([{id:"fresh",label:"Fresh account",token:"test-inference",profileToken:"test-profile"}],hub);
 try {
  await (fresh as any).bootPing();
  assert.equal(fresh.dto()[0]?.prepaidCredits?.balance,250);
 } finally {fresh.stop();}
} finally {globalThis.fetch=originalFetch;}
// Codex credited dispatch must pass the same capacity inventory that wakes parked tasks.
mkdirSync(process.env.CODEX_SOURCE_HOME!,{recursive:true});
writeFileSync(join(process.env.CODEX_SOURCE_HOME!,"auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{}}));
const db = new Db(join(dir,"test.sqlite"));
const threads = new ThreadManager(db,hub,new FileMemoryService(join(dir,"memory")),manager);
const t = threads as any;
t.grokImplementorReady=()=>false;t.zaiImplementorReady=()=>false;
try {
 assert.equal(threads.settings().allowCreditSpending.codex,false);
 threads.setSettings({codexEnabled:true,allowCreditSpending:{codex:true,acct1:true,unknown:true}});
 assert.equal(threads.settings().allowCreditSpending.unknown,undefined);
 noteCodexPing({fiveHour:100,sevenDay:100,fiveHourReset:reset,sevenDayReset:reset,planType:"pro",updatedAt:Date.now(),limitState:"reached",credits:{balance:55000,hasCredits:true,unlimited:false}});
 assert.equal(t.codexImplementorReady(),true);
 assert.equal(t.codexProviderCandidate().capacityLabel,"Codex prepaid credits");
 for (const creditAt of [Date.now()-1200001,Date.now()+10000,NaN]) {
  noteCodexPing({fiveHour:100,sevenDay:100,fiveHourReset:reset,sevenDayReset:reset,planType:"pro",updatedAt:Date.now(),creditsUpdatedAt:creditAt,limitState:"reached",credits:{balance:55000,hasCredits:true,unlimited:false}});
  assert.equal(t.codexCreditsReady(),false); // fresh meters cannot refresh stale or invalid funds
 }
 noteCodexPing({fiveHour:100,sevenDay:100,fiveHourReset:reset,sevenDayReset:reset,planType:"pro",updatedAt:Date.now(),limitState:"reached",credits:{balance:55000,hasCredits:true,unlimited:false}});
 t.noteCodexCap({status:"rejected",resetsAt:reset},undefined,false);
 assert.equal(t.codexCreditsReady(),true); // subscription-only rejection cannot strand prepaid funds
 t.noteCodexCap({status:"rejected",resetsAt:reset},undefined,true);
 assert.equal(t.codexCreditsReady(),false); // prepaid attempt refusal wins over positive balance
 db.kvSet("codex_credit_rejected_until", "0");
 assert(t.roleCapacitySnapshot("implementor",{label:"work",expectedDurationMs:60000,expectedBurnPct:1,reservePct:0,substantial:false}).ready.some((c:any)=>c.provider==="codex"));
 a.states.get("acct2").fiveHour=0;a.states.get("acct2").sevenDay=0;
 assert.equal(t.codexCreditsReady(),false); // included Claude ahead of Codex credits
 a.states.get("acct2").fiveHour=100;a.states.get("acct2").sevenDay=100;
 t.grokImplementorReady=()=>true;assert.equal(t.codexCreditsReady(),false);t.grokImplementorReady=()=>false;
 for(const credits of [{balance:0,hasCredits:false,unlimited:false},{balance:55000,hasCredits:true,unlimited:true}]) {
  noteCodexPing({fiveHour:100,sevenDay:100,fiveHourReset:reset,sevenDayReset:reset,planType:"pro",updatedAt:Date.now(),limitState:"reached",credits});
  assert.equal(t.codexCreditsReady(),false);
 }
 threads.setSettings({allowCreditSpending:{codex:false}});assert.equal(t.codexImplementorReady(),false);
 assert.equal(JSON.parse(db.kvGet("setting_allow_credit_spending")!).codex,false);
} finally {if(t.capSupervisor)clearInterval(t.capSupervisor);db.raw.close();manager.stop();restored.stop();}
console.log("credit spending: prepaid validation, read-only billing, fallback priority, persistence and cap recovery passed");
// ThreadManager owns unref'd background housekeeping; temp fixtures may stay locked on Windows.
try {rmSync(dir,{recursive:true,force:true});} catch {}
