import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { JsonFile } from "../configStore.js";
import type { ModuleFactory, WorkerContext } from "../context.js";
import { loadOrImport, withValue, type StoredConfig } from "../legacyImport.js";
import { HttpError, Router, STREAMED } from "../router.js";
import { emptyConfig, fromDeckSection, maskCamera, maskUrl, normalizeCamera, normalizeConfig, restoreSecrets, type Camera, type SurveillanceConfig } from "./config.js";
import { RecordingController } from "./controller.js";
import { discoverCamera, type DiscoveryResult } from "./discovery.js";
import { FramePush, FrameSource } from "./frames.js";
import { RecordingLibrary } from "./library.js";
import { PlaybackCache } from "./playback.js";
import { listPresets } from "./presets.js";
import { PreviewSessions } from "./preview.js";
import { killTaggedFfmpeg, resolveFfmpeg } from "./processes.js";
import { Recorder, recordingFolder } from "./recorder.js";
import type { RecordingMode } from "./recordingPlan.js";
import { registerRecordingRoutes } from "./recordingsRoutes.js";
import { isReolink, ReolinkClient } from "./reolink.js";
import { RetentionKeeper } from "./retention.js";
import { SnapshotFetcher } from "./snapshots.js";

const DRAFT_TTL_MS = 30 * 60_000;

export const createSurveillanceModule: ModuleFactory = async (ctx) => {
  const file = new JsonFile<StoredConfig<SurveillanceConfig>>(ctx.configPath);
  const loaded = await loadConfig(ctx, file);
  let stored = loaded.stored;
  let ffmpeg = await resolveFfmpeg(ctx.dataDir, stored.value.ffmpegPath);
  const recorder = new Recorder(async () => ffmpeg, ctx.log);
  const controller = new RecordingController(recorder, ctx, () => stored.value);
  const library = new RecordingLibrary(() =>
    stored.value.cameras.map((camera) => ({ cameraId: camera.id, name: camera.name, dir: recordingFolder(stored.value.recordingRoot, camera) })).filter((folder) => folder.dir),
  );
  const retention = new RetentionKeeper(library, () => stored.value.recording, ctx.log);
  const playback = new PlaybackCache(join(ctx.moduleDir, "playback"), async () => ffmpeg, ctx.log);
  const previews = new PreviewSessions(ctx.log);
  const snapshots = new SnapshotFetcher();
  const reolink = new ReolinkClient();
  const frames = new FrameSource(recorder, snapshots, previews, () => ffmpeg);
  const push = new FramePush(() => stored.value.cameras, frames);
  const drafts = new Map<string, { camera: Camera; at: number }>();

  await killTaggedFfmpeg(ctx.log);
  await reconcilePlan();
  await controller.apply();
  retention.start();

  const router = new Router();

  router.get("/config", () => view());

  router.put("/config", async ({ body }) => {
    const incoming = normalizeConfig(body);
    const before = new Map(stored.value.cameras.map((camera) => [camera.id, camera]));
    incoming.cameras = incoming.cameras.map((camera) => restoreSecrets(camera, before.get(camera.id)));
    const nextFfmpeg = await resolveFfmpeg(ctx.dataDir, incoming.ffmpegPath);
    // Only the mode route turns recording on or off, so an edit from a stale page can never flip it. Read
    // the mode after the await above, so a mode change saved meanwhile is the one kept.
    incoming.recording.mode = stored.value.recording.mode;
    await controller.validate(incoming, nextFfmpeg);
    await save(incoming);
    return view();
  });

  router.get("/presets", () => ({ presets: listPresets() }));

  router.post("/discover", async ({ body }) => {
    const input = body as Record<string, unknown>;
    const result = await discoverCamera({
      host: String(input.host ?? ""),
      port: Number(input.port) || 80,
      username: String(input.username ?? ""),
      password: String(input.password ?? ""),
      modelPreset: String(input.modelPreset ?? ""),
    });
    return publicDiscovery(result, rememberDraft(result.cameraDraft));
  });

  router.post("/cameras/from-discovery", async ({ body }) => {
    const draft = takeDraft(String((body as { draftId?: unknown }).draftId ?? ""));
    await save({ ...stored.value, cameras: [draft, ...stored.value.cameras] });
    return view();
  });

  router.post("/cameras/:id/rediscover", async ({ params }) => {
    const camera = findCamera(params.id!);
    if (!camera.host) throw new HttpError(400, `${camera.name} has no host or IP address yet`);
    const result = await discoverCamera({ host: camera.host, port: camera.port, username: camera.username, password: camera.password, modelPreset: camera.modelPreset || camera.model });
    const merged = mergeDiscovery(camera, result.cameraDraft);
    await save({ ...stored.value, cameras: stored.value.cameras.map((c) => (c.id === camera.id ? merged : c)) });
    return { ...view(), discovery: publicDiscovery(result, null) };
  });

  router.get("/cameras/:id/frame", async ({ params, res }) => {
    const camera = findCamera(params.id!);
    let frame;
    try {
      frame = await frames.next(camera);
    } catch (error) {
      throw new HttpError(503, (error as Error).message);
    }
    res.writeHead(200, { "content-type": frame.contentType, "content-length": frame.buf.length, "cache-control": "no-store", "x-frame-at": String(frame.at) });
    res.end(frame.buf);
    return STREAMED;
  });

  router.post("/cameras/:id/privacy", async ({ params, body }) => {
    const camera = findCamera(params.id!);
    if (!isReolink(camera)) throw new HttpError(400, "Privacy mode is only available on Reolink cameras");
    const enabled = (body as { enabled?: unknown }).enabled === true;
    const result = await reolink.setPrivacy(camera, enabled);
    if (!result.push.ok && !result.email.ok) throw new HttpError(502, `The camera did not change its alerts: ${result.push.detail ?? result.email.detail ?? "no reason given"}`, { lastResult: result });
    const updated: Camera = { ...camera, privacyMode: { enabled, updatedAt: new Date().toISOString(), lastResult: result } };
    await save({ ...stored.value, cameras: stored.value.cameras.map((c) => (c.id === camera.id ? updated : c)) });
    return { enabled, lastResult: result, ...view() };
  });

  router.get("/recording", () => recordingView());

  router.put("/recording/mode", async ({ body }) => {
    const mode = parseMode((body as { mode?: unknown }).mode);
    const next = { ...stored.value, recording: { ...stored.value.recording, mode } };
    await controller.validate(next, ffmpeg);
    await controller.armFor(next);
    await save(next);
    ctx.log(`recording mode set to ${mode} by the owner`);
    return recordingView();
  });

  registerRecordingRoutes(router, { library, playback, retention, settings: () => stored.value.recording });

  /**
   * The mode in config.json and the armed marker agree unless something changed one without the other:
   * a recording started before modes existed (armed, no mode) is kept going as 24/7, and a plan whose marker
   * is gone was ended by "stop the service anyway", which ends user-started work for good.
   */
  async function reconcilePlan(): Promise<void> {
    const armed = await ctx.armedReason();
    const mode = stored.value.recording.mode;
    if (armed && mode === "off" && !loaded.hadRecordingSettings) {
      await save({ ...stored.value, recording: { ...stored.value.recording, mode: "continuous" } }, false);
      ctx.log("a recording started before recording modes existed is kept going as 24/7 recording");
    } else if (!armed && mode !== "off") {
      await save({ ...stored.value, recording: { ...stored.value.recording, mode: "off" } }, false);
      ctx.log("recording was ended with the service, so it stays off until the owner turns it on again");
    }
  }

  async function save(next: SurveillanceConfig, apply = true): Promise<void> {
    const retentionChanged = next.recording.retentionDays !== stored.value.recording.retentionDays || next.recording.maxGbPerCamera !== stored.value.recording.maxGbPerCamera;
    stored = withValue(stored, next);
    await file.write(stored);
    ffmpeg = await resolveFfmpeg(ctx.dataDir, next.ffmpegPath);
    if (apply) await controller.apply();
    if (retentionChanged) retention.settingsChanged();
  }

  function view() {
    return {
      origin: stored.origin,
      importedAt: stored.importedAt,
      recordingRoot: stored.value.recordingRoot,
      ffmpegPath: stored.value.ffmpegPath,
      ffmpegFound: Boolean(ffmpeg),
      recording: stored.value.recording,
      cameras: stored.value.cameras.map(maskCamera),
    };
  }

  function recordingView() {
    const { recording } = stored.value;
    return {
      ...controller.view(),
      schedule: recording.schedule,
      segmentMinutes: recording.segmentMinutes,
      recordingRoot: stored.value.recordingRoot,
      cameras: recorder.statuses(),
    };
  }

  function findCamera(id: string): Camera {
    const camera = stored.value.cameras.find((c) => c.id === id);
    if (!camera) throw new HttpError(404, "That camera is no longer configured");
    return camera;
  }

  function rememberDraft(camera: Camera): string {
    const now = Date.now();
    for (const [id, draft] of drafts) if (now - draft.at > DRAFT_TTL_MS) drafts.delete(id);
    const id = randomBytes(9).toString("hex");
    drafts.set(id, { camera, at: now });
    return id;
  }

  function takeDraft(id: string): Camera {
    const draft = drafts.get(id);
    if (!draft) throw new HttpError(410, "That discovery result expired; run the discovery again");
    drafts.delete(id);
    return normalizeCamera(draft.camera);
  }

  return {
    router,
    busy: () => controller.busyLabel(),
    onStream: (socket) => push.add(socket),
    shutdown: async () => {
      retention.dispose();
      await controller.dispose();
      push.closeAll();
      previews.closeAll();
      await recorder.stop();
    },
  };
};

async function loadConfig(ctx: WorkerContext, file: JsonFile<StoredConfig<SurveillanceConfig>>): Promise<{ stored: StoredConfig<SurveillanceConfig>; hadRecordingSettings: boolean }> {
  const stored = await loadOrImport({
    file,
    hubUrl: ctx.hubUrl,
    sections: ["surveillance"],
    fromDeck: (sections) => fromDeckSection(sections.surveillance),
    empty: emptyConfig,
    log: ctx.log,
  });
  const raw = stored.value as unknown as Record<string, unknown>;
  return { stored: { ...stored, value: normalizeConfig(stored.value) }, hadRecordingSettings: Boolean(raw && typeof raw.recording === "object" && raw.recording) };
}

function parseMode(value: unknown): RecordingMode {
  if (value === "off" || value === "continuous" || value === "schedule") return value;
  throw new HttpError(400, "mode must be off, continuous or schedule");
}

/** Discovery's answer for the browser: the draft and every probed URL with its credentials masked. */
function publicDiscovery(result: DiscoveryResult, draftId: string | null) {
  return {
    draftId,
    detectedVendor: result.detectedVendor,
    matchedPreset: result.matchedPreset,
    openPorts: result.openPorts,
    rootProbe: { ...result.rootProbe, url: maskUrl(result.rootProbe.url) },
    onvifProbes: result.onvifProbes.map((probe) => ({ url: maskUrl(probe.url), ok: probe.ok, statusCode: probe.statusCode ?? null, error: probe.error ?? null })),
    rtspCandidates: result.rtspCandidates.map((candidate) => ({ label: candidate.label, url: maskUrl(candidate.url) })),
    snapshotProbes: result.snapshotProbes.map((probe) => ({ url: maskUrl(probe.url), ok: probe.ok, statusCode: probe.statusCode ?? null, contentType: probe.contentType ?? null, error: probe.error ?? null })),
    cameraDraft: maskCamera(result.cameraDraft),
  };
}

/** Fresh discovery findings over an existing camera; its name and layout stay as the owner set them. */
function mergeDiscovery(camera: Camera, draft: Camera): Camera {
  const keepName = camera.name && camera.name !== "New camera";
  return {
    ...camera,
    vendor: draft.vendor || camera.vendor,
    model: draft.model || camera.model,
    modelPreset: draft.modelPreset || camera.modelPreset,
    host: draft.host || camera.host,
    port: draft.port || camera.port,
    onvifUrl: draft.onvifUrl || camera.onvifUrl,
    snapshotUrl: draft.snapshotUrl,
    streamUrl: draft.streamUrl || camera.streamUrl,
    subStreamUrl: draft.subStreamUrl || camera.subStreamUrl,
    previewStrategy: draft.previewStrategy || camera.previewStrategy,
    notes: draft.notes || camera.notes,
    name: keepName ? camera.name : draft.name,
  };
}
