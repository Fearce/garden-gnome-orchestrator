import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testInvocationUsesDefaultData } from "../runtimeIsolation.js";

/** The handshake file the user-level memory hook scripts (Claude Code's and Codex's own) read to reach
 *  this server: its loopback URL and a per-boot token. Lives in the memory directory, next to the files
 *  it serves, and is never synced anywhere. */
export const ENDPOINT_FILE = ".ggo-memory-endpoint.json";

/** Only the primary instance owns the memory directory's background work and its handshake file. A lab
 *  or test run points DATA_DIR elsewhere but still reads the real MEMORY_DIR from server/.env; it must
 *  neither redirect the hook scripts to itself nor process the shared extraction queue. */
export function isPrimaryMemoryOwner(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  return !env.DATA_DIR?.trim() && !testInvocationUsesDefaultData(env, argv);
}

export class MemoryEndpoint {
  readonly token = randomBytes(24).toString("hex");

  constructor(private readonly dir: string) {}

  async publish(host: string, port: number): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const body = { url: `http://${loopbackHost(host)}:${port}`, token: this.token, pid: process.pid, startedAt: new Date().toISOString() };
    const path = join(this.dir, ENDPOINT_FILE);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(body, null, 2), "utf8");
    await rename(temp, path);
  }

  accepts(header: string | string[] | undefined): boolean {
    const value = Array.isArray(header) ? header[0] : header;
    const presented = Buffer.from((value ?? "").replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(this.token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }
}

/** A wildcard bind is reachable on loopback; a specific address is used as bound. */
function loopbackHost(host: string): string {
  if (["0.0.0.0", "::", "", "localhost"].includes(host)) return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}
