import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { JsonFile } from "./jsonFile.js";

/** One orchestrator instance that has joined the office. The raw token is shown exactly once, at join;
 *  only its hash is stored, so a leaked state file can't be replayed as a login. */
export interface Member {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

/** What the owner sees on the admin page — the same row minus the secret. */
export type MemberView = Omit<Member, "tokenHash">;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Constant-time compare of two hex digests, so a token check can't be narrowed by timing. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The relay's membership: a join code buys a durable per-instance device token, and using the token
 * slides its expiry forward. That is the whole authentication story on purpose — the owner asked not to
 * re-authenticate more than "every once in a while", and an instance that talks to the office daily
 * therefore never re-authenticates at all, while one that goes quiet for a full TTL has to be re-invited.
 */
export class MemberStore {
  private members: Member[];
  private readonly file: JsonFile<Member[]>;

  constructor(
    path: string,
    private readonly ttlMs: number,
  ) {
    this.file = new JsonFile<Member[]>(path);
    this.members = this.file.read([]).filter((m) => m && typeof m.tokenHash === "string");
  }

  /** Exchange a validated join code for a fresh instance identity + token. The token is returned raw
   *  here and never again. */
  join(name: string): { member: Member; token: string } {
    const token = randomBytes(32).toString("base64url");
    const member: Member = {
      id: randomBytes(8).toString("hex"),
      name: name.trim().slice(0, 40) || "an orchestrator",
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.members.push(member);
    this.persist();
    return { member, token };
  }

  /** Resolve a bearer token to its member, sliding the expiry forward. Returns null for an unknown,
   *  revoked or lapsed token — the caller answers 401 and the client shows "re-join in Settings". */
  verify(token: string): Member | null {
    if (!token) return null;
    const hash = sha256(token);
    const member = this.members.find((m) => sameHash(m.tokenHash, hash));
    if (!member) return null;
    if (member.expiresAt <= Date.now()) return null;
    member.lastSeenAt = Date.now();
    member.expiresAt = Date.now() + this.ttlMs;
    this.persist();
    return member;
  }

  /** Rename an instance without re-issuing its token — the client sends its name on every connect, so
   *  changing it in Settings takes effect on the next reconnect. */
  rename(id: string, name: string): void {
    const member = this.members.find((m) => m.id === id);
    const clean = name.trim().slice(0, 40);
    if (!member || !clean || member.name === clean) return;
    member.name = clean;
    this.persist();
  }

  remove(id: string): boolean {
    const before = this.members.length;
    this.members = this.members.filter((m) => m.id !== id);
    if (this.members.length === before) return false;
    this.persist();
    return true;
  }

  list(): MemberView[] {
    return this.members.map(({ tokenHash: _hash, ...view }) => view);
  }

  flush(): void {
    this.file.flush();
  }

  private persist(): void {
    this.file.save(this.members);
  }
}
