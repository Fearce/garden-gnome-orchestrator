import { HttpError, STREAMED, type Router } from "../router.js";
import type { RecordingLibrary } from "./library.js";
import type { PlaybackCache } from "./playback.js";
import { sendFile } from "./playback.js";
import type { RetentionKeeper } from "./retention.js";
import type { RecordingSettings } from "./recordingPlan.js";
import { safeFolderName } from "./urls.js";

/**
 * The recordings browser: each camera's recorded days, a day's segments, and a segment played (as MP4) or
 * downloaded. Every file is resolved by the library from the camera's own recording folder and the
 * recorder's file-name pattern, so a request can never name a path.
 */
export function registerRecordingRoutes(router: Router, deps: { library: RecordingLibrary; playback: PlaybackCache; retention: RetentionKeeper; settings: () => RecordingSettings }): void {
  const { library, playback, retention } = deps;

  router.get("/recordings", async () => {
    const { retentionDays, maxGbPerCamera } = deps.settings();
    return {
      retention: { retentionDays, maxGbPerCamera, enabled: retention.enabled, lastSweep: retention.lastSweep },
      cameras: await library.summary(),
    };
  });

  router.get("/recordings/:cameraId/days/:day", async ({ params }) => ({ segments: await library.day(params.cameraId!, params.day!) }));

  router.get("/recordings/:cameraId/segments/:name/video", async ({ params, query, raw, res }) => {
    const segment = await library.segmentFile(params.cameraId!, params.name!);
    const mp4 = await playback.mp4For(segment.path, playbackVersion(query.get("v"), segment));
    const downloadName = query.get("download") === "1" ? `${downloadStem(segment.folder.name, params.name!)}.mp4` : undefined;
    await sendFile(raw, res, mp4, { contentType: "video/mp4", downloadName });
    return STREAMED;
  });

  router.get("/recordings/:cameraId/segments/:name/file", async ({ params, raw, res }) => {
    const segment = await library.segmentFile(params.cameraId!, params.name!);
    await sendFile(raw, res, segment.path, { contentType: "video/mp2t", downloadName: `${downloadStem(segment.folder.name, params.name!)}.ts` });
    return STREAMED;
  });

  router.post("/recordings/cleanup", async () => {
    if (!retention.enabled) throw new HttpError(400, "Retention is off: every recording is kept. Set a number of days or a size cap first.");
    return { lastSweep: await retention.sweepNow() };
  });
}

/** The size the player listed (`?v=`) pins one copy for a whole playback; without it, the file as it is now. */
function playbackVersion(listed: string | null, segment: { bytes: number; modifiedAt: number }): string {
  return listed && /^\d{1,15}$/.test(listed) ? `listed:${listed}` : `${segment.bytes}|${Math.round(segment.modifiedAt)}`;
}

function downloadStem(cameraName: string, segmentName: string): string {
  return `${safeFolderName(cameraName) || "camera"} ${segmentName.replace(/\.ts$/, "")}`;
}
