import { memo, type ReactNode } from "react";

// Tiny, dependency-free markdown renderer for agent output bodies.
// Handles the subset agents actually emit: headings, bold/italic, inline code,
// fenced + indented code, ordered/unordered lists, blockquotes, hr, links.
// Everything is real React text nodes — no dangerouslySetInnerHTML.

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    const key = `${keyBase}-${i++}`;
    if (part.startsWith("`") && part.endsWith("`")) {
      out.push(<code key={key} className="md-code">{part.slice(1, -1)}</code>);
    } else if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      out.push(<strong key={key}>{part.slice(2, -2)}</strong>);
    } else if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
      out.push(<em key={key}>{part.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) {
        out.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>,
        );
      } else {
        out.push(part);
      }
    }
  }
  return out;
}

// A GFM table delimiter row: | --- | :--: | ---: | (dashes, optional colons, pipes).
const TABLE_DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

// Split a "| a | b |" row into trimmed cells, dropping the empty edges from leading/trailing pipes.
function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|");
  return cells.map((c) => c.trim());
}

function MarkdownImpl({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++; // closing fence
      blocks.push(
        <pre key={key++} className="md-pre">
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        <div key={key++} className={`md-h md-h${level}`}>
          {renderInline(heading[2]!, `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderInline(buf.join(" "), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // GFM table: a header row followed by a delimiter row, then zero+ body rows.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!)) {
      const header = splitRow(line);
      i += 2; // header + delimiter
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      blocks.push(
        <table key={key++} className="md-table">
          <thead>
            <tr>
              {header.map((h, c) => (
                <th key={c}>{renderInline(h, `th${key}-${c}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {header.map((_, c) => (
                  <td key={c}>{renderInline(row[c] ?? "", `td${key}-${r}-${c}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // Lists (grouped runs of adjacent list items)
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        const content = lines[i]!.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
        items.push(<li key={items.length}>{renderInline(content, `li${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(
        ordered ? (
          <ol key={key++} className="md-list">{items}</ol>
        ) : (
          <ul key={key++} className="md-list">{items}</ul>
        ),
      );
      continue;
    }

    // Paragraph (consume consecutive non-blank, non-block lines)
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*```/.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]!) &&
      !/^\s*(?:[-*_]\s*){3,}$/.test(lines[i]!) &&
      !(lines[i]!.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!))
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(buf.join("\n"), `p${key}`)}
      </p>,
    );
  }

  return <div className={className ? `md ${className}` : "md"}>{blocks}</div>;
}

export const Markdown = memo(MarkdownImpl);
