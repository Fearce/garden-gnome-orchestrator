import { useCallback, useEffect, useState } from "react";
import { Field, Icon, Loading, ModuleDialog, ModuleFrame, Notice } from "./ModuleFrame.js";
import { usePoll } from "./hooks.js";
import { ModuleRequestError, errorText, formatAgo, moduleJson } from "./moduleApi.js";

type Bridge = "auto" | "home-assistant" | "xiaomi-miio";
type Action = "start" | "pause" | "home" | "find";

interface Device {
  id: string;
  name: string;
  platform: Bridge;
  model: string;
  host: string;
  token: string;
  tokenSet: boolean;
  homeAssistantEntityId: string;
  homeAssistantDeviceId: string;
  refreshMs: number;
  location: string;
  statusNote: string;
}

interface HomeConfig {
  origin: string;
  importedAt: string | null;
  homeAssistant: { url: string; configDir: string };
  pythonPath: string;
  devices: Device[];
}

interface VacuumStatus {
  state: string | null;
  battery: number | null;
  chargeState: string | null;
  fanSpeed: string | null;
  waterLevel: string | null;
  error: string | null;
  cleanArea: string | null;
  cleanTime: string | null;
  friendlyName: string | null;
}

interface StatusAnswer {
  id: string;
  bridge: "home-assistant" | "xiaomi-miio";
  entityId: string | null;
  status: VacuumStatus | null;
  at: number;
}

interface HomeAssistantContainer {
  id: string;
  name: string;
  state: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface ContainerAnswer {
  container: HomeAssistantContainer | null;
  containerError: string | null;
}

interface HomeAssistantProbe extends ContainerAnswer {
  url: string;
  reachable: boolean;
  status: number | null;
  configDirFound: boolean;
}

/** While Home Assistant boots after a start it is re-checked this often, then at the calm pace again. */
const BOOTING_PROBE_MS = 5_000;
const CALM_PROBE_MS = 30_000;

const ACTIONS: { action: Action; label: string; icon: "play" | "pause" | "home" | "locate"; tone?: string }[] = [
  { action: "start", label: "Start", icon: "play", tone: "primary" },
  { action: "pause", label: "Pause", icon: "pause" },
  { action: "home", label: "Dock", icon: "home" },
  { action: "find", label: "Find", icon: "locate" },
];

const MODELS = ["xiaomi-g1", "mijia.vacuum.v2"];

export function Home() {
  return (
    <ModuleFrame id="home" title="Home" lede="Robot vacuums through Home Assistant or the vacuum's own local miIO link. Status refreshes only while this tab is open.">
      {() => <HomePanel />}
    </ModuleFrame>
  );
}

function HomePanel() {
  const config = usePoll((signal) => moduleJson<HomeConfig>("home", "/config", { signal }), null);
  const [editing, setEditing] = useState<HomeConfig | null>(null);
  const settings = config.data ? (
    <button className="btn ghost sm" onClick={() => setEditing(config.data)}>
      <Icon name="settings" size={13} /> Devices
    </button>
  ) : null;
  return (
    <>
      <div className="mod-head-actions">{settings}</div>
      {config.data ? (
        <HomeBody config={config.data} onEdit={() => setEditing(config.data)} />
      ) : config.error ? (
        <Notice tone="bad" title="The Home service could not be read" onRetry={() => void config.refresh()}>
          {errorText(config.error)}
        </Notice>
      ) : (
        <Loading label="Loading your devices…" />
      )}
      {editing ? (
        <SettingsDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await config.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function bridgeOf(device: Device): "home-assistant" | "xiaomi-miio" {
  if (device.platform !== "auto") return device.platform;
  return device.tokenSet ? "xiaomi-miio" : "home-assistant";
}

function HomeBody({ config, onEdit }: { config: HomeConfig; onEdit: () => void }) {
  const usesHomeAssistant = config.devices.some((device) => bridgeOf(device) === "home-assistant");
  const [fast, setFast] = useState(false);
  const probe = usePoll((signal) => moduleJson<HomeAssistantProbe>("home", "/home-assistant", { signal }), fast ? BOOTING_PROBE_MS : CALM_PROBE_MS, usesHomeAssistant);
  const homeAssistantDown = Boolean(usesHomeAssistant && probe.data && !probe.data.reachable);
  // Its container runs but Home Assistant does not answer yet: it is booting, so look again sooner.
  const booting = homeAssistantDown && probe.data?.container?.state === "running";
  useEffect(() => setFast(booting), [booting]);
  if (!config.devices.length) {
    return (
      <>
        {config.origin === "deck-unreachable" ? (
          <Notice tone="info" title="Nothing was imported">
            No Script Hub answered, so there were no Dashboard Deck devices to bring over. Add devices here; if the hub is running the next time this service starts and you have not saved anything yet, its devices are imported then.
          </Notice>
        ) : null}
        <div className="mod-empty">
          <p>No devices yet. Add a robot vacuum with its Home Assistant entity, or its local address and miIO token.</p>
          <button className="btn primary sm" onClick={onEdit}>
            <Icon name="plus" size={13} /> Add a device
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      {homeAssistantDown && probe.data ? (
        <HomeAssistantDown probe={probe.data} onRetry={() => void probe.refresh()} />
      ) : null}
      {usesHomeAssistant && probe.data?.reachable && !probe.data.configDirFound ? (
        <Notice tone="warn" title="Home Assistant's config folder is not set">
          GGO signs in to Home Assistant with the login stored in its config folder. Set the folder under Devices.
        </Notice>
      ) : null}
      <div className="home-grid">
        {config.devices.map((device) => (
          <DeviceCard key={device.id} device={device} homeAssistantDown={homeAssistantDown} />
        ))}
      </div>
    </>
  );
}

/**
 * Home Assistant is down. When a Docker container of the owner's runs it, the notice offers to start that
 * container; starting is his click, never a side effect of opening the tab.
 */
function HomeAssistantDown({ probe, onRetry }: { probe: HomeAssistantProbe; onRetry: () => void }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const container = probe.container;
  if (container?.state === "running") {
    return (
      <Notice tone="info" title="Home Assistant is starting…" onRetry={onRetry}>
        Its container <code>{container.name}</code> is running and Home Assistant is still loading, which usually takes under a minute. Devices come back by themselves once it answers at <code>{probe.url}</code>.
      </Notice>
    );
  }
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await moduleJson<ContainerAnswer>("home", "/home-assistant/start", { method: "POST", body: {} });
      onRetry();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };
  return (
    <Notice tone="warn" title="Home Assistant is not answering" onRetry={onRetry}>
      Nothing answers at <code>{probe.url}</code>.{" "}
      {container ? (
        <>
          Its Docker container <code>{container.name}</code> is {container.state}
          {container.finishedAt ? `, stopped ${formatAgo(container.finishedAt)}` : ""}. GGO does not start it on its own.
          <span className="home-ha-actions">
            <button className="btn primary sm" disabled={starting} onClick={() => void start()}>
              <Icon name="play" size={13} /> {starting ? "Starting Home Assistant…" : "Start Home Assistant"}
            </button>
            {error ? <span className="mod-dialog-error">{error}</span> : null}
          </span>
        </>
      ) : probe.containerError ? (
        <>Start Home Assistant on this PC; devices that use it come back on their next refresh. GGO could not check Docker for it: {probe.containerError}</>
      ) : (
        <>Start Home Assistant on this PC; devices that use it come back on their next refresh. No Docker container mounts its config folder, so GGO cannot start it for you.</>
      )}
    </Notice>
  );
}

/** The container that runs Home Assistant, with its start and stop. Read once when the dialog opens. */
function HomeAssistantService() {
  const answer = usePoll((signal) => moduleJson<ContainerAnswer>("home", "/home-assistant/container", { signal }), null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const container = answer.data?.container ?? null;
  const act = async (action: "start" | "stop") => {
    if (action === "stop" && !window.confirm(`Stop Home Assistant (${container?.name ?? "its container"})? Its automations and every device that uses it stop until you start it again.`)) return;
    setBusy(action);
    setError(null);
    try {
      await moduleJson<ContainerAnswer>("home", `/home-assistant/${action}`, { method: "POST", body: {} });
      await answer.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  let text: string;
  if (answer.error) text = `GGO could not check Docker: ${errorText(answer.error)}`;
  else if (!answer.data) text = "Checking Docker for Home Assistant's container…";
  else if (answer.data.containerError) text = `GGO could not check Docker: ${answer.data.containerError}`;
  else if (!container) text = "No Docker container mounts the saved config folder, so GGO only talks to Home Assistant and cannot start or stop it.";
  else text = `Runs in the Docker container ${container.name}, which is ${container.state}.`;
  return (
    <div className="home-ha-service">
      <span className="home-ha-service-text">{text}</span>
      {container ? (
        container.state === "running" ? (
          <button className="btn ghost sm" disabled={busy !== null} onClick={() => void act("stop")}>
            {busy === "stop" ? "Stopping…" : "Stop Home Assistant"}
          </button>
        ) : (
          <button className="btn primary sm" disabled={busy !== null} onClick={() => void act("start")}>
            <Icon name="play" size={13} /> {busy === "start" ? "Starting…" : "Start Home Assistant"}
          </button>
        )
      ) : null}
      {error ? <span className="mod-dialog-error">{error}</span> : null}
    </div>
  );
}

/** `homeAssistantDown` comes from the page's own probe, which already says so once for every device. */
function DeviceCard({ device, homeAssistantDown }: { device: Device; homeAssistantDown: boolean }) {
  const status = usePoll((signal) => moduleJson<StatusAnswer>("home", `/devices/${encodeURIComponent(device.id)}/status`, { signal }), device.refreshMs || null);
  const [running, setRunning] = useState<Action | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const bridge = status.data?.bridge ?? bridgeOf(device);
  const vacuum = status.data?.status ?? null;
  const unreachable = bridge === "home-assistant" && homeAssistantDown;

  const act = useCallback(
    async (action: Action, label: string) => {
      setRunning(action);
      setMessage(null);
      try {
        await moduleJson("home", `/devices/${encodeURIComponent(device.id)}/actions/${action}`, { method: "POST", body: {} });
        setMessage({ tone: "ok", text: `${label} sent.` });
        window.setTimeout(() => void status.refresh(), 2_000);
      } catch (error) {
        setMessage({ tone: "bad", text: errorText(error) });
      } finally {
        setRunning(null);
      }
    },
    [device.id, status],
  );

  return (
    <article className="home-card">
      <header className="home-card-head">
        <div>
          <h4>{device.name}</h4>
          <span className="mono faint">
            {[device.location, bridge === "home-assistant" ? status.data?.entityId || device.homeAssistantEntityId || "Home Assistant" : `miIO · ${device.host || "no address"}`].filter(Boolean).join(" · ")}
          </span>
        </div>
        <span className={`mod-badge mod-badge-${vacuum?.error && vacuum.error !== "none" ? "error" : vacuum?.state ? "running" : "stopped"}`}>{vacuum?.state ?? (status.loading ? "reading" : "unknown")}</span>
      </header>

      {status.error && !unreachable ? (
        <Notice tone="bad" title={status.error instanceof ModuleRequestError && status.error.upstreamDown ? "Home Assistant is not answering" : "Status could not be read"} onRetry={() => void status.refresh()}>
          {errorText(status.error)}
        </Notice>
      ) : null}

      <div className="home-hero">
        <Battery level={vacuum?.battery ?? null} />
        <dl className="home-stats">
          <Stat label="State" value={vacuum?.state} />
          <Stat label="Charge" value={vacuum?.chargeState} />
          <Stat label="Fan" value={vacuum?.fanSpeed} />
          <Stat label="Water" value={vacuum?.waterLevel} />
          <Stat label="Error" value={vacuum?.error} alert={Boolean(vacuum?.error && !/^(none|no error|ok)$/i.test(vacuum.error))} />
          {vacuum?.cleanArea ? <Stat label="Last area" value={vacuum.cleanArea} /> : null}
          {vacuum?.cleanTime ? <Stat label="Last time" value={vacuum.cleanTime} /> : null}
        </dl>
      </div>

      <div className="home-actions">
        {ACTIONS.map(({ action, label, icon, tone }) => (
          <button key={action} className={`btn sm${tone ? ` ${tone}` : ""}`} disabled={running !== null || unreachable} title={unreachable ? "Home Assistant is not answering" : undefined} onClick={() => void act(action, label)}>
            <Icon name={icon} size={13} /> {running === action ? `${label}…` : label}
          </button>
        ))}
        <button className="btn ghost sm" disabled={running !== null} onClick={() => void status.refresh()} aria-label="Refresh status">
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>

      <footer className="home-foot">
        {message ? <span className={message.tone === "ok" ? "ok" : "bad"}>{message.text}</span> : <span />}
        <span className="mono faint">
          {status.data ? `updated ${formatAgo(status.data.at)}` : "not read yet"}
          {device.refreshMs ? ` · every ${Math.round(device.refreshMs / 1000)}s` : " · manual refresh"}
        </span>
      </footer>
      {device.statusNote ? <p className="home-note">{device.statusNote}</p> : null}
    </article>
  );
}

function Battery({ level }: { level: number | null }) {
  const pct = level == null ? null : Math.max(0, Math.min(100, Math.round(level)));
  const tone = pct == null ? "" : pct < 20 ? " low" : pct < 50 ? " mid" : "";
  return (
    <div className={`home-battery${tone}`}>
      <span className="home-battery-value">{pct == null ? "—" : pct}</span>
      <span className="home-battery-unit">{pct == null ? "battery" : "% battery"}</span>
      <span className="home-battery-bar" aria-hidden="true">
        <span style={{ width: `${pct ?? 0}%` }} />
      </span>
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: string | null | undefined; alert?: boolean }) {
  return (
    <div className={alert ? "alert" : undefined}>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

function SettingsDialog({ initial, onClose, onSaved }: { initial: HomeConfig; onClose: () => void; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<HomeConfig>(() => structuredClone(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchDevice = (id: string, patch: Partial<Device>) => setDraft((d) => ({ ...d, devices: d.devices.map((device) => (device.id === id ? { ...device, ...patch } : device)) }));

  const addDevice = async () => {
    try {
      const { device } = await moduleJson<{ device: Device }>("home", "/devices/new");
      setDraft((d) => ({ ...d, devices: [...d.devices, device] }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await moduleJson("home", "/config", { method: "PUT", body: { homeAssistant: draft.homeAssistant, pythonPath: draft.pythonPath, devices: draft.devices } });
      await onSaved();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  return (
    <ModuleDialog
      title="Home devices"
      wide
      onClose={onClose}
      footer={
        <>
          {error ? <span className="mod-dialog-error">{error}</span> : null}
          <button className="btn ghost sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {initial.origin === "dashboard-deck" && initial.importedAt ? <p className="mod-dialog-lede">Imported from the Dashboard Deck {formatAgo(initial.importedAt)}. Changes save to GGO's own copy.</p> : null}
      <fieldset className="mod-fieldset">
        <legend>Home Assistant</legend>
        <div className="mod-fields">
          <Field label="Address">
            <input className="mod-input" value={draft.homeAssistant.url} onChange={(e) => setDraft({ ...draft, homeAssistant: { ...draft.homeAssistant, url: e.target.value } })} placeholder="http://127.0.0.1:8123" />
          </Field>
          <Field label="Config folder" hint="The folder holding Home Assistant's .storage; GGO reuses the login stored there." wide>
            <input className="mod-input mono" value={draft.homeAssistant.configDir} onChange={(e) => setDraft({ ...draft, homeAssistant: { ...draft.homeAssistant, configDir: e.target.value } })} />
          </Field>
          <Field label="Python for miIO" hint="A Python with python-miio installed, used only by devices on the local miIO link." wide>
            <input className="mod-input mono" value={draft.pythonPath} onChange={(e) => setDraft({ ...draft, pythonPath: e.target.value })} />
          </Field>
        </div>
        <HomeAssistantService />
      </fieldset>

      {draft.devices.map((device) => (
        <fieldset className="mod-fieldset" key={device.id}>
          <legend>{device.name || "Unnamed device"}</legend>
          <div className="mod-fields">
            <Field label="Name">
              <input className="mod-input" value={device.name} onChange={(e) => patchDevice(device.id, { name: e.target.value })} />
            </Field>
            <Field label="Location">
              <input className="mod-input" value={device.location} onChange={(e) => patchDevice(device.id, { location: e.target.value })} />
            </Field>
            <Field label="Control through">
              <select className="mod-select" value={device.platform} onChange={(e) => patchDevice(device.id, { platform: e.target.value as Bridge })}>
                <option value="auto">Automatic (miIO when a token is set)</option>
                <option value="home-assistant">Home Assistant</option>
                <option value="xiaomi-miio">Local miIO</option>
              </select>
            </Field>
            <Field label="Model">
              <select className="mod-select" value={device.model} onChange={(e) => patchDevice(device.id, { model: e.target.value })}>
                {[...new Set([device.model, ...MODELS])].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Home Assistant entity" hint="Blank finds the vacuum entity by device or name.">
              <input className="mod-input mono" value={device.homeAssistantEntityId} onChange={(e) => patchDevice(device.id, { homeAssistantEntityId: e.target.value })} placeholder="vacuum.example" />
            </Field>
            <Field label="Home Assistant device id">
              <input className="mod-input mono" value={device.homeAssistantDeviceId} onChange={(e) => patchDevice(device.id, { homeAssistantDeviceId: e.target.value })} />
            </Field>
            <Field label="Local address">
              <input className="mod-input mono" value={device.host} onChange={(e) => patchDevice(device.id, { host: e.target.value })} placeholder="192.0.2.10" />
            </Field>
            <Field label="miIO token" hint={device.tokenSet ? "Saved. Leave the dots to keep it, or clear the field to remove it." : "32 hexadecimal characters."}>
              <input className="mod-input mono" type="password" autoComplete="off" value={device.token} onChange={(e) => patchDevice(device.id, { token: e.target.value })} />
            </Field>
            <Field label="Refresh every (seconds)" hint="0 refreshes only when you ask.">
              <input className="mod-input" type="number" min={0} max={600} value={Math.round(device.refreshMs / 1000)} onChange={(e) => patchDevice(device.id, { refreshMs: Math.max(0, Number(e.target.value) || 0) * 1000 })} />
            </Field>
            <Field label="Note" wide>
              <textarea className="mod-input" rows={2} value={device.statusNote} onChange={(e) => patchDevice(device.id, { statusNote: e.target.value })} />
            </Field>
          </div>
          <button className="btn danger sm" onClick={() => setDraft((d) => ({ ...d, devices: d.devices.filter((x) => x.id !== device.id) }))}>
            <Icon name="trash" size={13} /> Remove device
          </button>
        </fieldset>
      ))}
      <button className="btn ghost sm mod-add" onClick={() => void addDevice()}>
        <Icon name="plus" size={13} /> Add a device
      </button>
    </ModuleDialog>
  );
}
