import type { ImageAttachment } from "./types.js";

/** Anthropic image content block — what the Agent SDK forwards verbatim to the model. */
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: ImageAttachment["mediaType"]; data: string };
}

export function toImageBlock(a: ImageAttachment): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.dataBase64 } };
}

/**
 * Wrap a kickoff/prompt string into a user-content array that carries image
 * blocks, or return the bare string when there are none — so an image-free
 * dispatch is byte-identical to the previous string-only behavior.
 */
export function contentWithImages(text: string, blocks: ImageBlock[]): string | unknown[] {
  return blocks.length ? [{ type: "text", text }, ...blocks] : text;
}
