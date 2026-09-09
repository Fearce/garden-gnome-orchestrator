import { createHash } from "node:crypto";
import type { Db, OwnerCommandReceipt } from "../db/db.js";
import type { ThreadActionResult } from "../orchestrator/api.js";
import type { ImageAttachment } from "../types.js";

export interface ThreadInjectionCommand {
  threadId: string;
  message: string;
  mode: "append" | "interrupt" | "queue";
  recipient?: "implementor" | "qa" | "reviewer";
  images?: ImageAttachment[];
  clientId?: string;
}

export interface ThreadInjectionTarget {
  injectThread(
    threadId: string,
    message: string,
    mode: ThreadInjectionCommand["mode"],
    images?: ImageAttachment[],
    options?: { recipient?: ThreadInjectionCommand["recipient"] },
  ): Promise<ThreadActionResult>;
}

/** Stable across processes, including image bytes, so a reused UUID cannot acknowledge different work. */
export function threadInjectionPayloadHash(command: ThreadInjectionCommand): string {
  return createHash("sha256")
    .update(JSON.stringify({
      threadId: command.threadId,
      message: command.message,
      mode: command.mode,
      recipient: command.recipient ?? null,
      images: command.images ?? [],
    }))
    .digest("hex");
}

const inFlight = new Map<string, Promise<ThreadActionResult>>();

function completedResult(receipt: OwnerCommandReceipt): ThreadActionResult | null {
  if (receipt.status !== "completed" || !receipt.result || typeof receipt.result !== "object") return null;
  const result = receipt.result as Partial<ThreadActionResult>;
  return typeof result.ok === "boolean" ? result as ThreadActionResult : null;
}

function acceptedAfterRestart(db: Db, receipt: OwnerCommandReceipt): ThreadActionResult {
  const thread = db.getThread(receipt.threadId);
  const result: ThreadActionResult = thread
    ? {
        ok: true,
        state: thread.state,
        message: "Instruction was durably accepted before reconnect; its persisted task intent remains available during recovery.",
      }
    : { ok: false, error: "The task was removed after this instruction was accepted." };
  db.completeOwnerCommandReceipt(receipt.clientId, result);
  return result;
}

/**
 * Execute one task injection under a durable browser correlation id.
 *
 * `ThreadManager.injectThread` records the standing directive before its first await. We mark the receipt
 * accepted immediately after invoking it, so a process death can lose the final WebSocket response but not
 * the owner's intent. Replaying an accepted receipt after boot acknowledges that durable intent without
 * steering the new run twice; a fully completed receipt returns its exact original result.
 */
export async function injectThreadWithReceipt(
  db: Db,
  target: ThreadInjectionTarget,
  command: ThreadInjectionCommand,
): Promise<ThreadActionResult> {
  if (!command.clientId) {
    return target.injectThread(command.threadId, command.message, command.mode, command.images, {
      recipient: command.recipient,
    });
  }
  // The receipt has a foreign key to its task. Preserve the ordinary control result instead of turning
  // a stale browser tab's command into a constraint exception before ThreadManager can reject it.
  if (!db.getThread(command.threadId)) return { ok: false, error: "No such task." };

  const claim = db.claimOwnerCommandReceipt({
    clientId: command.clientId,
    command: "thread.inject",
    threadId: command.threadId,
    payloadHash: threadInjectionPayloadHash(command),
  });
  if (claim.kind === "conflict") {
    return { ok: false, error: "This delivery id was already used for a different task instruction." };
  }
  const completed = completedResult(claim.receipt);
  if (completed) return completed;

  const running = inFlight.get(command.clientId);
  if (running) return running;
  if (claim.receipt.status === "accepted") return acceptedAfterRestart(db, claim.receipt);

  const operation = (async (): Promise<ThreadActionResult> => {
    try {
      // Calling an async method executes its synchronous prefix now. That prefix persists the task's
      // standing directive before any state-specific await, which is the durable acceptance boundary.
      const resultPromise = target.injectThread(command.threadId, command.message, command.mode, command.images, {
        recipient: command.recipient,
      });
      db.acceptOwnerCommandReceipt(command.clientId!);
      const result = await resultPromise;
      db.completeOwnerCommandReceipt(command.clientId!, result);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ThreadActionResult;
      db.completeOwnerCommandReceipt(command.clientId!, result);
      return result;
    }
  })();
  inFlight.set(command.clientId, operation);
  void operation.then(
    () => { if (inFlight.get(command.clientId!) === operation) inFlight.delete(command.clientId!); },
    () => { if (inFlight.get(command.clientId!) === operation) inFlight.delete(command.clientId!); },
  );
  return operation;
}
