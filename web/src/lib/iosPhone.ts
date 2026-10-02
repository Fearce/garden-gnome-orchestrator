// The layered task navigation (lib/navHistory.ts, LayerClose.tsx and the `.ios-phone` rules in
// styles.css) is scoped to iPhones by the owner's call. Android phones, tablets and desktop keep the
// console's original controls and do not get history entries. iOS Chrome and Firefox are Safari
// underneath and say "iPhone" too; an iPad identifies as a Mac, so it is not caught here.
export const IOS_PHONE = typeof navigator !== "undefined" && /iPhone|iPod/.test(navigator.userAgent);

/** Marks the document so the stylesheet can scope the phone layer rules to iPhones. */
export function markIosPhone(): void {
  if (IOS_PHONE) document.documentElement.classList.add("ios-phone");
}
