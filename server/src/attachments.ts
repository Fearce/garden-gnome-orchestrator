import type { ImageAttachment } from "./types.js";

/** Anthropic image content block — what the Agent SDK forwards verbatim to the model. */
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: ImageAttachment["mediaType"]; data: string };
}

/** The API's per-image ceiling, measured on the BASE64 payload — not on the file the operator picked,
 *  which is only 3/4 of it. Over this the request does not degrade, it FAILS: the run dies mid-work with
 *  "Image base64 size (N MB) exceeds API limit (5MB)", having already spent whatever it spent. The
 *  console guards its own uploads (`web/src/lib/attachments.tsx`), but images also arrive from earlier
 *  sessions, resumes and re-dispatches — including four rows stored before that guard was corrected —
 *  so the last point before the wire enforces it too. */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

export function toImageBlock(a: ImageAttachment): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.dataBase64 } };
}

/** An image the API would reject outright. base64 is ASCII, so its length is its byte count. */
const overApiLimit = (b: ImageBlock): boolean => b.source.data.length > MAX_IMAGE_BASE64_BYTES;

/** Say what was left out, so a missing picture reads as a known omission the agent can ask about rather
 *  than as an instruction referring to something that isn't there. */
function omissionNote(count: number): string {
  const [subject, object] = count === 1 ? ["image was", "it"] : ["images were", "them"];
  return `[${count} attached ${subject} left out: over the API's ${MAX_IMAGE_BASE64_BYTES / (1024 * 1024)}MB per-image limit. Ask for a smaller version if you need to see ${object}.]`;
}

/**
 * Wrap a kickoff/prompt string into a user-content array that carries image
 * blocks, or return the bare string when there are none — so an image-free
 * dispatch is byte-identical to the previous string-only behavior.
 *
 * An oversized block is dropped rather than sent: losing one picture costs this turn's view of it,
 * while sending it costs the whole run.
 */
export function contentWithImages(text: string, blocks: ImageBlock[]): string | unknown[] {
  const sendable = blocks.filter((b) => !overApiLimit(b));
  const dropped = blocks.length - sendable.length;
  const body = dropped > 0 ? `${text}\n\n${omissionNote(dropped)}` : text;
  return sendable.length ? [{ type: "text", text: body }, ...sendable] : body;
}
