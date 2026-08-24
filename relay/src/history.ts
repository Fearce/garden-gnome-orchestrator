import { JsonFile } from "./jsonFile.js";
import { ROOM_HISTORY } from "./protocol.js";
import type { RelayChat } from "./protocol.js";
import type { RoomHistory } from "./core.js";

/** How many rooms keep a backlog before the least-recently-active ones are dropped. A room is one
 *  repository two people happened to share, so this grows with repos-ever-collaborated-on, not with
 *  traffic — the cap only exists so an abandoned relay can't grow without bound. */
const MAX_ROOMS = 200;

/**
 * The relay's room backlogs, kept on disk so a container restart doesn't erase the context an agent
 * reads when it enters a repo room. Bounded twice over — `ROOM_HISTORY` lines per room and `MAX_ROOMS`
 * rooms — so the state file stays a few hundred KB no matter how long the office runs.
 */
export class PersistedHistory implements RoomHistory {
  private readonly rooms: Map<string, RelayChat[]>;
  private readonly file: JsonFile<Record<string, RelayChat[]>>;

  constructor(path: string) {
    this.file = new JsonFile<Record<string, RelayChat[]>>(path);
    this.rooms = new Map(Object.entries(this.file.read({})).map(([room, msgs]) => [room, msgs.slice(-ROOM_HISTORY)]));
  }

  push(room: string, msg: RelayChat): void {
    const list = this.rooms.get(room) ?? [];
    list.push(msg);
    if (list.length > ROOM_HISTORY) list.splice(0, list.length - ROOM_HISTORY);
    this.rooms.set(room, list);
    this.evictColdRooms();
    this.file.save(Object.fromEntries(this.rooms));
  }

  recent(room: string): RelayChat[] {
    return [...(this.rooms.get(room) ?? [])];
  }

  /** Rooms that have seen traffic, most-recently-active first — the status page's activity list. */
  activeRooms(): { room: string; messages: number; lastAt: number; label: string }[] {
    return [...this.rooms.entries()]
      .map(([room, msgs]) => ({
        room,
        messages: msgs.length,
        lastAt: msgs[msgs.length - 1]?.at ?? 0,
        label: msgs[msgs.length - 1]?.repoLabel || room.replace(/^repo:/, ""),
      }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  flush(): void {
    this.file.flush();
  }

  private evictColdRooms(): void {
    if (this.rooms.size <= MAX_ROOMS) return;
    const cold = [...this.rooms.entries()]
      .sort((a, b) => (a[1][a[1].length - 1]?.at ?? 0) - (b[1][b[1].length - 1]?.at ?? 0))
      .slice(0, this.rooms.size - MAX_ROOMS);
    for (const [room] of cold) this.rooms.delete(room);
  }
}
