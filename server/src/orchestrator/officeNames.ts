import { agentKey, type Role } from "../types.js";

export const OFFICE_NAME_MAX = 24;

/** A name another agent held this recently can't be picked again, so a name identifies one agent. */
export const NAME_REUSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** One agent's hold on a name, dated by the last moment it went by it. */
export interface NameUse {
  agentKey: string;
  name: string;
  lastUsedAt: number;
}

/** One live agent as the uniqueness pass sees it. */
export interface LiveAgentRef {
  threadId: string;
  role: Role;
  startedAt: number;
}

/** Normalise an agent's self-chosen name; "" when nothing usable is left. */
export function cleanOfficeName(raw: string): string {
  return raw
    .replace(/[`*_"]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, OFFICE_NAME_MAX)
    .trim();
}

/** The most recent OTHER agent that went by `name` (case-insensitively) inside the reuse window, or null
 *  when `selfKey` may take it. An agent re-picking its own name is never blocked by itself. */
export function recentNameHolder(name: string, selfKey: string, uses: readonly NameUse[], now: number): NameUse | null {
  const wanted = name.toLowerCase();
  const cutoff = now - NAME_REUSE_WINDOW_MS;
  let holder: NameUse | null = null;
  for (const u of uses) {
    if (u.agentKey === selfKey || u.name.toLowerCase() !== wanted || u.lastUsedAt < cutoff) continue;
    if (!holder || u.lastUsedAt > holder.lastUsedAt) holder = u;
  }
  return holder;
}

/** What an agent's pick came to: the name it now goes by, or a refusal it must answer with another pick. */
export type OfficeNameResult = { ok: true; name: string } | { ok: false; name: string; reason: string };

/** Why `name` was refused, phrased for the agent that has to pick again. */
export function nameReuseRefusal(name: string, holder: NameUse, now: number): string {
  const days = Math.floor((now - holder.lastUsedAt) / (24 * 60 * 60 * 1000));
  const when = days < 1 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  const windowDays = NAME_REUSE_WINDOW_MS / (24 * 60 * 60 * 1000);
  return `"${name}" is taken: another agent went by it ${when}, and a name stays reserved for ${windowDays} days after its last use. Invent a different, original name.`;
}

/** Drop released-name records that have aged out of the reuse window, so the ledger stays bounded. */
export function pruneNameUses(uses: readonly NameUse[], now: number): NameUse[] {
  const cutoff = now - NAME_REUSE_WINDOW_MS;
  return uses.filter((u) => u.lastUsedAt >= cutoff);
}

/** `preferred` if nobody in `taken` holds it (case-insensitively), else the first free "<name> 2", "<name> 3", … */
export function firstFreeName(preferred: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(preferred.toLowerCase())) return preferred;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${preferred.slice(0, OFFICE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

// The two halves of a generated name. 96 × 96 = 9,216 pairs: enough that a month of agents (the reuse
// window) cannot exhaust it, so a generated name never needs a numbered variant in practice.
const GIVEN = [
  "Acorn", "Alder", "Amber", "Aster", "Barley", "Basil", "Birch", "Bracken", "Bramble", "Brindle",
  "Bumble", "Burdock", "Button", "Cinder", "Clover", "Cobble", "Copper", "Cress", "Crumpet", "Dapple",
  "Dunnock", "Ember", "Fennel", "Fern", "Finch", "Flax", "Flint", "Foxglove", "Gorse", "Hazel",
  "Heather", "Hemlock", "Holly", "Hops", "Ivy", "Juniper", "Kestrel", "Lark", "Laurel", "Lichen",
  "Linden", "Linnet", "Loam", "Lupin", "Madder", "Mallow", "Maple", "Marjoram", "Medlar", "Millet",
  "Mint", "Moss", "Mugwort", "Nettle", "Nutmeg", "Oakum", "Ochre", "Parsnip", "Pebble", "Pewter",
  "Pip", "Plover", "Poppy", "Quince", "Radish", "Reed", "Robin", "Rowan", "Rue", "Russet",
  "Rye", "Saffron", "Sage", "Sedge", "Sloe", "Sorrel", "Speckle", "Spindle", "Starling", "Sumac",
  "Tallow", "Tansy", "Teasel", "Thimble", "Thistle", "Thyme", "Tinder", "Turnip", "Umber", "Vetch",
  "Walnut", "Willow", "Woad", "Wren", "Yarrow", "Yew",
] as const;
const FAMILY = [
  "Almanac", "Anvil", "Barrow", "Basket", "Bellows", "Bobbin", "Bristle", "Brook", "Bucket", "Burrow",
  "Candle", "Carter", "Chandler", "Chimney", "Cobbler", "Cobweb", "Combe", "Cooper", "Croft", "Dell",
  "Dewdrop", "Drummer", "Fen", "Fiddle", "Fletcher", "Ford", "Gable", "Hedge", "Hinge", "Hob",
  "Hollow", "Holt", "Hummock", "Inkwell", "Kettle", "Knoll", "Ladle", "Lantern", "Latch", "Ledger",
  "Mason", "Mead", "Miller", "Mitten", "Nook", "Oddment", "Pannier", "Piper", "Pocket", "Potter",
  "Puddle", "Quill", "Rafter", "Rake", "Riddle", "Satchel", "Sawyer", "Shingle", "Sickle", "Skein",
  "Spade", "Spoke", "Sprocket", "Stile", "Stitch", "Tanner", "Thatcher", "Thorpe", "Tinker", "Toggle",
  "Trowel", "Truckle", "Tuck", "Tumbler", "Turner", "Tussock", "Twine", "Wainwright", "Weaver", "Whistle",
  "Wick", "Wicket", "Wold", "Woodruff", "Yardley", "Bodkin", "Cask", "Dibber", "Firkin", "Gimlet",
  "Hamper", "Jigger", "Mallet", "Noggin", "Tankard", "Wimble",
] as const;

/** A stable 32-bit FNV-1a hash — the generated name must not depend on process or platform. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The name the orchestrator gives an agent the moment it is created, so no agent ever runs nameless: a
 * "Given Family" pair derived from its agentKey, so the same agent always starts from the same name.
 * Walks the pair space from that start until it finds one nobody in `taken` holds (case-insensitively).
 * The agent may still invent its own name later; this one is only what it goes by until then.
 */
export function generatedAgentName(key: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  const total = GIVEN.length * FAMILY.length;
  const start = hash32(key) % total;
  for (let step = 0; step < total; step++) {
    const i = (start + step * 97) % total; // 97 is coprime with 96², so the walk visits every pair once
    const name = `${GIVEN[Math.floor(i / FAMILY.length)]} ${FAMILY[i % FAMILY.length]}`;
    if (!lower.has(name.toLowerCase())) return name;
  }
  return firstFreeName(`${GIVEN[Math.floor(start / FAMILY.length)]} ${FAMILY[start % FAMILY.length]}`, taken);
}

/**
 * Re-derive name uniqueness across the live set: walking in seniority order (earliest start first) so
 * whoever has used a name longest keeps it, a later agent whose self-picked name is already held by a
 * live agent — or by one of its own task's other roles — gets a numbered variant. Agents that have not
 * named themselves yet are skipped. A numbered variant also steers clear of `reserved` (names other
 * agents held within the reuse window). Returns only the keys whose stored name must change.
 */
export function resolveLiveNameCollisions(
  live: readonly LiveAgentRef[],
  names: Readonly<Record<string, string>>,
  reserved: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const ordered = live
    .map((l) => ({ ...l, key: agentKey(l.threadId, l.role) }))
    .filter((l) => names[l.key])
    .sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
  const used = new Set<string>();
  const changes = new Map<string, string>();
  for (const l of ordered) {
    const taskMates = Object.entries(names)
      .filter(([k]) => k.startsWith(`${l.threadId}::`) && k !== l.key)
      .map(([, v]) => v);
    const own = names[l.key]!;
    const taken = new Set([...used, ...taskMates]);
    const chosen = firstFreeName(own, taken) === own ? own : firstFreeName(own, new Set([...taken, ...reserved]));
    used.add(chosen);
    if (chosen !== names[l.key]) changes.set(l.key, chosen);
  }
  return changes;
}
