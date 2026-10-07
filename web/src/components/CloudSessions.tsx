import { useEffect, useRef, useState } from "react";
import { apiUrl } from "../lib/base.js";
import type { Thread } from "../types.js";
import "./cloudSessions.css";

interface Connection { id: string; label: string; repository: string; routineId: string; configured: boolean }
interface Job { id: string; title: string; label: string; repository: string; createdAt: number; state: string; url: string | null; error: string | null; sourceThreadId: string | null }
interface Snapshot { connections: Connection[]; jobs: Job[]; routinePrompt: string }
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/api/cloud-sessions${path}`), {
    method, headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Cloud request failed.");
  return data as T;
}

export function CloudSessions({ active = true, source }: { active?: boolean; source?: Thread }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ id: "", label: "", repository: "", routineId: "", token: "" });
  const [connectionId, setConnectionId] = useState("");
  const [title, setTitle] = useState(source?.title ?? "");
  const [prompt, setPrompt] = useState(source?.brief || source?.rawPrompt || "");
  const [cloudReady, setCloudReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [method, setMethod] = useState("session");
  const [repository, setRepository] = useState("");
  const setup = useRef<HTMLDetailsElement>(null);
  const edited = useRef({ title: false, prompt: false });
  useEffect(() => {
    // Detail snapshots hydrate after the card opens. Fill arriving context without overwriting edits.
    if (!edited.current.title && source?.title) setTitle(source.title);
    if (!edited.current.prompt && (source?.brief || source?.rawPrompt)) setPrompt(source.brief || source.rawPrompt || "");
  }, [source?.title, source?.brief, source?.rawPrompt]);
  const reload = async () => {
    const next = await request<Snapshot>("");
    setSnapshot(next);
    setConnectionId(id => next.connections.some(c => c.id === id) ? id : next.connections[0]?.id ?? "");
  };
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    request<Snapshot>("").then(next => {
      if (disposed) return;
      setSnapshot(next);
      setConnectionId(id => id || next.connections[0]?.id || "");
    }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [active]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Cloud request failed."); }
    finally { try { await reload(); } catch { /* retain the action's error */ } setBusy(false); }
  };
  const linked = snapshot?.jobs.filter(j => !source || j.sourceThreadId === source.id) ?? [];
  const alreadySent = source && linked.some(j => j.state !== "failed");
  const selectedRepository = repository || snapshot?.connections.find(c => c.id === connectionId)?.repository || "";
  const sessionPrompt = `Task: ${title}\nRepository: ${selectedRepository}\n\n${prompt}\n\nWork only in the selected repository and cloud environment. Follow project instructions and run relevant checks. For changes, use a new branch and a pull request for review. Never merge, deploy, or force-push. Stop if local machine access or unavailable credentials are needed.`;
  const sessionUrl = new URL("https://claude.ai/code");
  sessionUrl.searchParams.set("repositories", selectedRepository);
  sessionUrl.searchParams.set("prompt", sessionPrompt);
  const longPrompt = sessionUrl.href.length > 8000;
  if (longPrompt) sessionUrl.searchParams.delete("prompt");
  const sessionReady = cloudReady && !!title.trim() && !!prompt.trim() && /^[\w.-]+\/[\w.-]+$/.test(selectedRepository);
  return <div className="cloud-sessions">
    <p>Send repository work to Claude on Anthropic’s cloud. Good fits include documentation, code reviews, tests, and fixes that run in a Linux checkout.</p>
    <p>Promotional cloud session credits apply to sessions you start in Claude Code. <strong>Routines are excluded from this promotion and spend regular subscription usage.</strong> After eligible credits expire or run out, regular plan usage applies. Routine tokens cannot read this balance. Subscription usage chips show cloud dollars when a matching profile token is configured. GGO cannot enforce a credits-only limit. Check <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">Claude usage</a> before starting jobs.</p>
    <p>Jobs keep running when this PC is off. Monitor, steer, stop, and review them using their Claude session links. GGO records submission, not completion; cloud output does not stream into the local task feed.</p>
    {source && <p className="cloud-note">The original task stays paused. {method === "routine" ? "Cloud uses the routine’s configured branch, repositories, and environment." : "Choose the repository, branch, model and environment in Claude before starting the session."} Push needed commits first; local files, attachments, memory, services, and pending changes are not sent. Review the cloud result before resuming locally.</p>}
    {error && <p role="alert" className="cloud-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!snapshot && <button className="btn ghost sm" disabled={busy} onClick={() => void act(reload)}>Load cloud connections</button>}
    <label>Dispatch method<select value={method} onChange={e => { setMethod(e.target.value); setCloudReady(false); }}><option value="session">Cloud session — promotional credits eligible</option><option value="routine">Routine API — regular usage, no promotional credits</option></select></label>
    {method === "routine" && <details className="cloud-setup" ref={setup} open={!snapshot?.connections.length}>
      <summary>Connect a Claude routine (regular usage)</summary>
      <ol>
        <li>At <a href="https://claude.ai/code/routines" target="_blank" rel="noreferrer">Claude routines</a>, create a routine. Attach one GitHub repository and configure its cloud environment. Use an API trigger. This path does not use promotional cloud session credits.</li>
        <li>Use these saved instructions so the routine executes the submitted brief: <pre>{snapshot?.routinePrompt || "Loading routine instructions…"}</pre></li>
        <li>Save the routine, generate its API trigger token, and enter its fire URL and token below. No recurring schedule is needed.</li>
      </ol>
      <form onSubmit={e => { e.preventDefault(); void act(async () => {
        const saved = await request<Connection>("/connections", "PUT", { ...draft, id: draft.id || undefined });
        setDraft({ id: "", label: "", repository: "", routineId: "", token: "" }); setConnectionId(saved.id); setNotice("Cloud routine saved. No job was started.");
      }); }}>
        <label>Connection label (include the Claude account)<input required maxLength={100} value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} placeholder="Cloud account · web app" /></label>
        <label>GitHub repository<input required maxLength={200} value={draft.repository} onChange={e => setDraft({ ...draft, repository: e.target.value })} placeholder="owner/repository" /></label>
        <label>Routine fire URL or ID<input required maxLength={300} value={draft.routineId} onChange={e => setDraft({ ...draft, routineId: e.target.value })} placeholder="trig_…" /></label>
        <label>Routine token<input type="password" autoComplete="new-password" required={!draft.id} maxLength={1000} value={draft.token} onChange={e => setDraft({ ...draft, token: e.target.value })} placeholder={draft.id ? "Leave blank to keep the saved token" : "Paste the API trigger token"} /></label>
        <div className="cloud-actions"><button className="btn primary sm" disabled={busy}>{draft.id ? "Save connection" : "Add connection"}</button>{draft.id && <button type="button" className="btn ghost sm" onClick={() => setDraft({ id: "", label: "", repository: "", routineId: "", token: "" })}>Cancel edit</button>}</div>
      </form>
    </details>}
    {method === "routine" && (snapshot?.connections ?? []).map(c => <div className="cloud-connection" key={c.id}>
      <span><strong>{c.label}</strong><br />{c.repository}</span>
      <div className="cloud-actions"><button className="btn ghost sm" disabled={busy} onClick={() => { setDraft({ ...c, token: "" }); if (setup.current) setup.current.open = true; }}>Edit</button><button className="btn ghost sm" disabled={busy} onClick={() => void act(async () => { await request(`/connections/${c.id}`, "DELETE"); })}>Disconnect</button></div>
    </div>)}
    <form className="cloud-launch" onSubmit={e => { e.preventDefault(); void act(async () => {
      if (method !== "routine") return;
      await request<Job>("/jobs", "POST", { connectionId, title, prompt, cloudReady, ...(source ? { sourceThreadId: source.id } : {}) });
      setCloudReady(false); setNotice("Submitted to Claude cloud. Open the session below to monitor and review it.");
    }); }}>
      <h4>Start a cloud task</h4>
      {method === "routine" ? <label>Cloud routine<select value={connectionId} onChange={e => setConnectionId(e.target.value)} required><option value="">Choose a connection</option>{snapshot?.connections.map(c => <option key={c.id} value={c.id}>{c.label} · {c.repository}</option>)}</select></label> : <label>Cloud session repository<input required maxLength={200} value={selectedRepository} onChange={e => setRepository(e.target.value)} placeholder="owner/repository" /></label>}
      <label>Task title<input aria-label="Task title" required maxLength={200} value={title} onChange={e => { edited.current.title = true; setTitle(e.target.value); }} /></label>
      <label>Task brief<textarea aria-label="Task brief" required rows={6} maxLength={60000} value={prompt} onChange={e => { edited.current.prompt = true; setPrompt(e.target.value); }} /></label>
      <label className="cloud-confirm"><input type="checkbox" checked={cloudReady} onChange={e => setCloudReady(e.target.checked)} />This work needs only the connected repository and cloud environment, with no local machine access.</label>
      {method === "routine" ? <><p>Routine runs spend regular usage. Promotional cloud session credits do not apply.</p><button className="btn primary sm" disabled={busy || !connectionId || !cloudReady || !!alreadySent}>{busy ? "Working…" : "Start in Claude cloud"}</button></> : <>
        <p>Sign into the Claude account holding the credits, review the repository, branch, model and environment, then start the task in Claude. Opening this form does not submit a job or create a GGO submission record. Keep its session link in Claude. The original local task stays paused.</p>
        <p>The prefilled brief is included in the browser URL and may remain in browser history. Only the editable brief is shared.</p>
        {longPrompt && <p>This brief is too long for a prefilled URL. Copy it, open Claude, and paste it before starting.</p>}
        <div className="cloud-actions"><button type="button" className="btn ghost sm" disabled={!sessionReady || busy} onClick={() => void act(async () => { await navigator.clipboard.writeText(sessionPrompt); setNotice("Cloud brief copied. Paste it into Claude if needed, then start the session there."); })}>Copy cloud brief</button>{sessionReady ? <a className="btn primary sm" href={sessionUrl.href} target="_blank" rel="noreferrer">Open credit-eligible cloud session</a> : <span>Enter the repository and brief, then confirm cloud suitability to open Claude.</span>}</div>
      </>}
      {alreadySent && <p>A routine submission already exists. Check it before starting more work.</p>}
    </form>
    <h4>Routine API submissions (regular usage)</h4>
    {!linked.length && <p>No routine tasks submitted yet.</p>}
    {linked.map(j => <article className="cloud-job" key={j.id}>
      <strong>{j.title}</strong><span>{j.label} · {j.repository}</span><span>{new Date(j.createdAt).toLocaleString()} · {j.state === "submitted" ? "Submitted — completion checked in Claude" : j.state}</span>
      {j.url && <a href={j.url} target="_blank" rel="noreferrer">Open Claude session</a>}{j.error && <p className="cloud-error">{j.error}</p>}
    </article>)}
  </div>;
}
