import { useEffect, useRef, useState, type ReactNode } from "react";
import { KeyboardSink, type ModifierCode } from "./keyboardSink.js";
import { RemoteSurface } from "./remoteSurface.js";
import { QUALITY_OPTIONS, type QualityId } from "./remoteApi.js";
import { StreamClient, decoderUnavailableReason, type StreamState } from "./streamClient.js";
import "./remote.css";

const PHASE_LABEL: Record<StreamState["phase"], string> = {
  connecting: "Connecting",
  starting: "Starting capture",
  streaming: "Live",
  retrying: "Restarting capture",
  reconnecting: "Reconnecting",
  replaced: "Taken over",
  failed: "Stopped",
  closed: "Disconnected",
};

const MODIFIERS: { code: ModifierCode; label: string }[] = [
  { code: "ControlLeft", label: "Ctrl" },
  { code: "AltLeft", label: "Alt" },
  { code: "ShiftLeft", label: "Shift" },
  { code: "MetaLeft", label: "Win" },
];

const SPECIAL_KEYS: { code: string; label: string; title: string }[] = [
  { code: "Escape", label: "Esc", title: "Escape" },
  { code: "Tab", label: "Tab", title: "Tab" },
  { code: "ArrowLeft", label: "←", title: "Left arrow" },
  { code: "ArrowUp", label: "↑", title: "Up arrow" },
  { code: "ArrowDown", label: "↓", title: "Down arrow" },
  { code: "ArrowRight", label: "→", title: "Right arrow" },
  { code: "Home", label: "Home", title: "Home" },
  { code: "End", label: "End", title: "End" },
  { code: "Delete", label: "Del", title: "Delete" },
  { code: "F5", label: "F5", title: "F5" },
];

/** The Remote control board tab: the PC's screen, live, with mouse, touch, and keyboard control. */
export function RemoteViewer() {
  const unavailable = decoderUnavailableReason();
  if (unavailable) {
    return (
      <div className="rc-empty">
        <h3>This browser can't show the PC</h3>
        <p>{unavailable}</p>
      </div>
    );
  }
  return <LiveViewer />;
}

function LiveViewer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<StreamClient | null>(null);
  const surfaceRef = useRef<RemoteSurface | null>(null);
  const keyboardRef = useRef<KeyboardSink | null>(null);
  const [state, setState] = useState<StreamState | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [latched, setLatched] = useState<ReadonlySet<ModifierCode>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const stage = stageRef.current!;
    const canvas = canvasRef.current!;
    const client = new StreamClient(canvas, setState);
    const send = client.send.bind(client);
    const keyboard = new KeyboardSink(inputRef.current!, send, setLatched);
    const surface = new RemoteSurface(stage, canvas, send, setZoomed, () => keyboard.focus());
    clientRef.current = client;
    surfaceRef.current = surface;
    keyboardRef.current = keyboard;
    client.start();
    const onFullscreen = () => setFullscreen(document.fullscreenElement === stage.parentElement);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      surface.dispose();
      keyboard.dispose();
      client.stop();
    };
  }, []);

  const videoSize = state?.videoSize;
  useEffect(() => {
    if (videoSize) surfaceRef.current?.setVideoSize(videoSize);
  }, [videoSize]);

  const client = clientRef.current;
  const phase = state?.phase ?? "connecting";
  const toggleKeyboard = () => {
    if (keysOpen) inputRef.current?.blur();
    else keyboardRef.current?.focus();
    setKeysOpen(!keysOpen);
  };

  return (
    <div className="rc-viewer">
      <div className="rc-bar" role="toolbar" aria-label="Remote control">
        <span className={`rc-status rc-status-${phase}`} title={state?.message ?? undefined}>
          <span className="rc-dot" aria-hidden />
          {PHASE_LABEL[phase]}
          {phase === "streaming" && state ? <span className="rc-metrics mono">{state.rttMs ?? "–"} ms · {state.fps} fps</span> : null}
        </span>
        <div className="rc-bar-controls">
          {state && state.displays.length > 1 ? (
            <select className="rc-select" aria-label="Display" value={state.display} onChange={(e) => client?.send({ t: "display", index: Number(e.target.value) })}>
              {state.displays.map((d) => <option key={d.index} value={d.index}>Display {d.index + 1} · {d.width}×{d.height}{d.primary ? " (main)" : ""}</option>)}
            </select>
          ) : null}
          <select className="rc-select" aria-label="Quality" value={state?.quality ?? "smooth"} onChange={(e) => client?.send({ t: "quality", id: e.target.value as QualityId })}>
            {QUALITY_OPTIONS.map((q) => <option key={q.id} value={q.id} title={q.hint}>{q.label}</option>)}
          </select>
          <IconButton label="Keyboard" pressed={keysOpen} onClick={toggleKeyboard}><KeyboardIcon /></IconButton>
          <IconButton label="Clipboard" pressed={clipboardOpen} onClick={() => setClipboardOpen((open) => !open)}><ClipboardIcon /></IconButton>
          {zoomed ? <IconButton label="Fit to screen" onClick={() => surfaceRef.current?.resetZoom()}><FitIcon /></IconButton> : null}
          <IconButton label={fullscreen ? "Exit full screen" : "Full screen"} onClick={() => toggleFullscreen(stageRef.current?.parentElement ?? null)}><FullscreenIcon exit={fullscreen} /></IconButton>
        </div>
      </div>

      {keysOpen ? (
        <div className="rc-keys" role="group" aria-label="Special keys">
          {MODIFIERS.map((m) => (
            <button key={m.code} type="button" className={"rc-key" + (latched.has(m.code) ? " on" : "")} aria-pressed={latched.has(m.code)}
              onPointerDown={(e) => e.preventDefault()} onClick={() => keyboardRef.current?.toggleModifier(m.code)}>{m.label}</button>
          ))}
          <span className="rc-keys-gap" />
          {SPECIAL_KEYS.map((k) => (
            <button key={k.code} type="button" className="rc-key" title={k.title}
              onPointerDown={(e) => e.preventDefault()} onClick={() => keyboardRef.current?.pressKey(k.code)}>{k.label}</button>
          ))}
        </div>
      ) : null}

      {clipboardOpen && client ? <ClipboardPanel client={client} onClose={() => setClipboardOpen(false)} /> : null}

      {state?.inputBlocked ? (
        <div className="rc-banner" role="status">
          The PC is ignoring input. A window running as administrator, or a Windows security prompt, has focus.
          {state.elevated ? "" : " GGO runs without admin rights, so it can't control those windows."}
        </div>
      ) : null}

      <div className="rc-stage" ref={stageRef}>
        <canvas className="rc-canvas" ref={canvasRef} />
        {phase !== "streaming" ? <StageOverlay state={state} onRetry={() => client?.retry()} /> : null}
      </div>
      <textarea ref={inputRef} className="rc-sink" aria-label="Type on the PC" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
    </div>
  );
}

function StageOverlay({ state, onRetry }: { state: StreamState | null; onRetry: () => void }) {
  const phase = state?.phase ?? "connecting";
  const needsRetry = phase === "replaced" || phase === "failed";
  return (
    <div className="rc-overlay">
      <div className="rc-overlay-card">
        <strong>{PHASE_LABEL[phase]}{needsRetry ? "" : "…"}</strong>
        {state?.message ? <p>{state.message}</p> : null}
        {needsRetry ? <button type="button" className="btn primary sm" onClick={onRetry}>{phase === "replaced" ? "Take control here" : "Try again"}</button> : null}
      </div>
    </div>
  );
}

function ClipboardPanel({ client, onClose }: { client: StreamClient; onClose: () => void }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await action());
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fromPc = () => run(async () => {
    const value = await client.readClipboard();
    setText(value);
    const copied = await navigator.clipboard?.writeText(value).then(() => true, () => false);
    return copied ? "Copied the PC clipboard to this device." : "Here is the PC clipboard. Select it to copy.";
  });
  const toPc = () => run(async () => {
    await client.writeClipboard(text);
    return "The PC clipboard now holds this text. Press Ctrl+V on the PC to paste it.";
  });
  const typeIt = () => run(async () => {
    client.send({ t: "text", text });
    return "Typed on the PC.";
  });
  return (
    <div className="rc-clip" role="dialog" aria-label="Clipboard">
      <textarea className="rc-clip-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste or write text here to send it to the PC" rows={3} />
      <div className="rc-clip-actions">
        <button type="button" className="btn sm" disabled={busy} onClick={fromPc}>Get PC clipboard</button>
        <button type="button" className="btn sm" disabled={busy || !text} onClick={toPc}>Send to PC clipboard</button>
        <button type="button" className="btn sm" disabled={busy || !text} onClick={typeIt}>Type it on the PC</button>
        <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>
      </div>
      {note ? <p className="rc-clip-note">{note}</p> : null}
    </div>
  );
}

function toggleFullscreen(element: HTMLElement | null): void {
  if (!element) return;
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  void element.requestFullscreen().then(() => {
    // Fullscreen lets a desktop browser hand Esc, Alt+Tab and friends to the PC instead of acting on them.
    const keyboard = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard;
    return keyboard?.lock?.().catch(() => undefined);
  }, () => undefined);
}

function IconButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={"rc-icon" + (pressed ? " on" : "")} aria-label={label} title={label} aria-pressed={pressed} onPointerDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function KeyboardIcon() {
  return <svg {...iconProps}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>;
}

function ClipboardIcon() {
  return <svg {...iconProps}><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></svg>;
}

function FitIcon() {
  return <svg {...iconProps}><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>;
}

function FullscreenIcon({ exit }: { exit: boolean }) {
  return exit
    ? <svg {...iconProps}><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" /></svg>
    : <svg {...iconProps}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>;
}
