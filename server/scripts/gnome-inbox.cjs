// A capability grants only this gnome's inbox. It cannot inject, steer, or dispatch tasks.
// Send JSON through stdin so message text never needs shell interpolation.
const fs = require("node:fs");
async function main() {
  const [base, token, action = "read", value] = process.argv.slice(2);
  if (!base || !token || !["read", "directory", "send", "ack"].includes(action)) {
    throw new Error("Usage: node gnome-inbox.cjs <base-url> <capability> [read|directory|send|ack] [before-id|through-id]. send reads {recipient:{threadId,role},body} from stdin.");
  }
  const url = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") throw new Error("Inbox URL must be local HTTP.");
  const suffix = action === "directory" ? "directory" : action === "ack" ? "ack" : "messages";
  const query = action === "read" && value ? `?before=${encodeURIComponent(value)}` : "";
  const body = action === "send" ? fs.readFileSync(0, "utf8") : action === "ack" ? JSON.stringify({ throughId: Number(value) }) : undefined;
  const response = await fetch(new URL(`/api/gnome-inbox/agent/${suffix}${query}`, url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Inbox HTTP ${response.status}`);
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
