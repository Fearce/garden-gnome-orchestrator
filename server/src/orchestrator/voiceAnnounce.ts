// Spoken task-completion announcements for voice mode. When a task reaches 'done' while the
// voice-gateway is running, one short sentence tailored to the task is composed (cheap Haiku
// call, same raw OAuth fetch as the auto-titles) and published as a `voice.announce` event the
// gateway speaks. Best-effort end to end: gateway down → return null with NO model spend;
// no token / model failure → a plain "Task complete: <title>" fallback; never throws.

import type { Thread } from "../types.js";
import { haikuLine } from "./titleFromInjection.js";

const VOICE_GW = process.env.VOICE_GATEWAY_URL || "http://127.0.0.1:3960";

const ANNOUNCE_PROMPT = `A coding task just finished successfully and its completion will be read aloud to the owner over speakers. Compose ONE short spoken sentence (under 22 words) announcing it — name concretely WHAT got done, naturally, like a colleague telling them in passing. Plain text only: no markdown, no quotes, no emoji, no preamble, no "Task complete:" prefix. The task follows:`;

async function gatewayUp(): Promise<boolean> {
  try {
    const res = await fetch(`${VOICE_GW}/api/status`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The sentence to speak for a completed thread, or null when voice mode is off (gateway down). */
export async function completionAnnouncement(thread: Thread, token: string | undefined): Promise<string | null> {
  if (!(await gatewayUp())) return null;
  const detail = `Title: ${thread.title}\n\nBrief: ${(thread.brief ?? "").slice(0, 600)}`;
  const line = await haikuLine(detail, token, ANNOUNCE_PROMPT).catch(() => null);
  return line || `Task complete: ${thread.title}.`;
}
