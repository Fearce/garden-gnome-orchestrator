import type { ImageMediaType } from "../types.js";

/** The API's per-image ceiling, measured on the BASE64 payload the model receives. */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** …and the size of a FILE that encodes to it — base64 is 4 characters per 3 bytes, so a picture is 4/3
 *  of itself on the wire. Checking the file against the API's own 5MB number is the bug this constant
 *  exists to prevent: it let every image between 3.75MB and 5MB through to be rejected mid-run, killing
 *  the task that carried it (2026-08-26 — one $8 implementor run, and four such images already stored). */
export const MAX_IMAGE_BYTES = Math.floor((MAX_IMAGE_BASE64_BYTES * 3) / 4);
/** …and what the operator may actually PICK. The two caps above are the API's and cannot move — a
 *  payload past them is not degraded, the run DIES ("Image base64 size exceeds API limit") — but nothing
 *  says the operator has to do the shrinking. A file over `MAX_IMAGE_BYTES` is re-encoded before it
 *  becomes an attachment, so a 4K screenshot or a phone photo attaches instead of being refused. This is
 *  only a bound on how much work one paste may cost; anything under it is accepted and resized. */
export const MAX_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
/** The longest edge a re-encode renders to. The API downsamples anything past ~1568px on the long edge
 *  before the model ever sees it, so pixels beyond this bound cost payload size and tokens and buy no
 *  detail. Kept above 1568 so the console is never the thing that loses legibility first. */
export const MAX_IMAGE_EDGE = 2000;

/** The four types the API takes as a native image block — mirrored by the server's own zod enum in
 *  `server/src/ws/protocol.ts`. Anything else has to be re-encoded into one of these before it is sent. */
export const SUPPORTED_IMAGE_TYPES: readonly ImageMediaType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const SUPPORTED = new Set<string>(SUPPORTED_IMAGE_TYPES);

export const isSupportedImageType = (type: string | undefined | null): type is ImageMediaType => SUPPORTED.has(type ?? "");

/** How many leading bytes `sniffImageType` needs. The longest signature it reads is the ISO-BMFF brand
 *  at offset 8 (HEIC/AVIF), and 32 leaves room for the RIFF/WebP pair without a second read. */
export const IMAGE_SNIFF_BYTES = 32;

const ascii = (bytes: Uint8Array, at: number, len: number): string =>
  String.fromCharCode(...Array.from(bytes.subarray(at, at + len)));

const startsWith = (bytes: Uint8Array, sig: readonly number[]): boolean =>
  bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);

/** ISO base media containers all begin `....ftyp<brand>`; the brand is what separates a HEIC photo from
 *  an AVIF one from a video the operator picked by mistake. */
function sniffIsoBmff(bytes: Uint8Array): string | null {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== "ftyp") return null;
  const brand = ascii(bytes, 8, 4);
  if (brand === "avif" || brand === "avis") return "image/avif";
  if (["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"].includes(brand)) return "image/heic";
  if (["mif1", "msf1", "miaf"].includes(brand)) return "image/heif";
  return null;
}

/**
 * What a file's BYTES say it is, which is the only trustworthy answer on a phone: an Android gallery
 * hands Chrome a `content://` item whose declared type is routinely `""` or `application/octet-stream`,
 * and iOS hands over `image/heic`. Refusing those on the declared type alone is what stopped a phone
 * screenshot attaching at all. Returns null for anything this doesn't recognise as a raster image.
 */
export function sniffImageType(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "image/webp";
  if (startsWith(head, [0x42, 0x4d])) return "image/bmp";
  if (startsWith(head, [0x49, 0x49, 0x2a, 0]) || startsWith(head, [0x4d, 0x4d, 0, 0x2a])) return "image/tiff";
  return sniffIsoBmff(head);
}

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** The last resort, for a picker that gives neither a usable type nor readable magic bytes. */
export function imageTypeFromName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (EXTENSION_TYPES[name.slice(dot + 1).toLowerCase()] ?? null);
}

export interface PickedFileFacts {
  /** `File.type` — a hint from the picker, not a fact. */
  declaredType: string;
  name: string;
  size: number;
  /** The first `IMAGE_SNIFF_BYTES` of the file, or null when they couldn't be read. */
  head: Uint8Array | null;
}

export type ImageIntake =
  /** Not a picture at all — a document, an archive, a video. */
  | { action: "reject"; reason: "type" }
  /** A picture, but a bigger pick than one paste is allowed to cost. */
  | { action: "reject"; reason: "size" }
  /** Already a type the API takes, and already small enough: send the operator's own bytes. */
  | { action: "pass-through"; mediaType: ImageMediaType }
  /** Decode and render into a supported type — because it is too big, or because the API can't read
   *  this container. `preferLossless` keeps a screenshot's text crisp when the payload budget allows. */
  | { action: "re-encode"; sourceType: string; preferLossless: boolean };

/**
 * Decide what to do with a picked file, from facts rather than from what the picker claimed. Pure, so
 * the decision table is gated in node while the browser only owns the decode/encode it actually needs.
 */
export function planImageIntake(file: PickedFileFacts): ImageIntake {
  const sniffed = file.head ? sniffImageType(file.head) : null;
  const declared = file.declaredType.trim().toLowerCase();
  // Bytes first, then the picker's claim, then the name. A phone that says nothing is still holding a
  // PNG, and a phone that says `image/heic` is telling the truth about a container the API can't read.
  const effective = sniffed ?? (declared.startsWith("image/") ? declared : null) ?? imageTypeFromName(file.name);
  if (!effective) return { action: "reject", reason: "type" };
  if (file.size > MAX_IMAGE_SOURCE_BYTES) return { action: "reject", reason: "size" };
  if (isSupportedImageType(effective) && file.size <= MAX_IMAGE_BYTES) {
    return { action: "pass-through", mediaType: effective };
  }
  // A JPEG is already lossy, so re-encoding it as PNG only inflates it; everything else is treated as a
  // screenshot until the payload budget says otherwise.
  return { action: "re-encode", sourceType: effective, preferLossless: effective !== "image/jpeg" };
}

export interface RenderStep {
  edge: number;
  mediaType: ImageMediaType;
  quality: number;
}

/** The render ladder, in order. Dimensions come down before quality does, because payload grows with
 *  area and the API discards the extra pixels anyway. A lossless first pass keeps a screenshot's text
 *  crisp whenever the payload budget allows it; a JPEG source is never re-encoded as PNG, which would
 *  only inflate something already lossy. */
export function renderLadder(preferLossless: boolean): RenderStep[] {
  const lossless: RenderStep[] = preferLossless
    ? [
        { edge: MAX_IMAGE_EDGE, mediaType: "image/png", quality: 1 },
        { edge: 1568, mediaType: "image/png", quality: 1 },
      ]
    : [{ edge: MAX_IMAGE_EDGE, mediaType: "image/jpeg", quality: 0.92 }];
  return [
    ...lossless,
    { edge: 1568, mediaType: "image/jpeg", quality: 0.85 },
    { edge: 1200, mediaType: "image/jpeg", quality: 0.8 },
    { edge: 900, mediaType: "image/jpeg", quality: 0.7 },
  ];
}

export const isLosslessStep = (step: RenderStep): boolean => step.mediaType === "image/png";

/** How far over the cap a first lossless attempt may land and a second one still be worth paying for.
 *  1568px is 0.61× the area of 2000px, so a measured overshoot past 2× cannot come down far enough. */
export const LOSSLESS_RETRY_OVERSHOOT = 2;

/**
 * Whether to spend a second lossless render, given what the first one measured. This is a phone's
 * memory, not a nicety: a 21 MB source produced 11.26 MB of base64 at 2000px, and the 1568px PNG that
 * followed it — 7.19 MB, also unusable — was a second multi-megabyte string allocated for nothing
 * before the JPEG step finally fit in 0.96 MB. A 6.93 MB first attempt, by contrast, came down to
 * 4.30 MB and attached losslessly, which is the case worth keeping.
 *
 * Skipping is safe in one direction only, and that is why the bound is generous: a skipped lossless
 * step costs a screenshot some crispness, while the JPEG steps below it always fit.
 */
export const losslessRetryWorthwhile = (lastLosslessBase64: number): boolean =>
  lastLosslessBase64 <= MAX_IMAGE_BASE64_BYTES * LOSSLESS_RETRY_OVERSHOOT;
