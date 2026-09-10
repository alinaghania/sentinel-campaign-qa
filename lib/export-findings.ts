// Helpers d'export Excel des findings (module SERVEUR — types exceljs).
// Le titre harmonisé + le diff expected/received sont rendus en richText :
// titre en gras, passages différents en gras coloré (équivalent du surlignage
// jaune de l'UI, lisible même sans parler la langue du mail).

import type ExcelJS from "exceljs";
import { diffSegments } from "./diff";
import { titleForFinding } from "./finding-titles";
import type { Finding } from "./types";

/** Excel (XML 1.0) rejette les caractères de contrôle : strip pur et simple
 *  (\t \n \r conservés — seuls caractères de contrôle légaux en XML 1.0). */
export function sanitizeXml(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/** Couleur des passages différents (ambre foncé lisible sur fond jaune pâle). */
const DIFF_ARGB = "FF9A6A00";

/** Cellule richText d'un finding : titre en gras, explication en dessous. */
export function findingRichText(f: Finding): ExcelJS.CellRichTextValue {
  return {
    richText: [
      { text: sanitizeXml(titleForFinding(f)), font: { bold: true } },
      { text: `\n${sanitizeXml(f.message)}` },
    ],
  };
}

/** Cellule richText d'UNE valeur du diff expected/received : les segments qui
 *  diffèrent de l'autre valeur en gras coloré. diffSegments plafonne à 1200
 *  tokens : la queue tronquée est réinjectée en segment non-changed (le texte
 *  affiché reste TOUJOURS complet). Valeur vide → cellule vide (undefined). */
export function diffRichText(
  value: string | undefined,
  other: string | undefined
): ExcelJS.CellRichTextValue | undefined {
  const v = (value ?? "").trim();
  if (!v) return undefined;
  const segs = diffSegments(v, (other ?? "").trim()).a;
  const richText: ExcelJS.RichText[] = segs.map((s) =>
    s.changed
      ? { text: sanitizeXml(s.text), font: { bold: true, color: { argb: DIFF_ARGB } } }
      : { text: sanitizeXml(s.text) }
  );
  // Queue au-delà du cap tokens de diffSegments (les segments couvrent
  // exactement le préfixe tokenisé) : réinjectée telle quelle, non surlignée.
  const consumed = segs.reduce((n, s) => n + s.text.length, 0);
  if (consumed < v.length) richText.push({ text: sanitizeXml(v.slice(consumed)) });
  return { richText };
}
