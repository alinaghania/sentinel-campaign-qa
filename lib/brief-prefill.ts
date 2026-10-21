// Sens inverse de buildTemplateWorkbook : une BriefGrid (ce que le parseur a lu
// dans un fichier importé) → le `fill` du tableau « Brief & template »
// (clé de champ → code de colonne → texte).
//
// Pourquoi ici et pas dans l'écran : l'appariement doit être celui de
// validateAgainstTemplate (mêmes `fieldLookupKeys`, même `normLabel`, mêmes
// codes canoniques). Une seconde règle d'appariement ferait remplir au tableau
// des cellules que la mesure de conformité ne reconnaîtrait pas.
//
// Rien n'est inventé : une cellule sans contenu dans la grille reste ABSENTE du
// fill, et ce qui ne trouve pas sa place est RENDU (`unmatched`), pas jeté.

import { canonColumn } from "./lang-codes";
import { fieldLookupKeys, normLabel, type BriefTemplateField } from "./brief-template";
import type { BriefGrid } from "./types";

/** Code de la colonne VALUE (master), comme dans BriefComposer. */
const MASTER = "";

export interface PrefillResult {
  fill: Record<string, Record<string, string>>;
  /** Nombre de cellules non vides posées. */
  cells: number;
  /** Lignes de la grille qui n'appartiennent à AUCUN champ du template. */
  unmatched: UnmatchedRow[];
}

export interface UnmatchedRow {
  /** Libellé tel qu'il serait écrit en colonne FIELD (« … URL » pour un lien). */
  label: string;
  kind: "text" | "url";
  translatable: boolean;
}

export function gridToFill(
  grid: BriefGrid,
  tpl: { fields: readonly BriefTemplateField[]; languageColumns: readonly string[] }
): PrefillResult {
  // Blocs indexés par libellé normalisé, fusion « première valeur non vide »
  // (même convention que validateAgainstTemplate : « Subject Line (female) » et
  // « (male & others) » partagent une clé).
  const blocks = new Map<string, { name: string; valueByLang: Record<string, string> }>();
  for (const b of grid.blocks) {
    const key = normLabel(b.name);
    const seen = blocks.get(key);
    if (!seen) {
      blocks.set(key, { name: b.name, valueByLang: { ...b.valueByLang } });
      continue;
    }
    for (const [lang, v] of Object.entries(b.valueByLang)) {
      if (!seen.valueByLang[lang]?.trim() && v?.trim()) seen.valueByLang[lang] = v;
    }
  }
  const links = new Map<string, Record<string, string>>();
  for (const l of grid.expectedLinks) {
    if (l.block) links.set(normLabel(l.block), { ...(l.linksByMarket ?? {}) });
  }

  // La grille range ses valeurs sous le code CANONIQUE (ou un groupe « EN|US-CA »).
  const langValue = (values: Record<string, string>, code: string): string => {
    const canon = canonColumn(code);
    if (!canon) return "";
    if (values[canon]?.trim()) return values[canon];
    const grouped = Object.entries(values).find(([k, v]) => k.split("|").includes(canon) && v?.trim());
    return grouped?.[1] ?? "";
  };

  const fill: Record<string, Record<string, string>> = {};
  const matchedKeys = new Set<string>();
  let cells = 0;
  const put = (fieldKey: string, col: string, text: string | undefined) => {
    if (!text?.trim()) return;
    (fill[fieldKey] ??= {})[col] = text;
    cells++;
  };

  for (const f of tpl.fields) {
    if (f.kind === "meta") continue;
    const lookups = fieldLookupKeys(f);
    if (f.kind === "url") {
      const hit = lookups.find((k) => links.has(k));
      if (!hit) continue;
      matchedKeys.add(hit);
      const byMarket = links.get(hit)!;
      // Un lien par marché si le template a la colonne ; WW = le lien commun.
      for (const code of tpl.languageColumns) put(f.key, code, byMarket[code.toUpperCase()]);
      put(f.key, MASTER, byMarket.WW);
      continue;
    }
    const hit = lookups.find((k) => blocks.has(k));
    if (!hit) continue;
    matchedKeys.add(hit);
    const values = blocks.get(hit)!.valueByLang;
    if (!f.translatable) {
      // Contenu non traduit : colonne VALUE.
      put(f.key, MASTER, Object.values(values).find((v) => v?.trim()));
      continue;
    }
    for (const code of tpl.languageColumns) put(f.key, code, langValue(values, code));
  }

  const unmatched = [
    ...[...blocks.entries()]
      .filter(([k]) => !matchedKeys.has(k))
      .map(([, v]): UnmatchedRow => ({
        label: v.name,
        kind: "text",
        // Une seule valeur dans une grille multilingue = contenu non traduit.
        translatable: Object.keys(v.valueByLang).length > 1 || grid.languages.length <= 1,
      })),
    ...grid.expectedLinks
      .filter((l) => l.block && !matchedKeys.has(normLabel(l.block)))
      .map((l): UnmatchedRow => ({ label: `${l.block} URL`, kind: "url", translatable: false })),
  ];
  return { fill, cells, unmatched };
}

/** Ce qu'il manque au template pour contenir ce brief : une colonne par langue
 *  que la plateforme sait porter et que le template n'a pas, un champ par ligne
 *  sans place. Proposition PURE — rien n'est écrit ; l'écran la montre, et c'est
 *  l'enregistrement du template qui fait foi. */
export function templateGap(
  grid: BriefGrid,
  tpl: { fields: readonly BriefTemplateField[]; languageColumns: readonly string[] }
): { rows: UnmatchedRow[]; languageColumns: string[]; unsupportedLanguages: string[] } {
  const covered = new Set(tpl.languageColumns.map((c) => canonColumn(c)).filter(Boolean));
  const languageColumns: string[] = [];
  const unsupportedLanguages: string[] = [];
  for (const lang of grid.languages) {
    // Libellé ORIGINAL du fichier (« MX »), pas le code interne (« ES »).
    const code = (grid.langLabels?.[lang] ?? lang.split("|")[0]).trim().toUpperCase();
    const canon = canonColumn(code);
    if (!canon) unsupportedLanguages.push(code);
    else if (!covered.has(canon) && !languageColumns.includes(code)) languageColumns.push(code);
  }
  return { rows: gridToFill(grid, tpl).unmatched, languageColumns, unsupportedLanguages };
}
