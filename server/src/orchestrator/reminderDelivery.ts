import type { FiredReminderInput, FiredReminders, ReminderDelivery } from "../calendar/firedReminders.js";
import type { EventHub } from "../events.js";
import type { SendResult } from "./discordNotify.js";

/** Where a reminder goes: the owner's Discord DM, and the note list when that DM fails. */
export interface ReminderChannel {
  /** Whether a DM can go out right now (Phone notifications on, token and destination set). */
  ready(): boolean;
  send(title: string, text: string): Promise<SendResult>;
  /** Durable fallback when the DM did not go through. It survives the restarts a deploy causes, unlike
   *  the in-process retries. */
  fallback(title: string, text: string, why: string): void;
  /** The Calendar tab's list of reminders that went off, with how each DM went. */
  fired: Pick<FiredReminders, "record" | "setDelivery">;
}

// Waits before each retry of a reminder DM that did not go through (Discord down, a transient 5xx).
export const REMINDER_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** What one reminder delivery sends. `current` re-reads it before every retry: null when what it reminds
 *  about was deleted or moved meanwhile, so a retry never delivers a stale reminder. */
export interface ReminderMessage {
  title: string;
  text: string;
  /** What the activity log names it by, so a caller holding personal text can keep it out of the log. */
  label: string;
  current?: () => { title: string; text: string } | null;
  /** What it reminds about, for the Calendar tab's list. A test send leaves it out and is not listed. */
  fired?: Omit<FiredReminderInput, "title" | "text">;
}

/**
 * Send one reminder straight to the owner — no agent is involved — retrying a failed DM a bounded
 * number of times. The first failure also puts it on the note list, so a reminder still reaches the
 * owner if every retry fails or a restart cuts them off.
 */
export async function deliverReminder(
  channel: ReminderChannel,
  hub: EventHub,
  reminder: ReminderMessage,
  retryMs: readonly number[] = REMINDER_RETRY_MS,
): Promise<void> {
  let { title, text } = reminder;
  const { label } = reminder;
  const firedId = reminder.fired ? channel.fired.record({ ...reminder.fired, title, text }) : null;
  const track = (delivery: ReminderDelivery, note: string | null = null) => {
    if (firedId) channel.fired.setDelivery(firedId, delivery, note, { title, text });
  };
  let noted = false;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && reminder.current) {
      const now = reminder.current();
      if (!now) {
        track("withdrawn", "Not retried: what it reminds about was deleted or moved since.");
        hub.log("info", `${label} was not retried: it was deleted or moved since.`);
        return;
      }
      ({ title, text } = now);
    }
    const result = await channel.send(title, text).catch((e: unknown): SendResult => ({ ok: false, message: String(e) }));
    if (result.ok) {
      track("sent");
      hub.log("info", `${label} sent to the owner on Discord${attempt ? ` (attempt ${attempt + 1})` : ""}.`);
      return;
    }
    if (!noted) {
      noted = true;
      channel.fallback(title, text, result.message);
    }
    const wait = retryMs[attempt];
    if (wait === undefined) {
      track("failed", `${result.message} It is on the note list instead.`);
      hub.log("error", `${label} could not be sent on Discord after ${attempt + 1} attempts: ${result.message} It is on the note list instead.`);
      return;
    }
    track("retrying", `${result.message} It is on the note list; retrying in ${Math.round(wait / 1000)}s.`);
    hub.log("warn", `${label} was not sent on Discord: ${result.message} It is on the note list; retrying in ${Math.round(wait / 1000)}s.`);
    await new Promise((r) => setTimeout(r, wait));
  }
}
