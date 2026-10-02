import type { Db } from "../../db/db.js";
import type { EventHub } from "../../events.js";
import type { RelaySharePresent, ServerFrame } from "../onlineProtocol.js";
import { DirectorShareClient, availabilityText, type ShareClientFrame, type SharedDirectorAvailability, type SharedDirectorSelection } from "./client.js";
import { DirectorShareHost, type DirectorShareView, type ShareOutcome, type ShareTerms } from "./host.js";
import type { DirectorShareSubscription, ShareableEndpoint } from "./policy.js";
import type { ShareFetch } from "./providerCall.js";

/** Everything the settings panel and the Director chat show about sharing, both directions. */
export interface DirectorSharingDTO {
  /** Whether sharing can work at all from this console right now. */
  relay: "office-offline" | "relay-unsupported" | "ready";
  /** This console's own subscriptions and their sharing state (the donor side). */
  subscriptions: DirectorShareView[];
  /** What other consoles currently offer (the recipient side). */
  offers: RelaySharePresent[];
  /** The shared Director this console uses, if the owner picked one. */
  selection: (SharedDirectorSelection & { availability: SharedDirectorAvailability; detail: string }) | null;
}

export interface DirectorSharingDeps {
  db: Db;
  hub: EventHub;
  subscriptions: () => DirectorShareSubscription[];
  endpoint: (subscriptionId: string) => ShareableEndpoint | undefined;
  fetch?: ShareFetch;
  now?: () => number;
  /** The recipient's pick or what it points at may have changed (the Director re-reads its status). */
  selectionChanged?: () => void;
}

/** The office-facing surface OnlineOffice is wired to. Kept as callbacks so neither side imports the
 *  other's class (the same standalone rule OnlineOffice keeps toward ThreadManager). */
export interface ShareTransport {
  send: (frame: ShareClientFrame) => boolean;
  relayState: () => DirectorSharingDTO["relay"];
  instanceOnline: (instanceId: string) => boolean;
  refreshPresence: () => void;
}

/**
 * Director sharing on this console: the donor host (offering this machine's API-key subscriptions) and the
 * recipient client (using another machine's offer as this console's Director). One object so the office
 * has a single place to deliver `share.*` frames and the console a single DTO to render.
 */
export class DirectorSharing {
  readonly host: DirectorShareHost;
  readonly client: DirectorShareClient;
  private transport: ShareTransport | undefined;

  constructor(private readonly deps: DirectorSharingDeps) {
    const send = (frame: ShareClientFrame): boolean => this.transport?.send(frame) ?? false;
    this.host = new DirectorShareHost({
      db: deps.db,
      subscriptions: deps.subscriptions,
      endpoint: deps.endpoint,
      send,
      changed: () => {
        this.transport?.refreshPresence();
        this.broadcast();
      },
      fetch: deps.fetch,
      now: deps.now,
      log: (level, message) => deps.hub.log(level, message),
    });
    this.client = new DirectorShareClient({
      db: deps.db,
      send,
      relayState: () => this.transport?.relayState() ?? "office-offline",
      instanceOnline: (id) => this.transport?.instanceOnline(id) ?? false,
      changed: () => {
        this.broadcast();
        deps.selectionChanged?.();
      },
      now: deps.now,
    });
  }

  attachTransport(transport: ShareTransport): void {
    this.transport = transport;
  }

  start(): void {
    this.host.start();
  }

  dispose(): void {
    this.host.dispose();
    this.client.dispose();
  }

  // ---- the owner's controls (WS commands) ---------------------------------------------------------------

  share(subscriptionId: string, model: string, terms: ShareTerms): ShareOutcome {
    if (this.relayState() === "relay-unsupported") return { ok: false, error: "The office relay does not support Director sharing yet." };
    return this.host.share(subscriptionId, model, terms);
  }

  update(subscriptionId: string, terms: ShareTerms): ShareOutcome {
    return this.host.update(subscriptionId, terms);
  }

  stop(subscriptionId: string): ShareOutcome {
    return this.host.stop(subscriptionId);
  }

  use(instanceId: string, shareId: string): ShareOutcome {
    return this.client.select(instanceId, shareId);
  }

  useOwn(): void {
    this.client.clearSelection();
  }

  // ---- office traffic -----------------------------------------------------------------------------------

  /** Every `share.*` frame the relay delivers. */
  onFrame(frame: Extract<ServerFrame, { t: "share.call" | "share.reply" | "share.cancel" }>): void {
    if (frame.t === "share.call") {
      void this.host.handleCall(frame).catch((e: unknown) => {
        this.deps.hub.log("warn", `Director sharing: a shared call failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
        this.transport?.send({ t: "share.reply", to: frame.from, callId: frame.callId, ok: false, code: "provider-error", message: "The donor's machine failed to handle the request." });
      });
    } else if (frame.t === "share.reply") {
      this.client.handleReply(frame);
    } else {
      this.host.handleCancel(frame);
    }
  }

  onOffers(offers: RelaySharePresent[] | undefined): void {
    this.client.setOffers(offers);
  }

  onDisconnected(): void {
    this.client.disconnected();
  }

  // ---- views --------------------------------------------------------------------------------------------

  dto(): DirectorSharingDTO {
    const selection = this.client.selection();
    const availability = this.client.availability(selection);
    return {
      relay: this.relayState(),
      subscriptions: this.host.view(),
      offers: this.client.offers(),
      selection: selection && availability ? { ...selection, availability, detail: availabilityText(availability, selection) } : null,
    };
  }

  broadcast(): void {
    this.deps.hub.publish({ type: "director.sharing", sharing: this.dto() });
  }

  private relayState(): DirectorSharingDTO["relay"] {
    return this.transport?.relayState() ?? "office-offline";
  }
}
