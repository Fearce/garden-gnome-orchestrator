import { useEffect } from "react";

/** An iPhone's one way out of a layer over a task (work memo, deliverable preview, diff): a labelled
 *  Close docked at the bottom, in the same thumb corner as the task's own Close. Before this, each
 *  layer had its own small ✕ at the top, under the status bar, and the task's sat at the bottom, so
 *  the exit moved every time the owner went one level deeper. Every other device hides the bar and
 *  keeps each layer's ✕ in its header (`.ios-phone` rules in styles.css). */
export function LayerCloseBar({ onClose }: { onClose: () => void }) {
  return (
    <div className="layer-bar">
      <button type="button" className="layer-close" onClick={onClose}>
        <span aria-hidden="true">✕</span>
        Close
      </button>
    </div>
  );
}

/** Escape closes the layer while `onClose` is set. */
export function useLayerEscape(onClose: (() => void) | null) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}
