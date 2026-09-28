import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { DesktopHelper, ensureHelperBuilt, type DesktopLayout } from "./desktop.js";
import {
  ENCODER_PREFERENCE, MANAGED_FFMPEG, captureThumbnail, ffmpegCandidates, installManagedFfmpeg, probeFfmpeg,
  type EncoderId, type FfmpegProbe, type InstallProgress, type QualityId,
} from "./ffmpeg.js";
import { RemoteSession, pickDisplay } from "./session.js";

const CONFIG_KEY = "remote_control_config";
const LAST_SESSION_KEY = "remote_control_last_session";
const TICKET_TTL_MS = 30_000;
const HELPER_IDLE_STOP_MS = 60_000;

export interface RemoteControlConfig {
  /** Set up and switched on: the board shows the Remote control tab and the stream socket accepts. */
  enabled: boolean;
  ffmpegPath: string | null;
  encoder: EncoderId | null;
  display: number;
  quality: QualityId;
  /** A path the owner typed for an ffmpeg that is neither GGO's own nor on PATH. */
  customFfmpegPath: string | null;
  setupAt: number | null;
}

export interface SessionRecord {
  startedAt: number;
  endedAt: number | null;
  client: string;
  userAgent: string;
}

export interface CheckReport {
  checkedAt: number;
  layout: DesktopLayout | null;
  helperError: string | null;
  ffmpeg: FfmpegProbe[];
  /** The best working ffmpeg + encoder pair, in preference order, or null when none works. */
  recommended: { ffmpegPath: string; encoder: EncoderId } | null;
  managedVersion: string;
  managedInstalled: boolean;
}

export interface RemoteControlStatus {
  supported: boolean;
  config: RemoteControlConfig;
  check: CheckReport | null;
  install: InstallProgress;
  active: SessionRecord | null;
  lastSession: SessionRecord | null;
}

const DEFAULT_CONFIG: RemoteControlConfig = {
  enabled: false,
  ffmpegPath: null,
  encoder: null,
  display: 0,
  quality: "smooth",
  customFfmpegPath: null,
  setupAt: null,
};

export class RemoteControlError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

/**
 * Remote control of the machine GGO runs on: setup (probe ffmpeg + encoders, install a compatible
 * ffmpeg, pick a display), the persisted config, and the single live viewer session.
 */
export class RemoteControlService {
  private checkReport: CheckReport | null = null;
  private checking: Promise<CheckReport> | null = null;
  private installProgress: InstallProgress = { state: "idle", receivedBytes: 0, totalBytes: MANAGED_FFMPEG.bytes };
  private helper: DesktopHelper | null = null;
  private helperStopTimer: NodeJS.Timeout | null = null;
  private session: RemoteSession | null = null;
  private activeRecord: SessionRecord | null = null;
  private tickets = new Map<string, number>();
  private readonly dir: string;

  constructor(private readonly db: { kvGet(key: string): string | null; kvSet(key: string, value: string): void }, dataDir: string) {
    this.dir = join(dataDir, "remote-control");
  }

  get supported(): boolean {
    return process.platform === "win32";
  }

  config(): RemoteControlConfig {
    try {
      const stored = JSON.parse(this.db.kvGet(CONFIG_KEY) ?? "{}") as Partial<RemoteControlConfig>;
      return { ...DEFAULT_CONFIG, ...stored };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  status(): RemoteControlStatus {
    return {
      supported: this.supported,
      config: this.config(),
      check: this.checkReport,
      install: this.installProgress,
      active: this.activeRecord,
      lastSession: this.lastSession(),
    };
  }

  /** Probe everything setup depends on. Concurrent callers share one run. */
  check(): Promise<CheckReport> {
    this.requireSupported();
    this.checking ??= this.runCheck().finally(() => { this.checking = null; });
    return this.checking;
  }

  startInstall(): void {
    this.requireSupported();
    if (["downloading", "verifying", "extracting"].includes(this.installProgress.state)) return;
    this.installProgress = { state: "downloading", receivedBytes: 0, totalBytes: MANAGED_FFMPEG.bytes };
    void installManagedFfmpeg(this.dir, (progress) => { this.installProgress = progress; }).then(
      async () => {
        this.installProgress = { state: "done", receivedBytes: MANAGED_FFMPEG.bytes, totalBytes: MANAGED_FFMPEG.bytes };
        await this.check().catch(() => undefined);
      },
      (error: Error) => {
        this.installProgress = { state: "error", receivedBytes: 0, totalBytes: MANAGED_FFMPEG.bytes, error: error.message };
      },
    );
  }

  async thumbnail(display: number, ffmpegPath: string): Promise<Buffer> {
    this.requireSupported();
    this.requireProbedFfmpeg(ffmpegPath);
    return captureThumbnail(ffmpegPath, display);
  }

  /** Save setup choices. Switching on re-proves the chosen ffmpeg + encoder pair on this machine. */
  async saveConfig(patch: Partial<Omit<RemoteControlConfig, "setupAt">>): Promise<RemoteControlConfig> {
    this.requireSupported();
    const next: RemoteControlConfig = { ...this.config(), ...patch };
    if (patch.ffmpegPath !== undefined && patch.ffmpegPath !== null) this.requireProbedFfmpeg(patch.ffmpegPath);
    if (next.enabled) {
      if (!next.ffmpegPath || !next.encoder) throw new RemoteControlError("Run the check and choose an encoder before turning remote control on.");
      const probe = await probeFfmpeg({ path: next.ffmpegPath, source: "custom" }, next.display);
      const encoder = probe.encoders.find((e) => e.encoder === next.encoder);
      if (!encoder?.ok) throw new RemoteControlError(encoder?.error ?? probe.error ?? `${next.encoder} does not work with that ffmpeg.`);
      if (!this.config().enabled) next.setupAt = Date.now();
    }
    this.db.kvSet(CONFIG_KEY, JSON.stringify(next));
    if (!next.enabled) this.disconnect();
    return next;
  }

  /** A single-use pass for the stream socket, fetched over same-origin HTTP just before connecting.
   *  A page on another site can make a browser open the socket with its cookies, but cannot read this. */
  issueTicket(): string {
    this.requireEnabled();
    const now = Date.now();
    for (const [ticket, expires] of this.tickets) if (expires < now) this.tickets.delete(ticket);
    const ticket = randomBytes(24).toString("hex");
    this.tickets.set(ticket, now + TICKET_TTL_MS);
    return ticket;
  }

  redeemTicket(ticket: string | undefined): boolean {
    if (!ticket) return false;
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return expires !== undefined && expires >= Date.now();
  }

  /** Take over as the one live viewer; an earlier viewer on another device is told and closed. */
  async attach(socket: WebSocket, client: { address: string; userAgent: string }): Promise<void> {
    const config = this.requireEnabled();
    const helper = await this.startHelper();
    const layout = await helper.layout();
    if (!layout.displays.length) throw new RemoteControlError("No display is attached to the desktop.");
    if (socket.readyState !== socket.OPEN) return;
    // Replaced only after the awaits, so two viewers connecting at once still end with exactly one.
    this.session?.replace();
    const record: SessionRecord = { startedAt: Date.now(), endedAt: null, client: client.address, userAgent: client.userAgent.slice(0, 300) };
    const session: RemoteSession = new RemoteSession(socket, helper, {
      ffmpegPath: config.ffmpegPath!,
      encoder: config.encoder!,
      display: pickDisplay(layout.displays, config.display).index,
      quality: config.quality,
      displays: layout.displays,
      elevated: layout.elevated,
      onEnd: () => this.sessionEnded(session, record),
      onChoice: (choice) => this.db.kvSet(CONFIG_KEY, JSON.stringify({ ...this.config(), ...choice })),
    });
    this.session = session;
    this.activeRecord = record;
  }

  disconnect(): void {
    this.session?.end();
  }

  shutdown(): void {
    this.disconnect();
    this.helper?.stop();
  }

  private sessionEnded(session: RemoteSession, record: SessionRecord): void {
    record.endedAt = Date.now();
    this.db.kvSet(LAST_SESSION_KEY, JSON.stringify(record));
    if (this.session !== session) return;
    this.session = null;
    this.activeRecord = null;
    this.scheduleHelperStop();
  }

  private lastSession(): SessionRecord | null {
    try {
      return JSON.parse(this.db.kvGet(LAST_SESSION_KEY) ?? "null") as SessionRecord | null;
    } catch {
      return null;
    }
  }

  private async runCheck(): Promise<CheckReport> {
    const config = this.config();
    let layout: DesktopLayout | null = null;
    let helperError: string | null = null;
    try {
      layout = await (await this.startHelper()).layout();
      this.scheduleHelperStop();
    } catch (error) {
      helperError = (error as Error).message;
    }
    const display = layout ? pickDisplay(layout.displays, config.display).index : 0;
    const candidates = await ffmpegCandidates(this.dir, config.customFfmpegPath);
    const ffmpeg = await Promise.all(candidates.map((c) => probeFfmpeg(c, display)));
    const report: CheckReport = {
      checkedAt: Date.now(),
      layout,
      helperError,
      ffmpeg,
      recommended: recommend(ffmpeg),
      managedVersion: MANAGED_FFMPEG.version,
      managedInstalled: candidates.some((c) => c.source === "managed"),
    };
    this.checkReport = report;
    return report;
  }

  private async startHelper(): Promise<DesktopHelper> {
    if (this.helperStopTimer) {
      clearTimeout(this.helperStopTimer);
      this.helperStopTimer = null;
    }
    this.helper ??= new DesktopHelper(await ensureHelperBuilt(this.dir));
    return this.helper;
  }

  private scheduleHelperStop(): void {
    if (this.session || this.helperStopTimer) return;
    this.helperStopTimer = setTimeout(() => {
      this.helperStopTimer = null;
      if (!this.session) this.helper?.stop();
    }, HELPER_IDLE_STOP_MS);
    this.helperStopTimer.unref?.();
  }

  /** Only an ffmpeg the last check found may be run: a request must never nominate an executable. */
  private requireProbedFfmpeg(path: string): void {
    const known = this.checkReport?.ffmpeg.some((p) => p.path.toLowerCase() === path.toLowerCase());
    const configured = this.config().ffmpegPath?.toLowerCase() === path.toLowerCase();
    if (!known && !configured) throw new RemoteControlError("Run the check first; that ffmpeg has not been probed.");
  }

  private requireSupported(): void {
    if (!this.supported) throw new RemoteControlError("Remote control needs GGO to be running on Windows.", 501);
  }

  private requireEnabled(): RemoteControlConfig {
    this.requireSupported();
    const config = this.config();
    if (!config.enabled || !config.ffmpegPath || !config.encoder) throw new RemoteControlError("Remote control is not set up. Open Settings → Remote control.", 409);
    return config;
  }
}

export function recommend(probes: FfmpegProbe[]): CheckReport["recommended"] {
  for (const encoder of ENCODER_PREFERENCE) {
    const probe = probes.find((p) => p.encoders.some((e) => e.encoder === encoder && e.ok));
    if (probe) return { ffmpegPath: probe.path, encoder };
  }
  return null;
}
