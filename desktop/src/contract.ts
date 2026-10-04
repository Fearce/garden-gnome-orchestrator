/**
 * The whole surface between the main process and its two kinds of page. The preload may only `import type`
 * from here: a sandboxed preload cannot `require` local files, so channel names are literal types that the
 * compiler checks on both sides instead of shared constants.
 */

export type ConnectionPhase =
  /** Probing the server for the first time (or after the address changed). */
  | "connecting"
  /** Nothing answered; retrying on a backoff. */
  | "offline"
  /** This app launched a local server and is waiting for it to answer. */
  | "starting"
  /** A console page that was open stopped loading; retrying and returning to where it was. */
  | "lost"
  /** The window's renderer died. */
  | "crashed"
  /** Google sign-in continues in the system browser. */
  | "browser-sign-in";

export interface ConnectionView {
  phase: ConnectionPhase;
  server: string;
  /** The server is on this machine, so starting one is meaningful. */
  local: boolean;
  /** The GGO checkout a local server would be started from, when one was found. */
  checkout: string | null;
  /** The port that checkout's server listens on, when it isn't the address's port: starting it would
   *  never answer here, so the screen offers that address instead of Start. */
  checkoutPort: number | null;
  /** A system Node.js was found to run it. */
  nodeFound: boolean;
  /** Something that is not GGO answers at the address, so starting a server there would collide. */
  conflict: boolean;
  /** What went wrong last, in plain words. */
  detail: string | null;
  /** The server log to open when a start did not come up. */
  logPath: string | null;
  /** When the next automatic retry fires (epoch ms), while retrying. */
  retryAt: number | null;
  /** When this phase began (epoch ms), for the "starting" elapsed timer. */
  since: number;
}

/** Channels the connection screen (`ggo-app://shell/…`) may use. */
export type ConnectChannel =
  | "connect:state"
  | "connect:retry"
  | "connect:start-server"
  | "connect:set-server"
  | "connect:choose-checkout"
  | "connect:open-log"
  | "connect:back";

/** Channels the GGO console page may use. */
export type ConsoleChannel = "console:open-in-browser" | "console:title-bar";

/** Main → page pushes. */
export type PushChannel = "connect:view" | "console:open-thread";

/** The console's top bar, so the OS window buttons drawn over its right end match it. */
export interface TitleBarStyle {
  /** `#rrggbb` or `rgb(r, g, b)`: the OS API takes nothing richer. */
  background: string;
  symbol: string;
  /** The bar's height in CSS px, so the buttons fill one row of it. */
  height: number;
}

export interface SetServerResult {
  ok: boolean;
  error?: string;
}
