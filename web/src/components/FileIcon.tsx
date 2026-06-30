// Inline-SVG file icons (no emoji — intentional, on-theme) keyed by a coarse file "kind" derived from
// the extension. Icons stroke with currentColor so the card/theme controls their colour. The same
// `fileKindOf` classifier drives the deliverable preview modal's rendering choice.

export type FileKind = "markdown" | "json" | "csv" | "code" | "image" | "pdf" | "text" | "binary";

const EXT_KIND: Record<string, FileKind> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  csv: "csv",
  tsv: "csv",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  pdf: "pdf",
  txt: "text",
  log: "text",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cs: "code",
  sh: "code",
  bash: "code",
  ps1: "code",
  sql: "code",
  html: "code",
  css: "code",
  yml: "code",
  yaml: "code",
  xml: "code",
  toml: "code",
};

/** The trailing path segment (filename) of a forward- or back-slash path. */
export function basenameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Lowercased file extension without the dot, or "" if none. */
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function fileKindOf(name: string): FileKind {
  return EXT_KIND[extOf(name)] ?? "binary";
}

/** Whether a deliverable kind can be previewed inline (everything but opaque binaries). */
export function isPreviewable(kind: FileKind): boolean {
  return kind !== "binary";
}

export function FileIcon({ kind, size = 22 }: { kind: FileKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  // A document silhouette with a folded corner is the shared base; the inner glyph distinguishes kinds.
  const page = (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </>
  );
  switch (kind) {
    case "markdown":
      return (
        <svg {...common} aria-hidden="true">
          {page}
          <path d="M7.5 16v-3l1.4 1.6L10.3 13v3" />
          <path d="M13.4 13v3M13.4 16l1.3-1.4M13.4 16l-1.3-1.4" />
        </svg>
      );
    case "json":
      return (
        <svg {...common} aria-hidden="true">
          {page}
          <path d="M10 12.2c-1 0-1.2.5-1.2 1.1s.2 1.1-.8 1.1c1 0 .8.5.8 1.1s.2 1.1 1.2 1.1" />
          <path d="M14 12.2c1 0 1.2.5 1.2 1.1s-.2 1.1.8 1.1c-1 0-.8.5-.8 1.1s-.2 1.1-1.2 1.1" />
        </svg>
      );
    case "csv":
      return (
        <svg {...common} aria-hidden="true">
          {page}
          <rect x="7" y="12" width="10" height="6" rx="0.5" />
          <path d="M7 15h10M12 12v6" />
        </svg>
      );
    case "code":
      return (
        <svg {...common} aria-hidden="true">
          {page}
          <path d="M10 13l-1.8 1.8L10 16.6" />
          <path d="M14 13l1.8 1.8L14 16.6" />
        </svg>
      );
    case "image":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="M21 16l-5-5L5 20" />
        </svg>
      );
    case "pdf":
      return (
        <svg {...common} aria-hidden="true">
          {page}
          <path d="M8 14h1.2a1 1 0 0 1 0 2H8zM8 14v3" />
          <path d="M12.4 14v3h.8a1.2 1.2 0 0 0 0-3zM15.8 17v-3h1.4M15.8 15.5h1.1" />
        </svg>
      );
    default:
      return (
        <svg {...common} aria-hidden="true">
          {page}
        </svg>
      );
  }
}
