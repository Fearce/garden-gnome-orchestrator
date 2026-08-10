/**
 * Gate: the document parser on every agent's PATH still reads a PDF, and reads it through the
 * LOCAL pdfjs copy rather than the CDN one.
 *
 * `graphify` is installed so its shim lands on every agent's PATH (e13b56a), and it reaches PDFs
 * through officeparser → pdfjs-dist. On 2026-08-07 that chain carried GHSA-hq66-cqwq-w95j (a
 * malicious PDF executing JavaScript), closed by the `pdfjs-dist@^6` override in package.json.
 *
 * `audit:deps` and `audit:overrides` already prove that override RESOLVES. Neither can prove the
 * two things this does:
 *
 *  1. officeparser still works on a version it did not ask for — its manifest pins pdfjs-dist to
 *     one exact release, so the override deliberately overrules upstream, and a future bump could
 *     break the parse with nothing else noticing until an agent's graphify call fails.
 *  2. the patched copy is the one that actually RUNS. officeparser's default `pdfWorkerSrc` is a
 *     CDN URL hardcoded to the vulnerable 6.1.200; the Node path resolves the worker locally via
 *     `require.resolve` and only falls back to that URL on throw, logging PDF_WORKER_FALLBACK when
 *     it does. So an empty warning list is what says the local patched worker ran — an override
 *     that binds while the consumer fetches the vulnerable copy by URL is a fix in name only.
 *
 * Free: no network, no agent, no quota — a few hundred ms.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeWarningType, parseOffice, terminateOcr } from "officeparser";

const MARKER = "GRAPHIFY PDF OK";

/** A minimal one-page PDF whose only content is `text`, with correctly computed xref offsets. */
function buildPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const dir = mkdtempSync(join(tmpdir(), "gg-pdf-gate-"));
try {
  const path = join(dir, "sample.pdf");
  writeFileSync(path, buildPdf(MARKER));

  const parsed = (await parseOffice(path)) as {
    type?: string;
    content?: Array<{ text?: string }>;
    metadata?: { pages?: number };
    warnings?: Array<{ type?: string }>;
  };

  assert.equal(parsed.type, "pdf", "officeparser must recognise the file as a PDF");
  assert.equal(parsed.metadata?.pages, 1, "the single page must be reported");

  const text = (parsed.content ?? []).map((page) => page.text ?? "").join("\n");
  assert.ok(
    text.includes(MARKER),
    `the bumped pdfjs-dist must still extract page text — got: ${JSON.stringify(text).slice(0, 200)}`,
  );

  // The security half. A fallback here means the worker came from the CDN URL officeparser pins to
  // the vulnerable release, so the override would be governing resolution while the vulnerable copy
  // is what runs.
  //
  // Both of its inputs are checked first, because either one going missing upstream would turn the
  // assertion below into a filter over nothing that passes forever — the failure mode this gate
  // exists to catch, reproduced inside the gate itself.
  assert.equal(
    typeof OfficeWarningType.PDF_WORKER_FALLBACK,
    "string",
    "officeparser renamed PDF_WORKER_FALLBACK — the fallback check below would match nothing and pass forever",
  );
  assert.ok(
    Array.isArray(parsed.warnings),
    "officeparser stopped returning a `warnings` array — the fallback check below would read undefined and pass forever",
  );

  const fellBack = (parsed.warnings ?? []).filter((w) => w.type === OfficeWarningType.PDF_WORKER_FALLBACK);
  assert.deepEqual(
    fellBack,
    [],
    "officeparser fell back to its hardcoded CDN pdf.worker (pinned to the vulnerable pdfjs-dist)" +
      " — the local override is not what parsed this file",
  );
} finally {
  await terminateOcr?.();
  rmSync(dir, { recursive: true, force: true });
}

console.log("PDF parse path tests passed.");
