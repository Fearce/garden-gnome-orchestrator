import type { Thread } from "../types.js";

// The persisted contract between a boot that interrupted a task and every later reader (the next boot, a
// lead or parent waiting at its barrier, the resume seed). These are what a restart writes into a
// thread's `error`, and they outlive the process that wrote them.

/** Shared prefix for every "a server restart killed this thread" error, so a resume can recognise a
 *  restart-triggered run from the thread's persisted error alone. */
export const RESTART_ERROR_PREFIX = "interrupted by a server restart";
export const RESTART_AUTO_RESUME_MSG = `${RESTART_ERROR_PREFIX} — auto-resuming…`;
/** The same promise, held back because a Co-worker turn owns the workspace; it fires when that turn ends. */
export const RESTART_COWORK_WAIT_MSG =
  `${RESTART_ERROR_PREFIX} — auto-resume is waiting for the Co-worker turn using this workspace to finish…`;
/** The task was blocked on an ask_user question. The question stays open and answering it resumes the task. */
export const RESTART_AWAITING_ANSWER_MSG =
  `${RESTART_ERROR_PREFIX} while it was waiting for your answer — answer the open question to resume it, ` +
  `or click Resume to continue without an answer.`;

const OWED: ReadonlySet<string> = new Set([RESTART_AUTO_RESUME_MSG, RESTART_COWORK_WAIT_MSG, RESTART_AWAITING_ANSWER_MSG]);

/** A restart parked this task as 'failed', but it is still on its way back: an automatic resume is owed, or
 *  its question is still waiting for an answer that resumes it. Anything waiting on such a task (a shotgun
 *  lead, a sub-task's parent) must treat it as still running, not as a finished failure. */
export function restartResumePending(thread: Pick<Thread, "state" | "error">): boolean {
  return thread.state === "failed" && OWED.has(thread.error ?? "");
}

/** The subset a boot fires by itself, without waiting for the owner. */
export function restartAutoResumeOwed(thread: Pick<Thread, "state" | "error">): boolean {
  return restartResumePending(thread) && thread.error !== RESTART_AWAITING_ANSWER_MSG;
}
