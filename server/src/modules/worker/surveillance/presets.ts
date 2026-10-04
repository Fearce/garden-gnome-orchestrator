export interface OnvifCandidate {
  protocol: "http" | "https";
  port: number;
  path: string;
}

export interface RtspCandidate {
  port: number;
  path: string;
  label: string;
}

export interface CameraPreset {
  id: string;
  vendor: string;
  model: string;
  aliases: string[];
  onvifCandidates: OnvifCandidate[];
  rtspCandidates: RtspCandidate[];
  notes: string[];
}

const TAPO_ONVIF: OnvifCandidate[] = [{ protocol: "http", port: 2020, path: "/onvif/device_service" }];
const TAPO_RTSP: RtspCandidate[] = [
  { port: 554, path: "/stream1", label: "Main stream" },
  { port: 554, path: "/stream2", label: "Sub stream" },
];
const REOLINK_ONVIF: OnvifCandidate[] = [
  { protocol: "http", port: 8000, path: "/onvif/device_service" },
  { protocol: "http", port: 80, path: "/onvif/device_service" },
];
const REOLINK_RTSP: RtspCandidate[] = [
  { port: 554, path: "/Preview_01_main", label: "Main stream" },
  { port: 554, path: "/Preview_01_sub", label: "Sub stream" },
  { port: 554, path: "/h264Preview_01_main", label: "Legacy main stream" },
  { port: 554, path: "/h264Preview_01_sub", label: "Legacy sub stream" },
];

/** Camera families the discovery knows the stream paths and ONVIF ports of. */
export const CAMERA_PRESETS: CameraPreset[] = [
  {
    id: "tapo-c100",
    vendor: "TP-Link Tapo",
    model: "Tapo C100",
    aliases: ["tapo c100", "c100", "tapo-c100"],
    onvifCandidates: TAPO_ONVIF,
    rtspCandidates: TAPO_RTSP,
    notes: [
      "Tapo wired cameras use RTSP stream1/stream2 and ONVIF Profile S.",
      "You need the separate camera account from the Tapo app, not the Tapo cloud login.",
    ],
  },
  {
    id: "tapo-c200",
    vendor: "TP-Link Tapo",
    model: "Tapo C200",
    aliases: ["tapo c200", "c200", "tapo-c200"],
    onvifCandidates: TAPO_ONVIF,
    rtspCandidates: TAPO_RTSP,
    notes: [
      "Tapo wired cameras use RTSP stream1/stream2 and ONVIF Profile S.",
      "Pan/tilt control usually comes from ONVIF-capable clients rather than raw RTSP.",
    ],
  },
  {
    id: "reolink-d340p",
    vendor: "Reolink",
    model: "Reolink D340P / Video Doorbell PoE",
    aliases: ["d340p", "reolink d340p", "reolink doorbell poe", "video doorbell poe"],
    onvifCandidates: REOLINK_ONVIF,
    rtspCandidates: REOLINK_RTSP,
    notes: [
      "Reolink doorbells support RTSP and ONVIF, but RTSP and related ports may need to be enabled in Reolink Client.",
      "Some clients prefer Preview_01_main while older integrations expect h264Preview_01_main.",
    ],
  },
  {
    id: "reolink-duo-2v",
    vendor: "Reolink",
    model: "Reolink Duo 2V / Duo 2 PoE",
    aliases: ["duo 2v", "duo2v", "reolink duo 2v", "reolink duo 2 poe", "duo 2 poe"],
    onvifCandidates: REOLINK_ONVIF,
    rtspCandidates: REOLINK_RTSP,
    notes: [
      "On some Reolink Duo models, third-party ports are disabled by default and must be enabled in Reolink Client.",
      "Main stream may be H.265 on higher-resolution models, so some clients work better with the sub stream.",
    ],
  },
  {
    id: "tapo-generic",
    vendor: "TP-Link Tapo",
    model: "Generic Tapo wired camera",
    aliases: ["tapo", "tp-link tapo", "generic tapo"],
    onvifCandidates: TAPO_ONVIF,
    rtspCandidates: TAPO_RTSP,
    notes: ["Use this when the exact Tapo wired model is not known yet."],
  },
  {
    id: "reolink-generic",
    vendor: "Reolink",
    model: "Generic Reolink camera",
    aliases: ["reolink", "generic reolink"],
    onvifCandidates: REOLINK_ONVIF,
    rtspCandidates: REOLINK_RTSP,
    notes: ["Use this when the exact Reolink model is not known yet."],
  },
];

const normalise = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function findPreset(value: unknown): CameraPreset | null {
  const needle = normalise(value);
  if (!needle) return null;
  return CAMERA_PRESETS.find((preset) => preset.id === needle || preset.aliases.some((alias) => normalise(alias) === needle)) ?? null;
}

export function inferVendor(text: unknown): string {
  const sample = normalise(text);
  if (sample.includes("reolink")) return "Reolink";
  if (sample.includes("tapo") || sample.includes("tp-link")) return "TP-Link Tapo";
  return "";
}

export function pickPreset(presetId: unknown, ...texts: unknown[]): CameraPreset | null {
  const explicit = findPreset(presetId);
  if (explicit) return explicit;
  const vendor = texts.map(inferVendor).find(Boolean);
  if (vendor === "TP-Link Tapo") return findPreset("tapo-generic");
  if (vendor === "Reolink") return findPreset("reolink-generic");
  return null;
}

export function listPresets(): Pick<CameraPreset, "id" | "vendor" | "model" | "aliases" | "notes">[] {
  return CAMERA_PRESETS.map(({ id, vendor, model, aliases, notes }) => ({ id, vendor, model, aliases, notes }));
}
