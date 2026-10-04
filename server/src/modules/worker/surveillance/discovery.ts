import http from "node:http";
import https from "node:https";
import net from "node:net";
import { blankCamera, type Camera } from "./config.js";
import { inferVendor, pickPreset, type CameraPreset } from "./presets.js";
import { httpAuthUrl, httpUrl, rtspUrl } from "./urls.js";

export interface DiscoveryInput {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  modelPreset?: string;
  vendorHint?: string;
}

interface PortProbe {
  port: number;
  open: boolean;
  latencyMs?: number;
  reason?: string;
}

interface HttpProbe {
  url: string;
  ok: boolean;
  statusCode?: number;
  contentType?: string;
  server?: string;
  bodySnippet?: string;
  error?: string;
}

export interface DiscoveryResult {
  detectedVendor: string;
  matchedPreset: Pick<CameraPreset, "id" | "vendor" | "model" | "notes"> | null;
  openPorts: number[];
  rootProbe: HttpProbe;
  onvifProbes: HttpProbe[];
  rtspCandidates: { label: string; url: string }[];
  snapshotProbes: HttpProbe[];
  cameraDraft: Camera;
}

const PRIORITY_PORTS = [80, 81, 88, 443, 554, 8000, 8080, 8081, 8443, 2020, 8554, 8899, 9000, 9090, 10554];
const HOST_PATTERN = /^[a-zA-Z0-9.:-]{1,253}$/;

/**
 * Probe a camera on the LAN: sweep ports 1–10000, read the web root for a vendor, try the ONVIF, RTSP and
 * snapshot paths its family uses, and return a ready-to-save camera draft. Takes up to a minute on a slow
 * camera, which is why it runs in the module worker and never in the console process.
 */
export async function discoverCamera(input: DiscoveryInput): Promise<DiscoveryResult> {
  const host = String(input.host ?? "").trim();
  if (!host || !HOST_PATTERN.test(host)) throw new Error("Enter the camera's IP address or host name");
  const port = Number(input.port) || 80;
  const username = String(input.username ?? "").trim();
  const password = String(input.password ?? "");

  const portOrder = [...new Set([port, ...PRIORITY_PORTS, ...Array.from({ length: 10_000 }, (_, i) => i + 1)])];
  const openPorts = (await scanPorts(host, portOrder, 160, 128)).filter((probe) => probe.open).map((probe) => probe.port);

  const httpPorts = [...new Set([port, 80, 81, 88, 443, 8000, 8080, 8081, 8443, ...openPorts.filter((p) => p !== 554 && p !== 8554)])].slice(0, 48);
  const rootProbes: HttpProbe[] = [];
  for (const httpPort of httpPorts) {
    rootProbes.push(await probeHttp(httpUrl({ protocol: isTlsPort(httpPort) ? "https" : "http", host, port: httpPort }), username, password, 1_200));
  }
  const rootProbe = rootProbes.find((probe) => probe.ok && (probe.statusCode ?? 0) < 500) ?? rootProbes[0] ?? { url: httpUrl({ host, port }), ok: false, error: "unprobed" };
  const rootText = rootProbes.map((probe) => [probe.server, probe.bodySnippet].filter(Boolean).join(" ")).join(" ");
  const preset = pickPreset(input.modelPreset, input.vendorHint, rootText);

  const onvifUrls = dedupe(
    [
      ...(preset?.onvifCandidates ?? []),
      { protocol: "http", port, path: "/onvif/device_service" },
      { protocol: "http", port: 2020, path: "/onvif/device_service" },
      { protocol: "http", port: 8000, path: "/onvif/device_service" },
      { protocol: "http", port: 80, path: "/onvif/device_service" },
      { protocol: "https", port: 443, path: "/onvif/device_service" },
      { protocol: "https", port: 8443, path: "/onvif/device_service" },
      ...httpPorts.map((p) => ({ protocol: isTlsPort(p) ? "https" : "http", port: p, path: "/onvif/device_service" })),
    ].map((c) => httpUrl({ protocol: c.protocol, host, port: c.port, path: c.path })),
  );
  const onvifProbes: HttpProbe[] = [];
  for (const url of onvifUrls) onvifProbes.push(await probeHttp(url, username, password, 1_800));

  const rtspCandidates = dedupeBy(
    [
      ...(preset?.rtspCandidates ?? []),
      { port: 554, path: "/stream1", label: "Generic stream1" },
      { port: 554, path: "/stream2", label: "Generic stream2" },
      { port: 554, path: "/Preview_01_main", label: "Generic Preview_01_main" },
      { port: 554, path: "/Preview_01_sub", label: "Generic Preview_01_sub" },
      { port: 554, path: "/h264Preview_01_main", label: "Generic h264 main" },
      { port: 554, path: "/h264Preview_01_sub", label: "Generic h264 sub" },
      { port: 8554, path: "/stream1", label: "RTSP 8554 stream1" },
      ...openPorts.filter((p) => [554, 8554, 10554].includes(p)).map((p) => ({ port: p, path: "/stream1", label: `Open RTSP-like port ${p}` })),
    ].map((c) => ({ label: c.label, url: rtspUrl({ host, port: c.port, username, password, path: c.path }) })),
    (c) => c.url,
  );

  const snapshotUrls = dedupe([
    ...(preset?.vendor === "TP-Link Tapo" ? ["/stream/video/mjpeg", "/snapshot.jpg", "/img/snapshot.cgi"] : []),
    ...(preset?.vendor === "Reolink"
      ? [`/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=ggo&user=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, "/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=ggo"]
      : []),
    "/snapshot.jpg",
    "/image.jpg",
  ].map((path) => httpAuthUrl({ host, port, username, password, path })));
  const snapshotProbes: HttpProbe[] = [];
  for (const url of snapshotUrls.slice(0, 12)) snapshotProbes.push(await probeHttp(url, username, password, 1_200));

  const liveOnvif = onvifProbes.find((probe) => probe.ok && [200, 401, 403].includes(probe.statusCode ?? 0));
  const liveSnapshot = snapshotProbes.find((probe) => probe.ok && [200, 401, 403].includes(probe.statusCode ?? 0) && /image|multipart|jpe?g|mjpg/i.test(probe.contentType ?? ""));
  const vendor = inferVendor(rootText) || preset?.vendor || inferVendor(input.vendorHint);
  const draft = blankCamera({
    name: preset?.model || `${vendor || "Camera"} ${host}`,
    vendor,
    model: preset?.model || String(input.modelPreset ?? ""),
    modelPreset: preset?.id ?? "",
    host,
    port,
    username,
    password,
    onvifUrl: liveOnvif?.url || onvifUrls[0] || "",
    snapshotUrl: liveSnapshot?.url || "",
    streamUrl: rtspCandidates[0]?.url || "",
    subStreamUrl: rtspCandidates[1]?.url || "",
    previewStrategy: liveSnapshot ? "snapshot" : rtspCandidates[0] ? "rtsp-mjpeg-proxy" : "none",
    notes: [
      preset?.notes.join(" "),
      rootProbe.ok ? `HTTP answered ${rootProbe.statusCode} on ${rootProbe.url}.` : `HTTP probe failed on ${rootProbe.url}${rootProbe.error ? ` (${rootProbe.error})` : ""}.`,
      liveOnvif ? `ONVIF answered on ${liveOnvif.url} with HTTP ${liveOnvif.statusCode}.` : "No ONVIF endpoint answered; check that ONVIF is enabled on the camera.",
      liveSnapshot ? "A snapshot endpoint answered with an image." : "No snapshot endpoint answered; the live view will use the RTSP stream.",
    ].filter(Boolean).join("\n"),
  });

  return {
    detectedVendor: vendor,
    matchedPreset: preset ? { id: preset.id, vendor: preset.vendor, model: preset.model, notes: preset.notes } : null,
    openPorts,
    rootProbe,
    onvifProbes,
    rtspCandidates,
    snapshotProbes,
    cameraDraft: draft,
  };
}

function isTlsPort(port: number): boolean {
  return port === 443 || port === 8443;
}

function probePort(host: string, port: number, timeoutMs: number): Promise<PortProbe> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: PortProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ port, open: true, latencyMs: Date.now() - started }));
    socket.once("timeout", () => finish({ port, open: false, reason: "timeout" }));
    socket.once("error", (error: NodeJS.ErrnoException) => finish({ port, open: false, reason: error.code ?? error.message }));
    socket.connect(port, host);
  });
}

async function scanPorts(host: string, ports: number[], timeoutMs: number, concurrency: number): Promise<PortProbe[]> {
  const results: PortProbe[] = [];
  let next = 0;
  const lane = async () => {
    while (next < ports.length) results.push(await probePort(host, ports[next++]!, timeoutMs));
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, lane));
  return results.sort((a, b) => a.port - b.port);
}

function probeHttp(target: string, username: string, password: string, timeoutMs: number): Promise<HttpProbe> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return Promise.resolve({ url: target, ok: false, error: "invalid-url" });
  }
  const headers: Record<string, string> = {};
  if (username) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (probe: HttpProbe) => {
      if (settled) return;
      settled = true;
      resolve(probe);
    };
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, { method: "GET", headers, timeout: timeoutMs, rejectUnauthorized: false }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 4096) chunks.push(chunk);
        else response.destroy();
      });
      const done = () =>
        finish({
          url: target,
          ok: true,
          statusCode: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          server: String(response.headers.server ?? ""),
          bodySnippet: Buffer.concat(chunks).toString("utf8").slice(0, 400),
        });
      response.on("end", done);
      response.on("close", done);
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", (error: NodeJS.ErrnoException) => finish({ url: target, ok: false, error: error.code ?? error.message }));
    request.end();
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
