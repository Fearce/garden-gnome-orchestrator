import { RELAY_PROTOCOL } from "./protocol.js";
import type { MemberView } from "./members.js";

/** A relay page is one small server-rendered document — no bundler, no client framework, no external
 *  fetch (the container has no egress and the page must render on a phone on the couch). */
interface StatusView {
  officeName: string;
  online: { instanceId: string; instanceName: string; agents: number; repos: string[]; since: number }[];
  shared: { repoKey: string; repoLabel: string; instances: string[] }[];
  members: MemberView[];
  rooms: { room: string; messages: number; lastAt: number; label: string }[];
  admin: boolean;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function ago(at: number): string {
  if (!at) return "never";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function inDays(at: number): string {
  const d = Math.round((at - Date.now()) / 86400000);
  return d <= 0 ? "expired" : `${d}d`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: oklch(98.5% 0.005 95);
  --panel: oklch(100% 0 0);
  --ink: oklch(24% 0.02 260);
  --muted: oklch(52% 0.02 260);
  --line: oklch(90% 0.008 260);
  --accent: oklch(52% 0.13 205);
  --live: oklch(58% 0.15 150);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(19% 0.015 260);
    --panel: oklch(23% 0.018 260);
    --ink: oklch(93% 0.01 260);
    --muted: oklch(66% 0.02 260);
    --line: oklch(31% 0.02 260);
    --accent: oklch(74% 0.11 205);
    --live: oklch(76% 0.15 150);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 48px 20px 72px;
  background: var(--bg); color: var(--ink);
  font: 15px/1.6 ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 760px; margin: 0 auto; }
h1 {
  font: 400 34px/1.15 ui-serif, Georgia, "Times New Roman", serif;
  letter-spacing: -0.015em; margin: 0 0 6px;
}
h2 {
  font: 500 12px/1 ui-sans-serif, sans-serif; letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--muted); margin: 40px 0 12px;
}
p.lede { margin: 0 0 32px; color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
.tile .n { font: 400 30px/1.1 ui-serif, Georgia, serif; letter-spacing: -0.02em; }
.tile .k { font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); margin-top: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; padding: 0 12px 8px 0; }
td { padding: 9px 12px 9px 0; border-top: 1px solid var(--line); vertical-align: top; }
td.dim, .dim { color: var(--muted); }
code, .mono { font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; font-size: 13px; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--live); margin-right: 8px; vertical-align: 1px; }
.empty { color: var(--muted); font-style: italic; }
footer { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
a { color: var(--accent); }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function tile(n: string | number, k: string): string {
  return `<div class="tile"><div class="n">${esc(String(n))}</div><div class="k">${esc(k)}</div></div>`;
}

/** The page anyone who guesses the hostname can see. It answers "is the office up?" and nothing else —
 *  no repository names, no task titles, no member names. Those are behind the admin key. */
export function publicPage(view: StatusView): string {
  const agents = view.online.reduce((n, o) => n + o.agents, 0);
  return page(
    view.officeName,
    `<h1>${esc(view.officeName)}</h1>
<p class="lede">A coordination relay for Claude&nbsp;Code orchestrators. Agents working the same repository on different
machines meet here so they don't edit the same files blind.</p>
<div class="tiles">
  ${tile(view.online.length, "instances online")}
  ${tile(agents, "agents working")}
  ${tile(view.shared.length, "shared repos")}
</div>
<h2>Joining</h2>
<p>In the orchestrator console open <strong>Settings → Online office</strong>, paste this relay's URL and the join code
the office owner gave you, and press Join. That is a one-time exchange for a device token — you won't be asked again.</p>
<footer>Relay protocol v${RELAY_PROTOCOL}. Nothing but presence and short coordination messages passes through here;
no repository contents, no credentials.</footer>`,
  );
}

/** The owner's view: who is joined, who is connected, what they're working on, and which tokens to revoke. */
export function adminPage(view: StatusView): string {
  const onlineRows = view.online.length
    ? view.online
        .map(
          (o) => `<tr>
<td><span class="dot"></span>${esc(o.instanceName)}</td>
<td>${o.agents}</td>
<td class="dim">${o.repos.length ? esc(o.repos.join(", ")) : "—"}</td>
<td class="dim">${esc(ago(o.since))}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Nobody is connected right now.</td></tr>`;

  const memberRows = view.members.length
    ? view.members
        .map(
          (m) => `<tr>
<td>${esc(m.name)}</td>
<td class="dim mono">${esc(m.id)}</td>
<td class="dim">${esc(ago(m.lastSeenAt))}</td>
<td class="dim">${esc(inDays(m.expiresAt))}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="empty">No instance has joined yet.</td></tr>`;

  const roomRows = view.rooms.length
    ? view.rooms
        .slice(0, 30)
        .map((r) => `<tr><td>${esc(r.label)}</td><td>${r.messages}</td><td class="dim">${esc(ago(r.lastAt))}</td></tr>`)
        .join("")
    : `<tr><td colspan="3" class="empty">No messages yet.</td></tr>`;

  return page(
    `${view.officeName} — admin`,
    `<h1>${esc(view.officeName)}</h1>
<p class="lede">Owner view. Revoke a device with
<code>DELETE /api/members/&lt;id&gt;</code> and the same admin key.</p>
<h2>Connected now</h2>
<table><thead><tr><th>Instance</th><th>Agents</th><th>Repos</th><th>Connected</th></tr></thead><tbody>${onlineRows}</tbody></table>
<h2>Joined instances</h2>
<table><thead><tr><th>Name</th><th>Id</th><th>Last seen</th><th>Token expires in</th></tr></thead><tbody>${memberRows}</tbody></table>
<h2>Rooms with traffic</h2>
<table><thead><tr><th>Repository</th><th>Messages kept</th><th>Last</th></tr></thead><tbody>${roomRows}</tbody></table>
<footer>Relay protocol v${RELAY_PROTOCOL}.</footer>`,
  );
}
