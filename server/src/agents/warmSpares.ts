import { createHash } from "node:crypto";
import { prewarm, type ClaimOptions, type Options, type SpareProcess } from "@anthropic-ai/claude-agent-sdk";

/** A parked process holds ~250 MB; unclaimed for an hour means its caller has gone quiet or been switched off. */
const SPARE_IDLE_MS = 60 * 60_000;
const PREWARM_INIT_TIMEOUT_MS = 60_000;

type Prewarm = (options: Options) => Promise<SpareProcess>;

type Slot = {
  readonly key: string;
  spare: Promise<SpareProcess | undefined>;
  /** The spare once started, so an exit handler, where no promise settles, can still close it. */
  ready?: SpareProcess;
  taken: boolean;
  idleTimer?: NodeJS.Timeout;
};

/** Keeps one started Claude Code process parked for the next run with the same host-level options, so a
 *  short structured call skips the CLI boot on its critical path. The SDK fixes host-level options (env,
 *  tools, system prompt, output schema) at prewarm, so a run with different ones misses and the spare is
 *  replaced with one for them. */
export class WarmSpares {
  private slot: Slot | undefined;

  constructor(
    private readonly startSpare: Prewarm = (options) => prewarm({ options, initializeTimeoutMs: PREWARM_INIT_TIMEOUT_MS }),
    private readonly idleMs = SPARE_IDLE_MS,
  ) {}

  /** The spare warmed for exactly these options, or undefined to boot cold. A spare still starting is
   *  awaited: it began before this call, so it is ready sooner than a cold boot would be. Either way a
   *  replacement starts warming for the next run. */
  async take(options: Options): Promise<SpareProcess | undefined> {
    if (!spareable(options)) return undefined;
    const key = hostOptionsKey(options);
    const hit = this.slot?.key === key ? this.slot : undefined;
    if (hit) this.claimSlot(hit);
    else this.discard();
    this.slot = this.warm(key, options);
    return hit ? hit.spare : undefined;
  }

  /** Terminate the parked spare (process exit, sign-out). */
  discard(): void {
    const slot = this.slot;
    this.slot = undefined;
    if (!slot || slot.taken) return;
    this.claimSlot(slot);
    if (slot.ready) slot.ready.close();
    else void slot.spare.then((spare) => spare?.close());
  }

  private warm(key: string, options: Options): Slot {
    const slot = { key, taken: false } as Slot;
    slot.spare = this.startSpare(prewarmOptions(options)).then((spare) => this.park(slot, spare), () => this.forget(slot));
    return slot;
  }

  private park(slot: Slot, spare: SpareProcess): SpareProcess {
    slot.ready = spare;
    // `claimed` rejects for every spare discarded unclaimed; nobody else may be listening.
    spare.claimed.catch(() => {});
    void spare.exited.then(() => this.forget(slot));
    if (!slot.taken) {
      slot.idleTimer = setTimeout(() => {
        this.forget(slot);
        spare.close();
      }, this.idleMs);
      slot.idleTimer.unref();
    }
    return spare;
  }

  private claimSlot(slot: Slot): void {
    slot.taken = true;
    clearTimeout(slot.idleTimer);
  }

  private forget(slot: Slot): undefined {
    clearTimeout(slot.idleTimer);
    if (this.slot === slot) this.slot = undefined;
    return undefined;
  }
}

/** The per-session options a claim carries; everything else was fixed when the spare was warmed. */
export function claimOptionsOf(options: Options): ClaimOptions {
  const claim: ClaimOptions = { cwd: options.cwd ?? process.cwd() };
  if (options.model) claim.model = options.model;
  if (options.permissionMode) claim.permissionMode = options.permissionMode;
  return claim;
}

/** True when a reported claim failure means the prompt never ran on the spare, so the call must be made
 *  again cold. `option_not_applied` is the one failure after which the session is already running. */
export function claimNeverRan(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !message.startsWith("option_not_applied");
}

/** Resumed sessions and runs carrying callbacks or in-process servers are not served from a spare: those
 *  bind to one run, and a shared spare would hand them to the next one. */
function spareable(options: Options): boolean {
  return !options.resume && !options.forkSession && !options.canUseTool && !options.hooks && !options.mcpServers && !options.agents;
}

function prewarmOptions(options: Options): Options {
  const { cwd: _sessionFolder, ...host } = options;
  return host;
}

function hostOptionsKey(options: Options): string {
  return createHash("sha256").update(JSON.stringify(prewarmOptions(options))).digest("hex");
}
