import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import { ROLES, type Role } from "../types.js";

export interface GnomeAddress { threadId: string; role: Role }
export interface DirectMessage {
  id: number;
  sender: GnomeAddress | null;
  recipient: GnomeAddress;
  senderName: string;
  recipientName: string;
  body: string;
  createdAt: number;
  readAt: number | null;
}

/** Deliberately has no runner, event hub, or steering dependency. Sending only persists a letter. */
export class DirectMessages {
  constructor(private readonly db: Db, private readonly nameOf: (threadId: string, role: Role) => string) {
    db.raw.exec(`CREATE TABLE IF NOT EXISTS gnome_direct_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_thread TEXT, sender_role TEXT,
      recipient_thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      recipient_role TEXT NOT NULL,
      sender_name TEXT NOT NULL, recipient_name TEXT NOT NULL,
      body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS gnome_dm_recipient ON gnome_direct_messages(recipient_thread, recipient_role, id);
    CREATE INDEX IF NOT EXISTS gnome_dm_sender ON gnome_direct_messages(sender_thread, sender_role, id);`);
  }

  private validate(address: GnomeAddress): void {
    if (!address || !ROLES.includes(address.role) || address.role === "director" || this.db.threadState(address.threadId) === null) {
      throw new Error("Unknown local gnome. Use a threadId and role from the local directory.");
    }
  }

  send(sender: GnomeAddress | null, recipient: GnomeAddress, body: string): DirectMessage {
    if (sender) this.validate(sender);
    this.validate(recipient);
    const text = body.trim();
    if (!text || text.length > 2000) throw new Error("Messages must contain 1–2000 characters.");
    const senderName = sender ? this.nameOf(sender.threadId, sender.role) : "Owner";
    const recipientName = this.nameOf(recipient.threadId, recipient.role);
    const createdAt = Date.now();
    const result = this.db.raw.prepare(`INSERT INTO gnome_direct_messages
      (sender_thread,sender_role,recipient_thread,recipient_role,sender_name,recipient_name,body,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(sender?.threadId ?? null, sender?.role ?? null, recipient.threadId, recipient.role, senderName, recipientName, text, createdAt);
    return { id: Number(result.lastInsertRowid), sender, recipient, senderName, recipientName, body: text, createdAt, readAt: null };
  }

  list(address: GnomeAddress, before?: number): { messages: DirectMessage[]; unread: number; hasMore: boolean } {
    this.validate(address);
    const rows = this.db.raw.prepare(`SELECT * FROM gnome_direct_messages WHERE
      ((recipient_thread=? AND recipient_role=?) OR (sender_thread=? AND sender_role=?))
      AND id < ? ORDER BY id DESC LIMIT 101`).all(address.threadId, address.role, address.threadId, address.role, before ?? Number.MAX_SAFE_INTEGER) as Record<string, unknown>[];
    return { messages: rows.slice(0, 100).reverse().map(row => ({
      id: Number(row.id), sender: row.sender_thread ? { threadId: String(row.sender_thread), role: row.sender_role as Role } : null,
      recipient: { threadId: String(row.recipient_thread), role: row.recipient_role as Role },
      senderName: String(row.sender_name), recipientName: String(row.recipient_name), body: String(row.body),
      createdAt: Number(row.created_at), readAt: row.read_at == null ? null : Number(row.read_at),
    })), unread: this.unread(address), hasMore: rows.length > 100 };
  }

  unreadCounts(): Map<string, number> {
    const rows = this.db.raw.prepare(`SELECT recipient_thread, recipient_role, count(*) AS n
      FROM gnome_direct_messages WHERE read_at IS NULL GROUP BY recipient_thread, recipient_role`).all() as { recipient_thread: string; recipient_role: string; n: number }[];
    return new Map(rows.map(row => [`${row.recipient_thread}::${row.recipient_role}`, row.n]));
  }

  /** Bounded incoming preview for an already scheduled turn; never marks mail read. */
  unreadPreview(address: GnomeAddress): Array<{ id: number; senderName: string; body: string }> {
    this.validate(address);
    return (this.db.raw.prepare(`SELECT id, sender_name, body FROM gnome_direct_messages
      WHERE recipient_thread=? AND recipient_role=? AND read_at IS NULL
      ORDER BY id LIMIT 20`).all(address.threadId, address.role) as { id: number; sender_name: string; body: string }[])
      .map(row => ({ id: row.id, senderName: row.sender_name, body: row.body }));
  }

  unread(address: GnomeAddress): number {
    return (this.db.raw.prepare(`SELECT count(*) AS n FROM gnome_direct_messages
      WHERE recipient_thread=? AND recipient_role=? AND read_at IS NULL`).get(address.threadId, address.role) as { n: number }).n;
  }

  acknowledge(address: GnomeAddress, throughId: number): number {
    this.validate(address);
    if (!Number.isSafeInteger(throughId) || throughId < 1) throw new Error("A positive message id is required.");
    return this.db.raw.prepare(`UPDATE gnome_direct_messages SET read_at=?
      WHERE recipient_thread=? AND recipient_role=? AND id<=? AND read_at IS NULL`).run(Date.now(), address.threadId, address.role, throughId).changes;
  }

  capability(address: GnomeAddress): string {
    this.validate(address);
    const key = `gnome_inbox_token:${address.threadId}:${address.role}`;
    const existing = this.db.kvGet(key);
    if (existing && this.identify(existing)) return existing;
    const token = randomUUID() + randomUUID();
    this.db.kvSet(`gnome_inbox_cap:${this.hash(token)}`, JSON.stringify(address));
    this.db.kvSet(key, token);
    return token;
  }

  identify(token: string): GnomeAddress | null {
    if (!token || token.length > 100) return null;
    const stored = this.db.kvGet(`gnome_inbox_cap:${this.hash(token)}`);
    if (!stored) return null;
    try { const address = JSON.parse(stored) as GnomeAddress; this.validate(address); return address; }
    catch { return null; }
  }

  private hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
}
