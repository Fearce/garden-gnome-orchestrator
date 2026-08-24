import "./diff.css";

/**
 * The unified-diff renderer, shared by both git surfaces: the per-task Changes drawer
 * (`GitChanges.tsx`) and the repo-level Git console (`GitConsole.tsx`). One implementation, so a diff
 * reads identically wherever it appears.
 */

interface DLine {
  t: "ctx" | "add" | "del";
  text: string;
}

interface DHunk {
  oldStart: number;
  newStart: number;
  label?: string;
  lines: DLine[];
}

/** Parse a raw unified diff (git's textual output) into hunks. File headers (diff --git / index / --- /
 *  +++) precede the first @@ so they're skipped while `cur` is null; "\ No newline" markers are dropped. */
function parseUnifiedDiff(patch: string): DHunk[] {
  const hunks: DHunk[] = [];
  let cur: DHunk | null = null;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      if (m) {
        cur = { oldStart: Number.parseInt(m[1]!, 10), newStart: Number.parseInt(m[2]!, 10), label: (m[3] ?? "").trim() || undefined, lines: [] };
        hunks.push(cur);
      }
      continue;
    }
    if (!cur) continue; // still in the file header block
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const c = raw[0];
    if (c === "+") cur.lines.push({ t: "add", text: raw.slice(1) });
    else if (c === "-") cur.lines.push({ t: "del", text: raw.slice(1) });
    else cur.lines.push({ t: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return hunks;
}

/** A unified diff, rendered from the parsed hunks. Line numbers on both sides are computed while walking
 *  each hunk (context advances both, an add advances only new, a del only old) so the gutters stay
 *  self-consistent. Add/remove lines get the conventional green/red tint. */
export function Diff({ patch, truncated }: { patch: string; truncated: boolean }) {
  const hunks = parseUnifiedDiff(patch);
  return (
    <div className="diff">
      {hunks.length === 0 ? <div className="diff-note">No textual changes.</div> : null}
      {hunks.map((h, hi) => {
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        const oldLen = h.lines.filter((l) => l.t !== "add").length;
        const newLen = h.lines.filter((l) => l.t !== "del").length;
        return (
          <div className="diff-hunk" key={hi}>
            <div className="diff-hunk-head">
              <span className="diff-range">
                @@ -{h.oldStart},{oldLen} +{h.newStart},{newLen} @@
              </span>
              {h.label ? <span className="diff-label">{h.label}</span> : null}
            </div>
            {h.lines.map((l, li) => {
              const oldCell = l.t === "add" ? "" : String(oldNo++);
              const newCell = l.t === "del" ? "" : String(newNo++);
              const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
              return (
                <div className={"diff-line " + l.t} key={li}>
                  <span className="diff-gutter old">{oldCell}</span>
                  <span className="diff-gutter new">{newCell}</span>
                  <span className="diff-sign" aria-hidden="true">
                    {sign}
                  </span>
                  <span className="diff-text">{l.text || " "}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {truncated ? <div className="diff-note">Diff truncated — this file is very large. Open it in your editor to see the rest.</div> : null}
    </div>
  );
}
