import type { TitleBarStyle } from "./contract";

const MIN_HEIGHT = 28;
const MAX_HEIGHT = 64;
const HEX = /^#[0-9a-f]{6}$/i;
const RGB = /^rgb\((\d{1,3}), ?(\d{1,3}), ?(\d{1,3})\)$/;

function isPlainColor(value: string): boolean {
  if (HEX.test(value)) return true;
  const channels = RGB.exec(value);
  return !!channels && channels.slice(1).every((channel) => Number(channel) <= 255);
}

/** A page-reported style, or null unless every field is something the OS API can take as-is. */
export function parseTitleBarStyle(input: unknown): TitleBarStyle | null {
  const value = input as Partial<TitleBarStyle> | null;
  if (!value || typeof value.background !== "string" || typeof value.symbol !== "string" || typeof value.height !== "number") return null;
  if (!isPlainColor(value.background) || !isPlainColor(value.symbol)) return null;
  if (!Number.isInteger(value.height) || value.height < MIN_HEIGHT || value.height > MAX_HEIGHT) return null;
  return { background: value.background, symbol: value.symbol, height: value.height };
}
