import { spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
import { MemoryIndexStore } from "./indexStore.js";
import type { LunaRequest, LunaResult, WorkerReply, WorkerRequest } from "./workerProtocol.js";

// The memory worker thread: owns the SQLite index (every synchronous query and the directory scan run
// here, never on the server's event loop) and spawns the Codex CLI for Luna calls, because on Windows
// `spawn` itself blocks the calling thread for the duration of CreateProcess. The client terminates it
// after a quiet period, so an idle GGO holds no memory thread at all.

const { dbPath, memoryDir } = workerData as { dbPath: string; memoryDir: string };
const store = new MemoryIndexStore(dbPath, memoryDir);
const port = parentPort!;

port.on("message", (request: WorkerRequest) => {
  if (request.op === "close") {
    store.close();
    port.close();
    return;
  }
  void handle(request).then(
    (value) => port.postMessage({ id: request.id, ok: true, value } satisfies WorkerReply),
    (err: unknown) => port.postMessage({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerReply),
  );
});

async function handle(request: Exclude<WorkerRequest, { op: "close" }>): Promise<unknown> {
  switch (request.op) {
    case "sync":
      return store.sync(request.force);
    case "search":
      return store.search(request.query, request.limit);
    case "file":
      return store.file(request.file);
    case "findByName":
      return store.findByName(request.name);
    case "list":
      return store.list(request.offset, request.limit, request.filter);
    case "cardJobs":
      return store.cardJobs(request.limit, request.exclude);
    case "storeCards":
      return store.storeCards(request.cards);
    case "usage":
      store.recordUsage(request.record);
      return null;
    case "status":
      return store.status();
    case "luna":
      return runLuna(request.request);
  }
}

/** One non-interactive `codex exec` turn: prompt on stdin, JSONL events on stdout, read-only sandbox in an
 *  empty directory, no user config or rules, nothing persisted. Null on any failure or timeout. */
function runLuna(request: LunaRequest): Promise<LunaResult | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let buffer = "";
    let answer = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    let settled = false;
    const finish = (result: LunaResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, request.timeoutMs);
    child.stdin.on("error", () => {});
    child.stdin.end(request.prompt);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        const event = parseEvent(line);
        if (event?.type === "item.completed" && event.item?.type === "agent_message") answer = event.item.text ?? answer;
        if (event?.type === "turn.completed" && event.usage) {
          usage = { inputTokens: Number(event.usage.input_tokens) || 0, outputTokens: Number(event.usage.output_tokens) || 0 };
        }
      }
      if (buffer.length > 262_144 || answer.length > 32_000) {
        child.kill();
        finish(null);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 && answer ? { text: answer, ...usage } : null));
  });
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function parseEvent(line: string): CodexEvent | null {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as CodexEvent;
  } catch {
    return null;
  }
}
