// Extrait la STRUCTURE du template Kering depuis le classeur vierge officiel.
//
// Pourquoi un extracteur et pas une déclaration écrite à la main : un
// référentiel recopié à la main est faux d'une façon que personne ne détecte
// avant la production — il serait conforme à ce qu'on croit avoir lu, pas au
// fichier. Ici la seule source est le .xlsm.
//
// Différence avec scripts/extract-placeholders.mjs (22/07), qui s'arrête au
// vocabulaire : celui-là balaie à partir de la colonne C (les VALEURS) et ne
// regarde jamais la colonne A ni la ligne d'en-tête. Il exige aussi un filtrage
// humain ("Shop Now" est-il un placeholder ou du contenu ?), donc il est
// one-shot. Ici il n'y a AUCUN jugement à rendre : le contenu de A7 EST le nom
// du champ, D6:N6 SONT les codes langue. L'extraction est donc mécanique,
// rejouable, et gardée par un test de boucle fermée.
//
// Usage : node scripts/extract-template.mjs          (écrit lib/brief-template.data.ts)
//         node scripts/extract-template.mjs --check  (échoue si le fichier généré diverge)

import { readFileSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";

const SOURCE = "lib/__tests__/fixtures/blank-template.xlsm";
const OUT = "lib/brief-template.data.ts";

// Les mêmes bornes que le parseur (lib/brief-grid.ts) : si l'extracteur et le
// parseur ne s'accordent pas sur où finit la section EMAIL, la déclaration
// décrit un fichier que le parseur ne lit pas.
const CHANNEL_BREAK = /^(SMS|VMS|MMS|LINE|KKT|WECHAT|TASK|WHATSAPP)$/i;
const META_FIELD_RE =
  /^(campaign ?name|target|mock ?up|task |priority$|category$|sub ?category|launch date|sending date|⚠️|content definition|email layout|season$|country$|note$|message (body|text)$|content$|url\d$)/i;

/** Texte d'une cellule, hyperlien en repli (les URL du template sont parfois
 *  portées par le lien et non par le texte — cf. C17:C19 du vierge). */
function cellAt(ws, r, c) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  if (!cell) return "";
  const txt = String(cell.v ?? "").replace(/\s+/g, " ").trim();
  return txt || (cell.l?.Target ?? "");
}

/** Clé stable dérivée du libellé. C'est un CONTRAT (elle voyage dans les
 *  overrides et les rapports) : elle ne se renomme pas, même si le libellé
 *  affiché change. */
function slug(label) {
  return label
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const wb = XLSX.read(readFileSync(SOURCE), { cellFormula: false });

// ── 1. Langues déclarées, feuille Common ("English → EN" + "Activate")
const common = wb.Sheets["Common"];
if (!common) throw new Error(`Feuille "Common" absente de ${SOURCE}`);
const commonRange = XLSX.utils.decode_range(common["!ref"]);
const languages = [];
let inLangSection = false;
for (let r = commonRange.s.r; r <= commonRange.e.r; r++) {
  const cells = [];
  for (let c = commonRange.s.c; c <= commonRange.e.c; c++) cells.push(cellAt(common, r, c));
  if (cells.some((v) => /^INCLUDED LANGUAGES/i.test(v))) {
    inLangSection = true;
    continue;
  }
  if (!inLangSection) continue;
  const labelCell = cells.find((v) => /→/.test(v));
  if (!labelCell) continue;
  const m = /^(.+?)\s*→\s*([A-Za-z]{2,3})$/.exec(labelCell);
  if (!m) continue;
  languages.push({ code: m[2].toUpperCase(), name: m[1].trim() });
}
if (languages.length === 0) throw new Error("Aucune langue lue sous INCLUDED LANGUAGES");

// ── 2. Section EMAIL de la feuille "Campaign Brief"
const brief = wb.Sheets["Campaign Brief"];
if (!brief) throw new Error(`Feuille "Campaign Brief" absente de ${SOURCE}`);
const range = XLSX.utils.decode_range(brief["!ref"]);

// En-tête FIELD | … | VALUE — même recherche que findFieldValueHeader (20 lignes).
let header = null;
for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 19); r++) {
  const cells = [];
  for (let c = range.s.c; c <= range.e.c; c++) cells.push(cellAt(brief, r, c).toUpperCase());
  const fi = cells.indexOf("FIELD");
  const vi = cells.indexOf("VALUE");
  if (fi >= 0 && vi > fi) {
    header = { row: r, fieldCol: range.s.c + fi, valueCol: range.s.c + vi };
    break;
  }
}
if (!header) throw new Error("En-tête FIELD/VALUE introuvable dans Campaign Brief");
const descCol = header.fieldCol + 1;

// Le canal de la section : cellule A1 de la feuille. Le parseur ne le vérifie
// PAS (il lit la première section quelle qu'elle soit) — l'extracteur, lui, doit
// refuser de fabriquer un référentiel email à partir d'une section TASK.
const channel = cellAt(brief, range.s.r, range.s.c).toUpperCase();
if (channel !== "EMAIL") {
  throw new Error(`Première section = "${channel}", attendu "EMAIL" — ce classeur ne peut pas servir de référentiel email`);
}

// Colonnes langue après VALUE.
const langCols = [];
for (let c = header.valueCol + 1; c <= range.e.c; c++) {
  const label = cellAt(brief, header.row, c);
  if (label) langCols.push({ col: c, label });
}

// Préambule (lignes AVANT l'en-tête : canal, Campaign Name, TARGET…). Extrait
// et non réinventé par le générateur : sans lui, le fichier régénéré n'aurait
// plus la ligne "Campaign Name" d'où le parseur tire salesforceCampaignName —
// et le test de boucle fermée validerait une structure amputée.
const preamble = [];
for (let r = range.s.r; r < header.row; r++) {
  const cells = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const v = cellAt(brief, r, c);
    if (v) cells.push({ col: c, value: v });
  }
  if (cells.length > 0) preamble.push({ row: r, cells });
}

const fields = [];
for (let r = header.row + 1; r <= range.e.r; r++) {
  const label = cellAt(brief, r, header.fieldCol);
  if (CHANNEL_BREAK.test(label)) break;
  if (!label) continue;

  // kind : dérivé par une règle ÉNONCÉE, pas par appréciation.
  //  - "… URL" / "… URL - WOMEN"  → url   (cf. urlMatch du parseur)
  //  - libellé de métadonnée      → meta  (jamais un bloc de contenu)
  //  - sinon                      → text
  const isUrl = /^(.+?)\s+URL(?:\s*-\s*(.+))?$/i.test(label);
  const kind = isUrl ? "url" : META_FIELD_RE.test(label) ? "meta" : "text";

  fields.push({
    key: slug(label),
    label,
    // Décalage RÉEL depuis l'en-tête, pas un rang. Le vierge laisse une ligne
    // vide avant "Mock Up" (A21 vide, A22 = Mock Up) : supposer des lignes
    // consécutives ferait annoncer par la doc une cellule où le métier ne
    // trouverait rien. Constaté par le test de boucle fermée, pas déduit.
    rowOffset: r - header.row,
    description: cellAt(brief, r, descCol),
    master: cellAt(brief, r, header.valueCol),
    kind,
    // required / translatable sont de la POLITIQUE, pas de l'extraction : le
    // fichier ne dit pas si un champ est obligatoire. Valeurs de départ
    // explicites, éditables ensuite depuis la plateforme.
    //   - "(optional)" dans le libellé est la seule marque d'optionnalité que
    //     le vierge porte réellement ;
    //   - une méta n'est ni obligatoire ni traduisible ;
    //   - une URL n'est pas traduisible (même lien pour toutes les langues,
    //     sauf déclinaison par marché, qui vit dans expectedLinks).
    required: kind === "meta" ? false : !/\(optional\)/i.test(label),
    translatable: kind === "text",
  });
}
if (fields.length === 0) throw new Error("Aucun champ lu dans la section EMAIL");

const dup = fields.map((f) => f.key).filter((k, i, a) => a.indexOf(k) !== i);
if (dup.length > 0) throw new Error(`Clés dupliquées : ${dup.join(", ")}`);

// ── 3. Émission
const banner = `// FICHIER GÉNÉRÉ — ne pas éditer à la main.
// Source : ${SOURCE} (section EMAIL de la feuille "Campaign Brief").
// Régénérer : npm run extract:template
// Gardé par le test de boucle fermée lib/__tests__/brief-template.test.ts.
`;
const body = `${banner}
import type { BriefTemplateData } from "./brief-template";

export const EXTRACTED_TEMPLATE: BriefTemplateData = ${JSON.stringify(
  {
    source: SOURCE,
    channel,
    headerRow: header.row,
    fieldCol: header.fieldCol,
    descCol,
    valueCol: header.valueCol,
    firstLangCol: header.valueCol + 1,
    languageColumns: langCols.map((l) => l.label),
    languages,
    preamble,
    fields,
  },
  null,
  2
)} as const;
`;

if (process.argv.includes("--check")) {
  const current = (() => {
    try {
      return readFileSync(OUT, "utf8");
    } catch {
      return null;
    }
  })();
  if (current !== body) {
    console.error(`${OUT} diverge de ${SOURCE}. Lancer : npm run extract:template`);
    process.exit(1);
  }
  console.log(`${OUT} à jour (${fields.length} champs, ${languages.length} langues).`);
} else {
  writeFileSync(OUT, body);
  console.log(`${OUT} écrit — ${fields.length} champs, ${languages.length} langues, canal ${channel}.`);
}
