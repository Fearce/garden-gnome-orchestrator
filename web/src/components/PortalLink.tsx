import { useEffect, useState } from "react";
import { apiUrl } from "../lib/base.js";

export function PortalLink() {
  const [portal, setPortal] = useState<{ url: string; label: string; environment?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl("/api/portal"), { signal: controller.signal })
      .then(async response => response.ok ? response.json() : null)
      .then(value => {
        if (!value?.enabled || typeof value.url !== "string") return;
        const url = new URL(value.url);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return;
        if (url.username || url.password) return;
        setPortal({ url: url.href, label: String(value.label || "Admin workspace").slice(0, 50), environment: String(value.environment || "Personal GGO").slice(0, 80) });
      }).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!portal) return null;
  return <a href={portal.url} title={`${portal.environment} · Back to ${portal.label}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 10px", border: "1px solid var(--line, #465146)", borderRadius: 8, color: "inherit", textDecoration: "none", whiteSpace: "nowrap", fontSize: 12 }}>
    <span aria-hidden="true">↗</span> {portal.label}
  </a>;
}
