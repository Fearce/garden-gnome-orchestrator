import { useMemo, useState } from "react";
import { useStore } from "../store.js";
import type { Question } from "../types.js";

export function QuestionModal() {
  const questions = useStore((s) => s.questions);
  const answer = useStore((s) => s.answer);
  const q = useMemo(() => questions.find((x) => x.threadId === null) ?? questions[0], [questions]);
  if (!q) return null;
  return <QuestionCard key={q.id} q={q} onAnswer={(a) => answer(q.id, a)} />;
}

function QuestionCard({ q, onAnswer }: { q: Question; onAnswer: (a: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(q.options.length === 0);

  const toggle = (label: string) => {
    if (q.multiSelect) {
      setSelected((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]));
    } else {
      onAnswer(label);
    }
  };

  const submit = () => {
    const parts = [...selected];
    const c = custom.trim();
    if (c) parts.push(c);
    if (parts.length) onAnswer(parts.join(", "));
  };

  const canSubmit = selected.length > 0 || custom.trim().length > 0;
  const showFooter = q.multiSelect || showCustom;

  return (
    <div className="scrim">
      <div className="modal">
        <div className="m-head">
          <span className="chip">{q.header}</span>
          <h3>{q.question}</h3>
        </div>
        <div className="m-body">
          {q.options.map((o) => (
            <button
              key={o.label}
              className={"opt" + (selected.includes(o.label) ? " sel" : "")}
              onClick={() => toggle(o.label)}
            >
              <div className="lbl">{o.label}</div>
              {o.description ? <div className="desc">{o.description}</div> : null}
            </button>
          ))}

          {showCustom ? (
            <textarea
              autoFocus
              value={custom}
              placeholder={q.options.length ? "Or type your own answer…" : "Type your answer…"}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          ) : (
            <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setShowCustom(true)}>
              Other…
            </button>
          )}

          {showFooter ? (
            <div className="m-foot">
              <button className="btn primary" onClick={submit} disabled={!canSubmit}>
                Submit
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
