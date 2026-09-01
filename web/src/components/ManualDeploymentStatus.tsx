import type { ManualDeploymentSummary } from "../types.js";

export function ManualDeploymentBadge({ deployment }: { deployment?: ManualDeploymentSummary | null }) {
  if (deployment?.status !== "verified") return null;
  return (
    <span
      className="manual-deployment-badge"
      title={`Complete in GGO. Manual deployment to ${deployment.environment} remains pending.`}
    >
      Deploy pending
    </span>
  );
}

export function ManualDeploymentHandoff({ deployment }: { deployment?: ManualDeploymentSummary | null }) {
  if (deployment?.status !== "verified") return null;
  return (
    <section className="manual-deployment-handoff" aria-label="Manual deployment handoff">
      <div className="manual-deployment-title">Complete in GGO</div>
      <div className="manual-deployment-copy">
        Manual deployment to <strong>{deployment.environment}</strong> remains pending for verified commit{" "}
        <code>{deployment.commitSha.slice(0, 12)}</code>.
      </div>
      <div className="manual-deployment-instructions">{deployment.instructions}</div>
    </section>
  );
}
