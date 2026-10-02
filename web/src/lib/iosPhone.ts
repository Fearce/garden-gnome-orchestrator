// The layered task navigation (lib/navHistory.ts, LayerClose.tsx and the `.ios-phone` rules in
// styles.css) is scoped to iPhones by the owner's call. Android phones, tablets and desktop keep the
// console's original controls and do not get history entries. iOS Chrome and Firefox are Safari
// underneath and say "iPhone" too; an iPad identifies as a Mac, so it is not caught here.
export const IOS_PHONE = typeof navigator !== "undefined" && /iPhone|iPod/.test(navigator.userAgent);

/** Marks the document so the stylesheet can scope the phone layer rules to iPhones. */
export function markIosPhone(): void {
  if (IOS_PHONE) document.documentElement.classList.add("ios-phone");
}

/** iOS keyboards can shrink/pan only the visual viewport; 100dvh still covers the keyboard.
 * Keep task layers inside the visible rectangle, without changing Android/tablet/desktop layout.
 * Ignore pinch zoom so zoomed content stays scrollable rather than continually reflowing. */
export function installIosViewport(): (() => void) | undefined {
  if (!IOS_PHONE || !window.visualViewport) return;
  const viewport = window.visualViewport;
  const style = document.documentElement.style;
  const update = () => {
    if (viewport.scale !== 1) return;
    style.setProperty("--ios-visible-height", `${viewport.height}px`);
    style.setProperty("--ios-visible-top", `${viewport.offsetTop}px`);
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    style.removeProperty("--ios-visible-height");
    style.removeProperty("--ios-visible-top");
  };
}
