import type { ModelRequest } from "../types.js";
import { modelLabel } from "../lib/format.js";

function normalized(model: string | null | undefined): string {
  return (model ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function requestedModelMatches(request: ModelRequest, actualModel?: string | null): boolean | null {
  if (!request.model || !actualModel) return null;
  return normalized(request.model) === normalized(actualModel);
}

export function ModelRequestStatus({
  request,
  actualModel,
  compact = false,
}: {
  request?: ModelRequest | null;
  actualModel?: string | null;
  compact?: boolean;
}) {
  if (!request) return null;
  const requested = modelLabel(request.model) || request.requested;
  const actual = actualModel ? modelLabel(actualModel) : null;
  const matches = requestedModelMatches(request, actualModel);
  const state = matches === false ? " mismatch" : request.model ? " pinned" : " unresolved";
  const title = request.model
    ? `Strict owner model request: ${request.requested} → ${request.model}.${actual ? ` Actual runtime: ${actualModel}.` : " Waiting to start."}${matches === false ? " Runtime mismatch — this task must not continue on that model." : " No fallback model is allowed."}`
    : `Strict owner model request: ${request.requested}. It could not be resolved, so the task is blocked rather than downgraded.`;

  if (compact) {
    return (
      <span className={`model-pin-badge${state}`} title={title} data-requested-model={request.model ?? request.requested} data-actual-model={actualModel ?? ""}>
        Pin · {requested}
      </span>
    );
  }

  return (
    <div className={`model-request-status${state}`} title={title} data-requested-model={request.model ?? request.requested} data-actual-model={actualModel ?? ""}>
      <span className="model-request-key">Requested model</span>
      <span className="model-request-value">{requested}</span>
      <span className="model-request-sep">·</span>
      <span className="model-request-actual">
        {actual ? `actual ${actual}` : request.model ? "waiting to start" : "unresolved — blocked"}
      </span>
      {matches === false ? <span className="model-request-alert">Mismatch — stopped</span> : <span className="model-request-strict">strict</span>}
    </div>
  );
}
