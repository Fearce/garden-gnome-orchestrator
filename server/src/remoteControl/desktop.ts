import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { DESKTOP_HELPER_SOURCE } from "./desktopHelperSource.js";

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 8_000;

export interface DisplayInfo {
  /** DXGI output index on the default adapter — the number ffmpeg's ddagrab `output_idx` takes. */
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface DesktopLayout {
  displays: DisplayInfo[];
  elevated: boolean;
}

export type MouseButton = "left" | "right" | "middle" | "back" | "forward";

/** Where the .NET Framework's compiler lives on every Windows install; nothing to download. */
export function cscPath(): string {
  const windir = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
  return join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
}

/** Compile the helper once per source revision; the hash in the name retires a stale build. */
export async function ensureHelperBuilt(dir: string): Promise<string> {
  const hash = createHash("sha256").update(DESKTOP_HELPER_SOURCE).digest("hex").slice(0, 12);
  const exe = join(dir, `ggo-desktop-${hash}.exe`);
  if (existsSync(exe)) return exe;
  const compiler = cscPath();
  if (!existsSync(compiler)) throw new Error(`The .NET Framework compiler was not found at ${compiler}.`);
  await mkdir(dir, { recursive: true });
  const source = join(dir, `ggo-desktop-${hash}.cs`);
  await writeFile(source, DESKTOP_HELPER_SOURCE, "utf8");
  try {
    await execFileAsync(compiler, ["-nologo", "-target:exe", "-platform:x64", "-optimize+", `-out:${exe}`, "-r:System.Windows.Forms.dll", source], { windowsHide: true, timeout: 120_000 });
  } catch (error) {
    const out = (error as { stdout?: string }).stdout?.trim();
    throw new Error(`Compiling the desktop helper failed${out ? `: ${out.slice(0, 400)}` : "."}`);
  } finally {
    await rm(source, { force: true });
  }
  return exe;
}

/**
 * One long-lived helper process. Input commands are fire-and-forget writes (a pipe write is far below
 * a frame of latency); queries carry an id and resolve on the matching stdout line.
 */
export class DesktopHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private blockedListeners = new Set<(blocked: boolean) => void>();

  constructor(private readonly exePath: string) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  onBlockedChange(listener: (blocked: boolean) => void): () => void {
    this.blockedListeners.add(listener);
    return () => this.blockedListeners.delete(listener);
  }

  async layout(): Promise<DesktopLayout> {
    const reply = await this.query("displays");
    return { displays: (reply.displays as DisplayInfo[]) ?? [], elevated: reply.elevated === true };
  }

  async clipboardText(): Promise<string> {
    const reply = await this.query("clipget");
    return typeof reply.text === "string" ? reply.text : "";
  }

  async setClipboardText(text: string): Promise<void> {
    await this.query("clipset", base64(text));
  }

  move(x: number, y: number): void {
    this.write(`move ${Math.round(x)} ${Math.round(y)}`);
  }

  button(button: MouseButton, down: boolean): void {
    this.write(`button ${button} ${down ? 1 : 0}`);
  }

  wheel(dy: number, dx: number): void {
    this.write(`wheel ${Math.round(dy)} ${Math.round(dx)}`);
  }

  key(scan: number, extended: boolean, down: boolean): void {
    this.write(`key ${scan} ${extended ? 1 : 0} ${down ? 1 : 0}`);
  }

  text(text: string): void {
    if (text) this.write(`text ${base64(text)}`);
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
  }

  private query(command: string, ...args: string[]): Promise<Record<string, unknown>> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The desktop helper did not answer "${command}".`));
      }, QUERY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write([command, id, ...args].join(" "));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private write(line: string): void {
    this.ensureStarted().stdin.write(line + "\n");
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && this.running) return this.child;
    const child = spawn(this.exePath, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdin.on("error", () => undefined);
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr.resume();
    child.on("error", (error) => this.failPending(error));
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      this.failPending(new Error("The desktop helper exited."));
    });
    return child;
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.event === "blocked" || message.event === "unblocked") {
      for (const listener of this.blockedListeners) listener(message.event === "blocked");
      return;
    }
    const id = typeof message.id === "string" ? message.id : null;
    const waiter = id ? this.pending.get(id) : undefined;
    if (!id || !waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (typeof message.error === "string") waiter.reject(new Error(message.error));
    else waiter.resolve(message);
  }

  private failPending(error: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(id);
    }
  }
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
