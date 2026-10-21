// Envoi par email d'une sélection de findings, depuis le compte Gmail du .env.
// Pourquoi SMTP et non l'API Gmail : l'OAuth de lib/gmail.ts est en lecture
// seule (gmail.readonly) et expire tous les 7 jours en mode Testing ; les
// identifiants IMAP_USER / IMAP_PASSWORD (mot de passe d'application) sont déjà
// ceux de la boîte de réception et ouvrent aussi smtp.gmail.com.
// Le contenu du mail est construit ici, de façon déterministe — aucun LLM.

import nodemailer from "nodemailer";
import { normalizeAppPassword } from "./imap";
import { titleForFinding } from "./finding-titles";
import type { AnalysisReport, Finding } from "./types";

export const MAX_RECIPIENTS = 10;

// Volontairement simple : on refuse les valeurs manifestement fausses, c'est
// le serveur SMTP qui tranche le reste. Interdit tout espace, retour ligne et
// virgule → pas d'injection d'en-têtes ni de destinataire caché.
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export function smtpConfigured(): boolean {
  return Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

/** Découpe « a@x.com, b@y.com » ; renvoie les adresses valides et les rejetées. */
export function parseRecipients(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) (EMAIL_RE.test(p) ? valid : invalid).push(p);
  return { valid: [...new Set(valid)], invalid };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Retire retours ligne et contrôles : l'objet est un en-tête SMTP. */
const oneLine = (s: string) => s.replace(/[\r\n\u0000-\u001f]+/g, " ").trim();

export function buildFindingsEmail(opts: {
  report: AnalysisReport;
  findings: Finding[];
  campaignName: string;
  emailName?: string;
  note?: string;
}): { subject: string; text: string; html: string } {
  const { report, findings, campaignName, emailName, note } = opts;
  const subject = oneLine(
    `[Sentinel] ${campaignName}${emailName ? ` — ${emailName}` : ""} : ${findings.length} finding${findings.length === 1 ? "" : "s"}`
  );

  const header = `Campaign: ${campaignName}${emailName ? `\nEmail: ${emailName}` : ""}\nVerdict: ${report.verdict}`;
  const text = [
    header,
    note?.trim() ? `\n${note.trim()}` : "",
    "",
    ...findings.map((f, i) => {
      const lines = [`${i + 1}. [${f.severite}] ${titleForFinding(f)}`, `   ${f.message}`];
      if (f.expected !== undefined) {
        lines.push(`   Expected: ${f.expected}`, `   Received: ${f.received || "not found"}`);
      } else if (f.evidence) lines.push(`   Evidence: ${f.evidence}`);
      if (f.suggestion) lines.push(`   Suggestion: ${f.suggestion}`);
      lines.push(`   Location: ${f.locator}`);
      return lines.join("\n");
    }),
  ].join("\n");

  const cards = findings
    .map((f) => {
      const detail =
        f.expected !== undefined
          ? `<p style="margin:6px 0;font-size:13px"><b>Expected:</b> ${esc(f.expected)}<br><b>Received:</b> ${esc(f.received || "not found")}</p>`
          : f.evidence
            ? `<p style="margin:6px 0;font:12px monospace;color:#555">${esc(f.evidence)}</p>`
            : "";
      return `<div style="border:1px solid #ddd;padding:12px;margin:0 0 10px">
  <div style="font-size:11px;font-weight:bold;letter-spacing:.08em;color:#666">${esc(f.severite)} · ${esc(f.locator)}</div>
  <div style="font-size:14px;font-weight:bold;margin-top:2px">${esc(titleForFinding(f))}</div>
  <p style="margin:6px 0;font-size:13px">${esc(f.message)}</p>${detail}
  ${f.suggestion ? `<p style="margin:6px 0;font-size:13px;color:#555">💡 ${esc(f.suggestion)}</p>` : ""}
</div>`;
    })
    .join("\n");

  const html = `<div style="font-family:Arial,sans-serif;color:#111;max-width:640px">
<p style="font-size:13px;margin:0 0 4px"><b>${esc(campaignName)}</b>${emailName ? ` — ${esc(emailName)}` : ""}</p>
<p style="font-size:12px;color:#666;margin:0 0 14px">Verdict: ${esc(report.verdict)}</p>
${note?.trim() ? `<p style="font-size:14px;white-space:pre-wrap">${esc(note.trim())}</p>` : ""}
${cards}
</div>`;

  return { subject, text, html };
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  if (!smtpConfigured()) throw new Error("IMAP_USER / IMAP_PASSWORD non configurés");
  const user = process.env.IMAP_USER ?? "";
  const port = Number(process.env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user, pass: normalizeAppPassword(process.env.IMAP_PASSWORD ?? "") },
    connectionTimeout: 20_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  await transport.sendMail({ from: user, ...opts });
}
