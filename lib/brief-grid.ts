// Parseur DÉTERMINISTE (0 LLM) de la grille Excel "brief maison" → BriefGrid.
//
// Formats tolérés (constatés sur les vrais briefs Kering) :
// - Grille horizontale type BAL : row0 = [" ", "EN (exl. US - CA)", "US - CA", "FR", ... "CN"],
//   rows suivantes = blocs (Subject line / Preheader / Title / COPY 1 / CTA 1 ...),
//   puis paires "WW Linkthrough" / "CN Linkthrough" rattachées au libellé au-dessus.
// - Grille type AMQ : row0 = [null, "en-GB", "de-DE", "fr-FR", ...], libellés courts (sl, ph, body, cta 2...).
// - Feuilles FIELD/VALUE du template xlsm : PAS de ligne de langues → retourne null
//   (le fallback LLM est géré ailleurs).

import type { BriefBlock, BriefGrid, ExpectedLink } from "./types";
import { canonColumn } from "./lang-codes";
import { isPlaceholderText, isPlaceholderUrl } from "./brief-placeholders";

type Row = ReadonlyArray<unknown>;

// Libellés de blocs connus (BAL + AMQ). Le "…" du format est ouvert : on accepte
// aussi tout libellé rempli sur ≥ 2 colonnes de langue (voir isBlockRow).
const KNOWN_BLOCK_LABEL =
  /^(subject ?line|sl|pre-?header|ph|title|body(\s*\d+)?|copy\s*\d*|main copy|cta\s*\d*|header|footer|banner(\s*\d+)?|hero)$/i;

const LINKTHROUGH = /^([A-Z][A-Z-]*)\s*Linkthrough/i;

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  // Cap 4000 : une cellule Excel peut faire 32k chars — la Campaign est stockée
  // en une entité JSON (limite Azure Table 64KB/propriété).
  return String(cell).trim().slice(0, 4000);
}

/** Clé de COLONNE pour un en-tête de brief, en tolérant les décorations
 *  ("EN (exl. US - CA)" → "EN", "US - CA" → "US-CA"). Retourne null si ce
 *  n'est pas une colonne de langue reconnue.
 *
 *  Passe par `canonColumn` et non par `canonLang` : ce qui identifie une
 *  colonne n'est pas sa langue. `canonLang("MX") === "ES"` — et comme la boucle
 *  d'en-têtes ne garde qu'une colonne par clé, la colonne MX arrivait après ES,
 *  recevait sa clé, et n'était plus jamais lue. Idem ZHT après ZHS. Le
 *  détail qui rendait la panne invisible : rien n'était écrasé, donc rien ne
 *  ressemblait à un conflit — la cellule sortait simplement de toutes les
 *  boucles, et l'import restait vert. */
function canonHeader(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // STRICT : n'accepter que les codes d'un catalogue connu (langues + colonnes
  // de marché). Sinon "FIELD/DESCRIPTION/VALUE/REQUIRED" du template
  // FIELD/VALUE seraient pris pour des langues → grille absurde.
  const known = (s: string): string | null => canonColumn(s);
  const direct = known(trimmed);
  if (direct) return direct;
  // Sans parenthèses, espaces autour des tirets compactés : "US - CA" → "US-CA"
  const cleaned = trimmed
    .replace(/\(.*?\)/g, "")
    .replace(/\s*-\s*/g, "-")
    .trim();
  if (!cleaned || cleaned === trimmed) return null;
  return known(cleaned);
}

interface HeaderInfo {
  rowIndex: number;
  /** index de colonne → code langue canonique */
  langByCol: Map<number, string>;
  /** codes canoniques, ordre des colonnes, dédupliqués */
  languages: string[];
  /** code canonique → libellé ORIGINAL de la colonne ("US - CA", "MX"…) */
  langLabels: Record<string, string>;
}

/** Détecte la ligne d'en-tête langues : la ligne avec le plus de cellules
 *  reconnues par canonLang (minimum 2). */
function detectHeader(rows: Row[]): HeaderInfo | null {
  let best: HeaderInfo | null = null;
  // La ligne de langues est en pratique tout en haut ; on borne le scan.
  const maxScan = Math.min(rows.length, 30);
  for (let r = 0; r < maxScan; r++) {
    const row = rows[r];
    if (!row) continue;
    const langByCol = new Map<number, string>();
    const languages: string[] = [];
    const langLabels: Record<string, string> = {};
    // col 0 = colonne des libellés, jamais une langue
    for (let c = 1; c < row.length; c++) {
      const raw = cellText(row[c]);
      if (!raw || raw.length > 32) continue;
      const canon = canonHeader(raw);
      if (!canon) continue;
      langByCol.set(c, canon);
      if (!languages.includes(canon)) {
        languages.push(canon);
        if (raw !== canon) langLabels[canon] = raw;
      }
    }
    if (langByCol.size >= 2 && (!best || langByCol.size > best.langByCol.size)) {
      best = { rowIndex: r, langByCol, languages, langLabels };
    }
  }
  return best;
}

/** Valeurs par langue d'une ligne de bloc. Si deux colonnes canonicalisent vers
 *  le même code (groupe ambigu type EN / US-CA : même texte anglais), la
 *  première valeur non vide gagne. */
function rowValuesByLang(row: Row, header: HeaderInfo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [col, lang] of header.langByCol) {
    const value = cellText(row[col]);
    if (!value) continue;
    if (!(lang in out)) out[lang] = value;
  }
  return out;
}

/** Cible d'hyperlien d'une cellule (ws[addr].l.Target) — null si aucune. */
type LinkAt = (rowIndex: number, colIndex: number) => string | null;

/** URL d'un Linkthrough : texte affiché si c'est une URL, sinon la CIBLE de
 *  l'hyperlien de la cellule (une cellule "LINK" cliquable affiche "LINK" mais
 *  pointe vers la vraie URL), sinon le texte brut (comportement historique). */
function firstUrlAfterLabel(row: Row, rowIndex: number, linkAt: LinkAt | null): string | null {
  for (let c = 1; c < row.length; c++) {
    const display = cellText(row[c]);
    const target = linkAt?.(rowIndex, c) ?? null;
    if (/^https?:\/\//i.test(display)) return display;
    if (target) return target;
    if (display) return display;
  }
  return null;
}

function parseSheet(rows: Row[], linkAt: LinkAt | null): BriefGrid | null {
  const header = detectHeader(rows);
  if (!header) return null;

  const blocks: BriefBlock[] = [];
  const expectedLinks: ExpectedLink[] = [];
  // Dernier libellé non-Linkthrough rencontré : les paires WW/CN Linkthrough
  // en dessous lui sont rattachées (ex "PACKSHOT 1", 'CTA 2 "BOOK AN APPOINTMENT"').
  let lastLabel: string | null = null;
  let lastLabelValues: Record<string, string> | null = null;
  // Dernier BLOC poussé : les lignes de continuation (libellé fusionné
  // verticalement → col0 vide mais colonnes de langue remplies) lui sont
  // concaténées au lieu d'être jetées.
  let lastBlock: BriefBlock | null = null;

  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const label = cellText(row[0]);
    if (!label) {
      const contValues = rowValuesByLang(row, header);
      if (lastBlock && Object.keys(contValues).length > 0) {
        for (const [lang, v] of Object.entries(contValues)) {
          lastBlock.valueByLang[lang] = lastBlock.valueByLang[lang]
            ? `${lastBlock.valueByLang[lang]} ${v}`
            : v;
        }
      }
      continue;
    }

    const linkMatch = label.match(LINKTHROUGH);
    if (linkMatch) {
      lastBlock = null; // une continuation sous un Linkthrough n'est pas du contenu
      const url = firstUrlAfterLabel(row, r, linkAt);
      if (!url || !lastLabel) continue;
      const market = linkMatch[1].toUpperCase();
      let link = expectedLinks.find((l) => l.block === lastLabel);
      if (!link) {
        link = { block: lastLabel };
        if (lastLabelValues && Object.keys(lastLabelValues).length > 0) {
          link.ctaLabelByLang = lastLabelValues;
        }
        expectedLinks.push(link);
      }
      // Tout marché est capté (WW, CN, JP, US, KR…), pas seulement WW/CN.
      link.linksByMarket = { ...(link.linksByMarket ?? {}), [market]: url };
      if (market === "WW") link.ww = url;
      else if (market === "CN") link.cn = url;
      continue;
    }

    const values = rowValuesByLang(row, header);
    const filled = Object.keys(values).length;

    // Ligne "pseudo en-tête" répétée (template xlsm : "FIELD | DESCRIPTION | VALUE | EN | IT | ...")
    // → les valeurs sont elles-mêmes des codes langue : bruit, on ignore.
    if (
      filled >= 2 &&
      Object.entries(values).every(([lang, value]) => canonHeader(value) === lang)
    ) {
      continue;
    }

    lastLabel = label;
    lastLabelValues = filled > 0 ? values : null;

    // Bloc de contenu : libellé connu OU rempli sur ≥ 2 colonnes de langue
    // (écarte les métadonnées mono-colonne type "TARGET", "Sending date").
    if (filled >= 1 && (KNOWN_BLOCK_LABEL.test(label) || filled >= 2)) {
      const block: BriefBlock = { name: label, valueByLang: values };
      blocks.push(block);
      lastBlock = block;
    } else {
      lastBlock = null;
    }
  }

  if (blocks.length === 0 && expectedLinks.length === 0) return null;
  return {
    languages: header.languages,
    blocks,
    expectedLinks,
    ...(Object.keys(header.langLabels).length > 0 ? { langLabels: header.langLabels } : {}),
  };
}

// ── Format 2 : template .xlsm FIELD / DESCRIPTION / VALUE (brief STJ
// mono-marché) — feuille "EMAIL" avec Subject Line / Preheader / Body Copy /
// CTA … + URLs, nom Salesforce en tête, langues actives en feuille "Common".

/** Langues ACTIVÉES de la feuille Common : lignes "English → EN | Activate"
 *  sous le libellé INCLUDED LANGUAGES. Fallback ["EN"]. */
function includedLanguages(commonRows: Row[] | null): string[] {
  if (!commonRows) return ["EN"];
  const langs: string[] = [];
  let inSection = false;
  for (const row of commonRows) {
    if (!row) continue;
    const cells = row.map((c) => cellText(c));
    if (cells.some((c) => /^INCLUDED LANGUAGES/i.test(c))) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const labelCell = cells.find((c) => /→/.test(c));
    if (!labelCell) continue;
    const m = /→\s*([A-Za-z]{2,3})/.exec(labelCell);
    if (!m) continue;
    // `canonColumn` et non `canonLang` + LANG_LABEL : la feuille Common porte
    // les MÊMES codes que les colonnes ("Spanish (Mexico) → MX", "Thai → TH").
    // Avec la canonicalisation par langue, la ligne MX se repliait sur ES —
    // déjà dans la liste — et disparaissait ; la ligne TH n'était d'aucun
    // catalogue et sortait sans un mot. La liste des langues ACTIVÉES annonçait
    // donc moins de marchés que la campagne n'en visait, et c'est elle qui sert
    // ensuite de dénominateur aux absences (brief-template.ts:704).
    const canon = canonColumn(m[1]);
    const activated = cells.some((c) => /activate/i.test(c));
    if (activated && canon && !langs.includes(canon)) langs.push(canon);
  }
  return langs.length > 0 ? langs : ["EN"];
}

/** Télémétrie du parse : rend visibles les pertes aujourd'hui silencieuses
 *  (champs avec contenu réel non mappés, placeholders écartés). */
export interface BriefParseTelemetry {
  family: "field_value" | "grid" | "none";
  sheetUsed?: string;
  /** Champs porteurs de contenu réel (colonne langue remplie) mais non mappés
   *  vers un bloc canonique — perte de couverture QA. */
  unmappedFields: string[];
  /** Valeurs placeholder du template écartées de la grille (info). */
  droppedPlaceholders: number;
}

export function emptyTelemetry(): BriefParseTelemetry {
  return { family: "none", unmappedFields: [], droppedPlaceholders: 0 };
}

/** En-tête "FIELD | … | VALUE" d'une section template (20 premières lignes). */
function findFieldValueHeader(
  rows: Row[]
): { headerRow: number; fieldCol: number; valueCol: number } | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r];
    if (!row) continue;
    const cells = row.map((c) => cellText(c).toUpperCase());
    const fi = cells.indexOf("FIELD");
    const vi = cells.indexOf("VALUE");
    if (fi >= 0 && vi > fi) return { headerRow: r, fieldCol: fi, valueCol: vi };
  }
  return null;
}

// Métadonnées connues du template : jamais des blocs de contenu, jamais
// signalées comme "champ non mappé".
const META_FIELD_RE =
  /^(campaign ?name|target|mock ?up|task |priority$|category$|sub ?category|launch date|sending date|⚠️|content definition|email layout|season$|country$|note$|message (body|text)$|content$|url\d$)/i;

/** Parse une section FIELD/DESCRIPTION/VALUE du template .xlsm.
 *  Règles apprises des vrais briefs Kering :
 *  - la colonne VALUE recopie le TEMPLATE (placeholders "Dear [Name]…",
 *    brand.com) — le contenu réel vit dans les colonnes langue à droite ;
 *  - les marchés renomment librement les champs : suffixe parenthésé toléré
 *    ("Subject Line (male & others)" → bloc "Subject line (male & others)") ;
 *  - lignes "* URL" : l'URL réelle est cherchée d'abord dans les colonnes
 *    langue (texte ou hyperlien), le master placeholder ne gagne jamais ;
 *  - un template 100% vierge garde ses placeholders (bannière isLikelyTemplate),
 *    mais dès qu'un contenu réel existe, les placeholders sont écartés. */
function parseFieldValueSection(
  rows: Row[],
  linkAt: LinkAt | null,
  activatedLangs: string[],
  telemetry: BriefParseTelemetry
): BriefGrid | null {
  const header = findFieldValueHeader(rows);
  if (!header) return null;
  const { headerRow, fieldCol, valueCol } = header;

  // Colonnes par langue APRÈS la colonne VALUE (ex EN IT FR ES MX JP KO ZHS ZHT TH).
  // Le libellé ORIGINAL ("MX", "BR"…) est conservé pour l'affichage — le code
  // canonique (ES, PT…) reste la clé interne (détection de langue des mails).
  const headerCells = rows[headerRow] ?? [];
  const langCols: Array<{ col: number; lang: string; label: string }> = [];
  for (let c = valueCol + 1; c < headerCells.length; c++) {
    const label = cellText(headerCells[c]);
    const canon = canonHeader(label);
    if (canon && !langCols.some((x) => x.lang === canon)) langCols.push({ col: c, lang: canon, label });
  }

  // Nom de campagne Salesforce : ligne "Campaign Name" AVANT l'en-tête
  // (ex "ADHOC_GLOBAL_OTO_EMAIL_20260714_Le7BowlingBag").
  let salesforceCampaignName: string | undefined;
  for (let r = 0; r < headerRow; r++) {
    const row = rows[r];
    if (!row) continue;
    if (/^campaign ?name$/i.test(cellText(row[0]))) {
      const val = row.slice(1).map((c) => cellText(c)).find(Boolean);
      if (val && /_/.test(val)) salesforceCampaignName = val;
    }
  }

  // La feuille "Campaign Brief" enchaîne les canaux (EMAIL puis SMS, VMS…) :
  // on s'arrête au canal suivant pour ne parser que la section email.
  const CHANNEL_BREAK = /^(SMS|VMS|MMS|LINE|KKT|WECHAT|TASK|WHATSAPP)$/i;
  const masterLang = activatedLangs[0] ?? "EN";
  const blocks: Array<BriefBlock & { placeholderOnly?: boolean }> = [];
  const links: Array<ExpectedLink & { placeholderOnly?: boolean }> = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const field = cellText(row[fieldCol]);
    if (CHANNEL_BREAK.test(field)) break;
    if (!field) continue;

    const master = cellText(row[valueCol]) || (linkAt?.(r, valueCol) ?? "");
    const byLang: Record<string, string> = {};
    for (const { col, lang } of langCols) {
      const v = cellText(row[col]);
      if (v) byLang[lang] = v;
    }

    // Ligne URL (lien attendu) — le nom du bloc reste le LIBELLÉ EXACT du fichier.
    const urlMatch = /^(.+?)\s+URL(?:\s*-\s*(.+))?$/i.exec(field);
    if (urlMatch && (master || Object.keys(byLang).length > 0)) {
      const block = field.replace(/\s+URL\b/i, "").trim();
      // Priorité au contenu réel : colonnes langue (texte URL ou hyperlien),
      // puis master si ce n'est PAS un placeholder du template.
      let url: string | null = null;
      let placeholderOnly = false;
      for (const { col } of langCols) {
        const v = cellText(row[col]);
        if (/^https?:\/\//i.test(v) && !isPlaceholderUrl(v)) { url = v; break; }
        const t = linkAt?.(r, col) ?? null;
        if (t && !isPlaceholderUrl(t)) { url = t; break; }
      }
      if (!url && master) {
        const resolved = /^https?:\/\//i.test(master) ? master : (linkAt?.(r, valueCol) ?? master);
        if (isPlaceholderUrl(resolved)) {
          // Template vierge : gardé avec marqueur (sert à isLikelyTemplate),
          // écarté plus bas dès qu'un lien réel existe.
          url = resolved;
          placeholderOnly = true;
        } else url = resolved;
      }
      if (url) links.push({ block, ww: url, linksByMarket: { WW: url }, placeholderOnly });
      continue;
    }

    // FIDÉLITÉ 100% AU FICHIER (exigence Alina) : tout champ de contenu devient
    // un bloc avec son LIBELLÉ EXACT (pas de rename type "Body Copy"→"COPY 1"),
    // dans l'ordre du fichier. Seules les métadonnées connues (Campaign Name,
    // Target, Mock Up, dates…) sont écartées — signalées si elles portent du
    // contenu langue inattendu.
    if (META_FIELD_RE.test(field)) {
      if (Object.keys(byLang).length > 0) telemetry.unmappedFields.push(field);
      continue;
    }
    const name = field;
    if (Object.keys(byLang).length > 0) {
      blocks.push({ name, valueByLang: byLang });
    } else if (master) {
      // Pas de contenu langue : le master de la colonne VALUE est très
      // probablement le placeholder du template — marqué, écarté si la grille
      // a du contenu réel par ailleurs (template vierge : conservé).
      blocks.push({
        name,
        valueByLang: { [masterLang]: master },
        placeholderOnly: isPlaceholderText(master),
      });
    }
  }

  // Écarter les placeholders dès qu'un contenu réel existe (jamais sur un
  // template 100% vierge — la bannière isLikelyTemplate prend le relais).
  const hasReal = blocks.some((b) => !b.placeholderOnly) || links.some((l) => !l.placeholderOnly);
  if (hasReal) {
    telemetry.droppedPlaceholders +=
      blocks.filter((b) => b.placeholderOnly).length + links.filter((l) => l.placeholderOnly).length;
  }
  const keptBlocks: BriefBlock[] = (hasReal ? blocks.filter((b) => !b.placeholderOnly) : blocks)
    .map(({ placeholderOnly: _p, ...b }) => b);
  const keptLinks: ExpectedLink[] = (hasReal ? links.filter((l) => !l.placeholderOnly) : links)
    .map(({ placeholderOnly: _p, ...l }) => l);

  if (keptBlocks.length === 0) return null;

  // Appariement URL ↔ CTA : "CTA 2 URL" ou "Hero Asset / CTA URL" hérite du
  // libellé du bloc CTA correspondant (numéro, sinon CTA unique) — sans ça le
  // check aval liens-par-marché ne retrouve jamais le CTA dans le mail.
  const ctaBlocks = keptBlocks.filter((b) => /^CTA \d/i.test(b.name));
  for (const link of keptLinks) {
    if (link.ctaLabelByLang || !/cta/i.test(link.block ?? "")) continue;
    const num = /cta\s*(\d)/i.exec(link.block ?? "")?.[1];
    const blk = num
      ? ctaBlocks.find((b) => b.name.toUpperCase().startsWith(`CTA ${num}`))
      : ctaBlocks.length === 1
        ? ctaBlocks[0]
        : null;
    if (blk) link.ctaLabelByLang = blk.valueByLang;
  }

  // Langues de la grille = celles qui ont RÉELLEMENT du contenu (ordre des
  // colonnes), sinon la langue master seule — jamais de colonnes vides.
  const withContent = langCols.filter((x) => keptBlocks.some((b) => b.valueByLang[x.lang]));
  const languages = withContent.length > 0 ? withContent.map((x) => x.lang) : [masterLang];
  const langLabels: Record<string, string> = {};
  for (const x of withContent) if (x.label && x.label !== x.lang) langLabels[x.lang] = x.label;
  return {
    languages,
    blocks: keptBlocks,
    expectedLinks: keptLinks,
    salesforceCampaignName,
    ...(Object.keys(langLabels).length > 0 ? { langLabels } : {}),
  };
}

// Template VIERGE uploadé par erreur : la grille est majoritairement composée
// de placeholders du template (oracle lib/brief-placeholders, extrait du
// template vierge réel). Détection déterministe, 0 LLM.
function detectLikelyTemplate(grid: BriefGrid): boolean {
  const values = grid.blocks
    .flatMap((b) => Object.values(b.valueByLang))
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length === 0) return false;
  const hits = values.filter((v) => isPlaceholderText(v)).length;
  const urlHits = grid.expectedLinks.filter((l) => {
    const url = l.ww ?? Object.values(l.linksByMarket ?? {})[0] ?? "";
    return isPlaceholderUrl(url);
  }).length;
  return hits >= Math.ceil(values.length / 2) || (hits >= 2 && urlHits >= 2);
}

/** Parse déterministe d'un brief Excel → BriefGrid + télémétrie. Deux formats :
 *  1. template .xlsm FIELD/VALUE (famille Kering 14 feuilles) — PRIORITAIRE si
 *     une feuille "Campaign Brief" avec en-tête FIELD/VALUE existe : les
 *     feuilles canal (EMAIL, SMS…) sont des copies du template vierge, le
 *     contenu réel vit UNIQUEMENT dans "Campaign Brief" ;
 *  2. grille multilingue horizontale (BAL Newsletter / AMQ).
 *  grid=null si aucun format ne matche — le fallback LLM prend le relais. */
export async function parseBriefGridDetailed(
  buffer: Buffer
): Promise<{ grid: BriefGrid | null; telemetry: BriefParseTelemetry }> {
  const telemetry = emptyTelemetry();
  const XLSX = await import("xlsx");
  let wb: ReturnType<typeof XLSX.read>;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch {
    return { grid: null, telemetry };
  }

  // raw:false → texte FORMATÉ des cellules ("-50%", "14/07/2026") au lieu des
  // valeurs brutes (-0.5, 46217.08…) qui produisaient des "Attendu" absurdes.
  const sheetRows = (name: string): { rows: Row[]; linkAt: LinkAt } | null => {
    const ws = wb.Sheets[name];
    if (!ws) return null;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: false }) as Row[];
    const linkAt: LinkAt = (r, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as { l?: { Target?: string } } | undefined;
      return cell?.l?.Target ?? null;
    };
    return { rows, linkAt };
  };

  const tryFieldValue = (): BriefGrid | null => {
    const commonName = wb.SheetNames.find((n) => /^common$/i.test(n.trim()));
    const common = commonName ? sheetRows(commonName) : null;
    const activated = includedLanguages(common?.rows ?? null);
    for (const candidate of ["campaign brief", "email"]) {
      const name = wb.SheetNames.find((n) => n.trim().toLowerCase() === candidate);
      if (!name) continue;
      const sheet = sheetRows(name);
      if (!sheet) continue;
      const grid = parseFieldValueSection(sheet.rows, sheet.linkAt, activated, telemetry);
      if (grid) {
        telemetry.family = "field_value";
        telemetry.sheetUsed = name;
        grid.isLikelyTemplate = detectLikelyTemplate(grid);
        return grid;
      }
    }
    return null;
  };

  // Famille template Kering : "Campaign Brief" avec en-tête FIELD/VALUE
  // présent → format FIELD/VALUE prioritaire (Common optionnel — il ne sert
  // qu'aux langues activées). Sans ça, la boucle format-grille pourrait élire
  // une feuille canal placeholder "plus riche".
  const cbName = wb.SheetNames.find((n) => n.trim().toLowerCase() === "campaign brief");
  if (cbName) {
    const cbSheet = sheetRows(cbName);
    if (cbSheet && findFieldValueHeader(cbSheet.rows)) {
      const grid = tryFieldValue();
      if (grid) return { grid, telemetry };
    }
  }

  let best: BriefGrid | null = null;
  let bestSheet: string | undefined;
  for (const name of wb.SheetNames) {
    const sheet = sheetRows(name);
    if (!sheet) continue;
    const grid = parseSheet(sheet.rows, sheet.linkAt);
    if (!grid) continue;
    // Plusieurs feuilles candidates (brief multi-canal) : on garde la plus riche.
    if (!best || grid.blocks.length > best.blocks.length) {
      best = grid;
      bestSheet = name;
    }
  }
  if (best) {
    telemetry.family = "grid";
    telemetry.sheetUsed = bestSheet;
    best.isLikelyTemplate = detectLikelyTemplate(best);
    return { grid: best, telemetry };
  }

  // Fallback : template FIELD/VALUE sans feuille "Campaign Brief" (ex EMAIL seule).
  const grid = tryFieldValue();
  return { grid, telemetry };
}

/** Wrapper compatible historique — voir parseBriefGridDetailed. */
export async function parseBriefGrid(buffer: Buffer): Promise<BriefGrid | null> {
  return (await parseBriefGridDetailed(buffer)).grid;
}
