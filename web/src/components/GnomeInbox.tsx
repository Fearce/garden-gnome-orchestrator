import { useEffect, useRef, useState } from "react";
import type { Role } from "../types.js";
import { Markdown } from "./Markdown.js";

interface Address { threadId: string; role: Role }
interface Gnome extends Address { name: string; title: string; active: boolean; unread: number }
interface Letter {
  id: number; sender: Address | null; recipient: Address; senderName: string; recipientName: string;
  body: string; createdAt: number; readAt: number | null;
}
interface InboxPage { messages: Letter[]; unread: number; hasMore: boolean }
const keyOf = (address: Address) => `${address.threadId}::${address.role}`;

async function request<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => controller.abort(new Error(body === undefined ? "Inbox request timed out. Try again." : "Sending timed out. Your draft is preserved. Check the inbox before retrying.")), 15000);
  try {
    const response = await fetch(`/api/gnome-inbox/${path}`, {
      credentials: "same-origin", signal: controller.signal, method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404) throw new Error("Gnome inbox is waiting for server activation. Reload after the server is updated.");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Inbox request failed.");
    return result as T;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

/** Owner inspection never changes the recipient's read state. */
export function GnomeInbox() {
  const [directory, setDirectory] = useState<Gnome[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<InboxPage | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [receipt, setReceipt] = useState("");
  const selection = useRef(selectedKey);
  selection.current = selectedKey;
  const selected = directory.find(gnome => keyOf(gnome) === selectedKey);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const queryFor = (address: Address) => new URLSearchParams({ threadId: address.threadId, role: address.role }).toString();

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const list = await request<Gnome[]>("directory", controller.signal);
        if (controller.signal.aborted) return;
        setDirectory(list);
        setSelectedKey(current => list.some(item => keyOf(item) === current) ? current : list[0] ? keyOf(list[0]) : "");
        setError("");
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null); setDraft(""); setReceipt(""); setSendError(""); setLoadingOlder(false);
    if (!selectedKey) return () => controller.abort();
    const refresh = async () => {
      const address = selectedRef.current;
      if (!address) return;
      try {
        const next = await request<InboxPage>(`messages?${queryFor(address)}`, controller.signal);
        if (controller.signal.aborted) return;
        setPage(previous => {
          if (!previous || !previous.messages.length || !next.messages.length) return next;
          const first = next.messages[0]!.id;
          const older = previous.messages.filter(message => message.id < first);
          return { ...next, messages: [...older, ...next.messages], hasMore: older.length ? previous.hasMore : next.hasMore };
        });
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [selectedKey]);

  const loadOlder = async () => {
    if (!selected || !page?.messages.length || loadingOlder) return;
    const key = selectedKey;
    setLoadingOlder(true);
    try {
      const older = await request<InboxPage>(`messages?${queryFor(selected)}&before=${page.messages[0]!.id}`);
      if (selection.current !== key) return;
      setPage(current => current ? { ...current, hasMore: older.hasMore, messages: [...older.messages.filter(message => !current.messages.some(existing => existing.id === message.id)), ...current.messages] } : older);
    } catch (failure) { if (selection.current === key) setError((failure as Error).message); }
    finally { if (selection.current === key) setLoadingOlder(false); }
  };

  const send = async () => {
    if (!selected || !draft.trim() || sending) return;
    const key = selectedKey;
    const recipient = { threadId: selected.threadId, role: selected.role };
    setSending(true); setSendError(""); setReceipt("");
    try {
      const letter = await request<Letter>("messages", undefined, { recipient, body: draft.trim() });
      if (selection.current === key) {
        setDraft(""); setReceipt(`Queued for ${letter.recipientName}. They’ll see it when they read their inbox.`);
        setPage(current => current ? { ...current, unread: current.unread + 1, messages: [...current.messages.filter(message => message.id !== letter.id), letter] } : { messages: [letter], unread: 1, hasMore: false });
      }
    } catch (failure) { if (selection.current === key) setSendError((failure as Error).message); }
    finally { setSending(false); }
  };

  const filtered = directory.filter(gnome => `${gnome.name} ${gnome.title} ${gnome.role}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="gnome-inbox" aria-label="Direct gnome inbox">
    <p className="gnome-inbox-note">Quiet messages wait in each gnome’s inbox. They never interrupt or wake an agent. Viewing here leaves their unread mail intact. Local gnomes only.</p>
    {sendError || error ? <p role="alert" className="gnome-inbox-error">{sendError || error}</p> : null}
    <div className="gnome-inbox-layout">
      <aside className="gnome-inbox-directory">
        <input aria-label="Find a gnome" placeholder="Find a gnome or task…" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="gnome-inbox-people" role="group" aria-label="Gnome inboxes">
          {filtered.map(gnome => <button key={keyOf(gnome)} className={selectedKey === keyOf(gnome) ? "selected" : ""} aria-pressed={selectedKey === keyOf(gnome)} onClick={() => setSelectedKey(keyOf(gnome))}>
            <strong>{gnome.name} {gnome.unread ? <span className="gnome-inbox-count">{gnome.unread} unread</span> : null}</strong>
            <span>{gnome.role} · {gnome.active ? "Working" : "Away"}</span><span>{gnome.title}</span>
          </button>)}
          {!filtered.length ? <p>{directory.length ? "No matching gnomes." : "No local gnomes yet. They appear after their first run."}</p> : null}
        </div>
      </aside>
      <div className="gnome-inbox-conversation">
        {selected ? <>
          <h3>{selected.name}’s inbox <small>{page?.unread ?? selected.unread} unread</small></h3>
          <div className="gnome-inbox-letters" aria-label="Direct messages">
            {page?.hasMore ? <button className="btn sm" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Earlier messages"}</button> : null}
            {page ? page.messages.length ? page.messages.map(letter => <article className="gnome-inbox-letter" key={letter.id}>
              <div><strong>{letter.senderName} → {letter.recipientName}</strong><time dateTime={new Date(letter.createdAt).toISOString()}>{new Date(letter.createdAt).toLocaleString()}</time></div>
              <Markdown text={letter.body} />
              <small>{letter.readAt ? "Read by recipient" : "Unread by recipient"}</small>
            </article>) : <p>No direct messages yet.</p> : <p role="status">Loading messages…</p>}
          </div>
          <form className="office-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
            <textarea aria-label={`Message ${selected.name}`} placeholder={`Quiet message to ${selected.name}…`} value={draft} maxLength={2000} disabled={sending} onChange={event => setDraft(event.target.value)} />
            <button className="btn primary sm" type="submit" disabled={sending || !draft.trim()}>{sending ? "Sending…" : "Send quietly"}</button>
          </form>
          {receipt ? <p className="gnome-inbox-receipt" role="status">{receipt}</p> : null}
        </> : <p>Select a gnome to inspect their inbox or send a message.</p>}
      </div>
    </div>
  </section>;
}
