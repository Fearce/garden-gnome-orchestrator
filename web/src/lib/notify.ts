// Desktop notification + sound when a task needs you or finishes, so you don't
// have to watch the tab. Opt-in (a topbar bell toggles it, persisted locally).
const KEY = "orch-notify";
let audioCtx: AudioContext | null = null;

export function notifyEnabled(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  if (on && "Notification" in window && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
  }
  // Unlock audio on the enabling click (autoplay policy needs a user gesture).
  if (on) beep(0.0001);
  localStorage.setItem(KEY, on ? "1" : "0");
  return on;
}

export function notify(title: string, body: string): void {
  if (!notifyEnabled()) return;
  beep();
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, tag: "orch", icon: "/favicon.ico" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    /* notifications unavailable */
  }
}

function beep(gain = 0.16): void {
  try {
    audioCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    // two short rising tones
    [880, 1175].forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = "sine";
      o.frequency.value = freq;
      const t = now + i * 0.13;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.start(t);
      o.stop(t + 0.13);
    });
  } catch {
    /* no audio */
  }
}
