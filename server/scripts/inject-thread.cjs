#!/usr/bin/env node
// Send a task injection by its exact UUID, never by a board-card title lookup.
//
// The normal console is the right interactive surface. This is the safer escape
// hatch for an operator/script that already has a task id: it reads the socket's
// authoritative hello first, prints the target it found, and refuses to mutate
// anything until --confirm is supplied. That avoids a substring card selector
// steering an identically-titled task.
//
//   node scripts/inject-thread.cjs --thread <uuid> --message "..." --confirm
//   node scripts/inject-thread.cjs --thread <uuid> --message "..." --mode queue --confirm
//
// AUTH_PASSWORD comes from the environment when supplied, otherwise server/.env.
// It is never printed. Override the local server with --url http://host:port.

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const DEFAULT_URL = "http://127.0.0.1:4317";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(["append", "interrupt", "queue"]);

function usage(error) {
  const text = [
    error ? `error: ${error}` : null,
    "usage: node scripts/inject-thread.cjs --thread <full-uuid> --message <text> [--mode append|interrupt|queue] [--url http://host:port] [--confirm]",
    "",
    "Without --confirm this only validates and prints the exact target; no task is changed.",
  ].filter(Boolean).join("\n");
  return text;
}

function parseArgs(argv) {
  const out = { mode: "append", url: DEFAULT_URL, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm") out.confirm = true;
    else if (arg === "--thread" || arg === "--message" || arg === "--mode" || arg === "--url") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      out[arg.slice(2)] = value;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (out.help) return out;
  if (!out.thread || !UUID_RE.test(out.thread)) throw new Error("--thread must be a full UUID");
  if (!out.message?.trim()) throw new Error("--message must not be blank");
  if (!MODES.has(out.mode)) throw new Error(`--mode must be one of: ${[...MODES].join(", ")}`);
  let parsed;
  try {
    parsed = new URL(out.url);
  } catch {
    throw new Error("--url must be an absolute http(s) URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("--url must use http or https");
  out.thread = out.thread.toLowerCase();
  out.message = out.message.trim();
  out.url = parsed.toString().replace(/\/$/, "");
  return out;
}

function passwordFromEnvOrDotenv(env = process.env, envFile = path.join(__dirname, "..", ".env")) {
  if (env.AUTH_PASSWORD?.trim()) return env.AUTH_PASSWORD.trim();
  try {
    const line = fs.readFileSync(envFile, "utf8").split(/\r?\n/).find((v) => v.startsWith("AUTH_PASSWORD="));
    return line?.slice("AUTH_PASSWORD=".length).trim() || "";
  } catch {
    return "";
  }
}

function cookieHeader(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")];
  return values.filter(Boolean).map((v) => v.split(";", 1)[0]).join("; ");
}

function socketUrl(base) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function targetSummary(thread) {
  return {
    id: thread.id,
    title: thread.title,
    state: thread.state,
    workspace: thread.workspace,
  };
}

async function login(baseUrl, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error(`login failed (${response.status})`);
  const cookie = cookieHeader(response.headers);
  if (!cookie) throw new Error("login succeeded but returned no session cookie");
  return cookie;
}

function inspectAndInject({ url, cookie, threadId, message, mode, confirm, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(url), { headers: { Cookie: cookie } });
    let target;
    const timeout = setTimeout(() => finish(new Error("timed out waiting for the target acknowledgement")), timeoutMs);
    const finish = (err, value) => {
      clearTimeout(timeout);
      try { socket.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve(value);
    };
    socket.once("error", () => finish(new Error("WebSocket connection failed")));
    socket.on("message", (raw) => {
      let event;
      try { event = JSON.parse(String(raw)); } catch { return; }
      if (event.type === "hello") {
        target = event.threads?.find((thread) => thread.id === threadId);
        if (!target) return finish(new Error(`no task exists with id ${threadId}`));
        if (!confirm) return finish(null, { target: targetSummary(target), sent: false });
        socket.send(JSON.stringify({ type: "thread.inject", threadId, message, mode }));
        return;
      }
      if (event.type === "thread.message" && event.threadId === threadId && event.message?.content?.includes(message)) {
        finish(null, { target: targetSummary(target), sent: true, acknowledgement: event.message.content });
      }
    });
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(usage(error.message));
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const password = passwordFromEnvOrDotenv(env);
  if (!password) {
    console.error("error: AUTH_PASSWORD is not set (and server/.env has no AUTH_PASSWORD line)");
    return 2;
  }
  try {
    const cookie = await login(args.url, password);
    const result = await inspectAndInject({ ...args, cookie, threadId: args.thread });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
}

module.exports = { MODES, UUID_RE, cookieHeader, parseArgs, passwordFromEnvOrDotenv, socketUrl, targetSummary, usage };

if (require.main === module) {
  main().then((code) => process.exit(code));
}
