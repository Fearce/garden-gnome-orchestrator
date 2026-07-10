// Spoken task-completion announcements for voice mode. When a task reaches 'done' while voice
// mode is ON, one short sentence tailored to the task is composed (cheap Haiku call, same raw
// OAuth fetch as the auto-titles) and published as a `voice.announce` event the gateway speaks.
// "Voice mode on" = the gateway reports wake enabled — the PROCESS runs 24/7 under script-hub
// keepAlive, so reachability alone means nothing. Best-effort end to end: gateway down or mic
// off → return null with NO model spend; no token / model failure → a plain
// "Task complete: <title>" fallback; never throws.

import type { Thread } from "../types.js";
import { haikuLine } from "./titleFromInjection.js";

const VOICE_GW = process.env.VOICE_GATEWAY_URL || "http://127.0.0.1:3960";

const ANNOUNCE_PROMPT = `A coding task just finished successfully and its completion will be read aloud to the owner over speakers. Compose ONE short spoken sentence (under 22 words) announcing it — name concretely WHAT got done, naturally, like a colleague telling them in passing. Plain text only: no markdown, no quotes, no emoji, no preamble, no "Task complete:" prefix. The task follows:`;

async function voiceModeOn(): Promise<boolean> {
  try {
    const res = await fetch(`${VOICE_GW}/api/status`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const status = (await res.json()) as { wake?: { enabled?: boolean } };
    return status.wake?.enabled === true;
  } catch {
    return false;
  }
}

/** The sentence to speak for a completed thread, or null when voice mode is off (gateway down or mic toggled off). */
export async function completionAnnouncement(thread: Thread, token: string | undefined): Promise<string | null> {
  if (!(await voiceModeOn())) return null;
  const detail = `Title: ${thread.title}\n\nBrief: ${(thread.brief ?? "").slice(0, 600)}`;
  const line = await haikuLine(detail, token, ANNOUNCE_PROMPT).catch(() => null);
  return line || `Task complete: ${thread.title}.`;
}
