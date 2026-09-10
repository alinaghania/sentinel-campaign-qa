// Analyse de brief : HTML/texte/PDF → markdown propre (tables préservées)
// → prune de l'historique de mails → extraction structurée anti-hallucination
// (value/quote/confidence, quote vérifiée en code par substring).

import TurndownService from "turndown";
// @ts-expect-error pas de types publiés
import { gfm } from "@joplin/turndown-plugin-gfm";
import { judgeModel } from "./foundry";
import { BriefExtractionSchema, type BriefExtractionOut } from "./schemas";
import { runAgent, verifyQuote } from "./structured";
import type { BriefExtraction } from "./types";

const turndown = new TurndownService({ headingStyle: "atx" });
turndown.use(gfm);
turndown.remove(["style", "script", "head"]);

// Coupe l'historique de mails cités (fils Outlook/Gmail) — garde le message le plus récent.
export function pruneEmailHistory(text: string): string {
  const markers = [
    /^-{3,}\s*Original Message\s*-{3,}/im,
    /^_{5,}\s*$/m,
    /^De\s?:\s.+^Envoyé\s?:/ims,
    /^From:\s.+^Sent:/ims,
    /^Le .{5,60} a écrit\s?:/im,
    /^On .{5,80} wrote:/im,
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index > 200 && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

export function briefToMarkdown(raw: string): string {
  const isHtml = /<\s*(html|body|table|div|p|br)[\s>]/i.test(raw);
  let text = isHtml ? turndown.turndown(raw) : raw;
  text = pruneEmailHistory(text);
  // borne dure : ~40k tokens ≈ 160k chars
  if (text.length > 160_000) text = text.slice(0, 160_000) + "\n\n[…brief tronqué…]";
  return text.trim();
}

export async function pdfToText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const res = await parser.getText();
    return res.text;
  } finally {
    await parser.destroy();
  }
}

// Brief Excel des maisons (.xlsx/.xlsm) → texte. Chaque feuille non vide en CSV
// (grille FIELD/DESCRIPTION/VALUE et cellules fusionnées préservées), puis
// l'extraction LLM existante pioche les champs. On ne filtre PAS les feuilles :
// même un classeur multi-canal complet reste ~4k tokens, donc on donne TOUT au
// modèle (il cible l'email lui-même) plutôt que de risquer de jeter de l'info.
export async function xlsxToText(buffer: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim();
    if (csv) parts.push(`## Feuille : ${name}\n\n${csv}`);
  }
  return parts.join("\n\n");
}

// Excel → tableaux MARKDOWN (préserve la structure tabulaire, contrairement au
// CSV aplati). Utilisé par l'import de guidelines pour un rendu fidèle.
export async function xlsxToMarkdown(buffer: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const cell = (r: unknown[] | undefined, i: number) =>
    String(r?.[i] ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
    const width = Math.max(0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
    if (width === 0) continue;
    const md = [`## ${name}`, ""];
    md.push("| " + Array.from({ length: width }, (_, i) => cell(rows[0], i) || " ").join(" | ") + " |");
    md.push("| " + Array.from({ length: width }, () => "---").join(" | ") + " |");
    for (const r of rows.slice(1)) {
      md.push("| " + Array.from({ length: width }, (_, i) => cell(r as unknown[], i)).join(" | ") + " |");
    }
    parts.push(md.join("\n"));
  }
  return parts.join("\n\n");
}

// Word (.docx) / PowerPoint (.pptx) → texte via officeparser (retourne un AST → toText()).
export async function officeDocToText(buffer: Buffer): Promise<string> {
  const { parseOffice } = await import("officeparser");
  const ast = await parseOffice(buffer);
  return typeof ast?.toText === "function" ? ast.toText() : String(ast ?? "");
}

// Extraction texte unifiée depuis un fichier uploadé, quel que soit le format :
// PDF, Excel (.xlsx/.xlsm), Word (.docx), PowerPoint (.pptx), sinon texte/HTML brut.
export async function extractFileText(filename: string, buffer: Buffer): Promise<string> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return pdfToText(buffer);
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls"))
    return xlsxToText(buffer);
  if (lower.endsWith(".docx") || lower.endsWith(".pptx")) return officeDocToText(buffer);
  return buffer.toString("utf-8");
}

// Marchés/locales reconnus comme en-têtes de colonnes dans les briefs multi-marché.
const MARKET_TOKEN =
  /^(EN|FR|IT|ES|DE|PT|NL|EU|WW|US|CA|UK|GB|IE|MX|BR|AR|CL|CO|KR|JP|CN|HK|TW|SG|MY|TH|ID|PH|VN|AU|NZ|AE|SA|QA|KW|IL|ZA|RU|PL|CZ|SK|HU|RO|SE|NO|DK|FI|CH|AT|BE|LU|GR|TR|IN)([\s\-/(].*)?$/i;

// Détecte les marchés d'un brief multi-marché : la ligne (CSV) qui contient le
// plus de cellules ressemblant à des codes marché (EN, FR, "US - CA", "ES - MX"…).
export function detectMarkets(text: string): string[] {
  let best: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(",").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const markets = cells.filter((c) => c.length <= 24 && MARKET_TOKEN.test(c));
    if (markets.length > best.length) best = markets;
  }
  return [...new Set(best)];
}

const FIELD_KEYS = [
  "campaign_name",
  "market",
  "email_type",
  "target_audience",
  "send_datetime",
  "subject_line",
  "preheader",
  "key_message",
  "offer",
  "promo_code",
  "cta_label",
  "landing_urls",
  "utm_campaign",
  "legal_mentions",
] as const;

export async function extractBrief(
  briefMarkdown: string,
  market?: string | null
): Promise<{ ok: true; data: BriefExtraction } | { ok: false; error: string }> {
  const marketRule = market
    ? `MARCHÉ CIBLE : "${market}". Extrais UNIQUEMENT les valeurs de la colonne de ce marché. Ignore les autres colonnes de marché.`
    : `Si plusieurs marchés sont présents, prends la version EN/globale par défaut et cite le marché dans le quote.`;
  const res = await runAgent({
    model: judgeModel(),
    toolName: "emit_brief",
    toolDescription: "Rends l'extraction structurée du brief de campagne.",
    system: `Tu extrais les informations clés d'un brief de campagne email (équipe CRM, contexte Salesforce Marketing Cloud).
Le brief peut provenir d'un Excel converti en texte (plusieurs feuilles "## Feuille : …") couvrant PLUSIEURS canaux (EMAIL, SMS, MMS, WhatsApp, WeChat, LINE…) et PLUSIEURS marchés (colonnes par pays : EN, FR, IT, US-CA…). Concentre-toi UNIQUEMENT sur le canal EMAIL. ${marketRule}
Règles impératives :
- Pour CHAQUE champ : "value" = l'information si présente, sinon null. N'infère JAMAIS, ne complète JAMAIS depuis tes connaissances.
- "quote" = extrait VERBATIM du brief (copié caractère pour caractère) qui justifie la valeur. Obligatoire si value non-null. Il sera vérifié automatiquement par recherche exacte — un quote reformulé sera rejeté.
- "confidence": high = explicite, medium = déduit du contexte proche, low = incertain.
- "send_datetime" : format ISO si possible, sinon tel qu'écrit.
- "landing_urls" : URLs attendues séparées par des virgules.
- "missing_fields" : liste des champs importants ABSENTS du brief (parmi : ${FIELD_KEYS.join(", ")}).
- Réponds en français dans les values quand le brief est en français.`,
    user: `BRIEF (markdown) :\n\n${briefMarkdown}\n\nExtrais les champs via emit_brief.`,
    schema: BriefExtractionSchema,
    maxTokens: 3500,
    strict: false, // 28 champs nullables > limite Foundry de 16 unions en strict
  });
  if (!res.ok) return res;

  // Vérification des quotes en code : introuvable → value conservée mais
  // confidence rétrogradée low + quote null (transparence UI).
  const data = res.data as BriefExtractionOut;
  for (const key of FIELD_KEYS) {
    const field = data[key];
    if (field.value !== null && field.quote) {
      if (!verifyQuote(field.quote, briefMarkdown)) {
        field.quote = null;
        field.confidence = "low";
      }
    }
    if (field.value !== null && !field.quote && field.confidence === "high") {
      field.confidence = "medium";
    }
  }
  // recalcul missing_fields en code (fiable)
  data.missing_fields = FIELD_KEYS.filter((k) => data[k].value === null);
  return { ok: true, data };
}
