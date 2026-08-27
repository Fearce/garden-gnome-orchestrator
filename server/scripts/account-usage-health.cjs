// Pure inspection of the persisted Claude-account usage readings.  `probe:accounts` gives the
// full operator drill-down; the nightly probe needs this compact fail-safe verdict so a healthy
// HTTP listener cannot hide a FleetView full of em dashes.

const STALE_MS = 20 * 60 * 1000; // mirrors accounts/accountManager.ts

function inspectAccountUsage(rows, now = Date.now(), staleMs = STALE_MS) {
  const records = [];
  const issues = [];

  if (!rows.length) {
    issues.push("no persisted account-usage readings (FleetView meters may show —)");
    return { records, issues };
  }

  for (const row of rows) {
    const id = String(row.key).replace(/^account_usage_/, "") || "unknown";
    let usage;
    try {
      usage = JSON.parse(row.value);
    } catch {
      issues.push(`${id}: persisted usage is not valid JSON`);
      continue;
    }

    const usageAt = Number(usage?.usageAt);
    const fiveHour = usage?.fiveHour;
    const sevenDay = usage?.sevenDay;
    if (!Number.isFinite(usageAt) || usageAt <= 0) {
      issues.push(`${id}: usage has never been read (FleetView meters may show —)`);
      continue;
    }
    if (now - usageAt > staleMs) issues.push(`${id}: usage reading is stale`);
    if (!Number.isFinite(fiveHour) || !Number.isFinite(sevenDay)) {
      issues.push(`${id}: usage reading is incomplete (5h/7d meter missing)`);
    }
    records.push({ id, usageAt, fiveHour, sevenDay });
  }

  return { records, issues };
}

module.exports = { inspectAccountUsage, STALE_MS };
