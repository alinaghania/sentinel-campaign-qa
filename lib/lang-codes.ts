// Canonicalisation des codes langue — les briefs Kering utilisent des codes
// incohérents selon le fichier source :
//   - grille BAL Newsletter : "EN (exl. US - CA)", "US - CA", "FR", "IT", "ES - MX", "BR", "KR", "JP", "CN"
//   - xlsm (Common/EMAIL)  : "KO", "ZHS", ...
//   - AMQ                  : "en-GB", "de-DE", "fr-FR", "it-IT", "ja-JP", "ko-KR"
// On ramène tout à un code CANONIQUE (ISO 639-1 upper) : EN, FR, IT, ES, PT, DE, KO, JA, ZH...
// Rappel métier : le brief est PAR LANGUE (pas par pays) — EN et US-CA sont la
// MÊME langue ; l'ambiguïté de marché se gère ailleurs (groupe "EN|US-CA"),
// pas ici.
//
// Module pur, aucune dépendance externe.

/** Alias -> code canonique. Clés déjà normalisées (upper, trim). */
const ALIASES: Record<string, string> = {
  // Anglais
  EN: "EN",
  ENG: "EN",
  ENGLISH: "EN",
  "US - CA": "EN",
  "US-CA": "EN",
  US: "EN",
  CA: "EN",
  GB: "EN",
  UK: "EN",
  // Français
  FR: "FR",
  FRA: "FR",
  FRENCH: "FR",
  // Italien
  IT: "IT",
  ITA: "IT",
  ITALIAN: "IT",
  // Espagnol (la grille utilise "ES - MX" : espagnol Espagne + Mexique)
  ES: "ES",
  "ES - MX": "ES",
  "ES-MX": "ES",
  MX: "ES",
  SPA: "ES",
  SPANISH: "ES",
  // Portugais (la grille utilise "BR" pour le portugais brésilien)
  PT: "PT",
  BR: "PT",
  "PT-BR": "PT",
  POR: "PT",
  PORTUGUESE: "PT",
  // Allemand
  DE: "DE",
  GER: "DE",
  DEU: "DE",
  GERMAN: "DE",
  // Coréen (grille=KR, xlsm=KO, AMQ=ko-KR)
  KO: "KO",
  KR: "KO",
  KOR: "KO",
  KOREAN: "KO",
  // Japonais (grille=JP, AMQ=ja-JP)
  JA: "JA",
  JP: "JA",
  JPN: "JA",
  JAPANESE: "JA",
  // Chinois (grille=CN, xlsm=ZHS, ailleurs zh-CN / zh-Hans)
  ZH: "ZH",
  CN: "ZH",
  ZHS: "ZH",
  ZHT: "ZH",
  "ZH-CN": "ZH",
  "ZH-HANS": "ZH",
  CHINESE: "ZH",
  "SIMPLIFIED CHINESE": "ZH",
  // Thaï. Déclaré par le template livré (11e colonne) et absent d'ici jusqu'au
  // 2026-09-04 : `canonLang("TH")` rendait bien "TH" par le repli du point 4,
  // mais "TH" n'était clé d'aucun catalogue, donc `canonColumn` le refusait et
  // la colonne n'était pas reconnue comme une langue DU TOUT. Ni clé, ni texte,
  // ni trace : un brief thaï parfaitement rempli arrivait vide.
  TH: "TH",
  THA: "TH",
  THAI: "TH",
  // Autres langues courantes chez Kering
  NL: "NL",
  DUTCH: "NL",
  RU: "RU",
  RUSSIAN: "RU",
  AR: "AR",
  ARABIC: "AR",
};

/** Libellés d'affichage par code canonique. */
export const LANG_LABEL: Record<string, string> = {
  EN: "English",
  FR: "Français",
  IT: "Italiano",
  ES: "Español",
  PT: "Português",
  DE: "Deutsch",
  KO: "한국어 (Korean)",
  JA: "日本語 (Japanese)",
  ZH: "中文 (Chinese)",
  TH: "ไทย (Thai)",
  NL: "Nederlands",
  RU: "Русский (Russian)",
  AR: "العربية (Arabic)",
};

// ---------------------------------------------------------------------------
// COLONNE ≠ LANGUE
// ---------------------------------------------------------------------------
// Deux questions différentes partageaient `canonLang`, et la seconde recevait
// la réponse de la première :
//
//   « En quelle LANGUE est ce texte ? »  — l'espagnol du Mexique EST de
//     l'espagnol. Aucune détection de langue ne sépare ES de MX sur du texte
//     seul, et c'est très bien : `canonLang` a raison de les confondre.
//
//   « De quelle COLONNE du brief vient ce texte ? » — ES et MX sont deux
//     colonnes, deux marchés, deux livrables qu'un chef de projet relit
//     séparément. Les confondre n'est pas une approximation, c'est une perte.
//
// Le coût mesuré de la confusion, sur les 11 colonnes du template livré :
// `brief-grid.ts` ne retient que la PREMIÈRE colonne d'un code canonique donné.
// MX arrivait après ES, ZHT après ZHS : leurs cellules n'entraient dans aucune
// boucle. Elles n'étaient pas écrasées — elles n'étaient jamais LUES. Et qui
// demandait le mexicain recevait le texte espagnol : une valeur non vide,
// plausible, et fausse. Un écran vide se remarque ; celui-là non.
//
// Ne sont promus ici que les codes dont le défaut a été MESURÉ sur le template
// livré. BR, US-CA et CN restent de simples alias : ils n'entrent en collision
// avec rien dans les briefs réels, et promouvoir un code sans défaut à réparer
// changerait des clés en production sans rien réparer.
//
// Clé = code tel que le TEMPLATE le déclare (c'est lui qui fait foi, cf. la
// table des langues éditable). Valeur = langue sous-jacente, celle que la
// détection de langue d'un mail peut rendre.
export const MARKET_COLUMNS: Record<string, string> = {
  MX: "ES",
  ZHS: "ZH",
  ZHT: "ZH",
};

/** Libellés d'affichage des colonnes de marché. */
const MARKET_LABEL: Record<string, string> = {
  MX: "Español (México)",
  ZHS: "简体中文 (Simplified Chinese)",
  ZHT: "繁體中文 (Traditional Chinese)",
};

/**
 * Clé de COLONNE pour un en-tête de brief. C'est l'identité d'une colonne du
 * classeur, pas celle d'une langue.
 *
 * Retourne `null` si l'en-tête n'est pas une colonne de langue reconnue — et ce
 * refus est la raison d'être de la fonction : sans lui, "FIELD",
 * "DESCRIPTION", "VALUE" ou "REQUIRED" seraient pris pour des langues et la
 * grille n'aurait plus de sens. Élargir ce catalogue se paie donc en
 * faux positifs sur les en-têtes de structure ; on n'y ajoute qu'un code
 * effectivement déclaré par un template.
 */
export function canonColumn(raw: string): string | null {
  const norm = normalize(raw);
  if (norm.length === 0) return null;
  // Un code de marché se reconnaît AVANT toute canonicalisation : c'est
  // précisément parce que `canonLang` l'aplatit sur son voisin qu'il est ici.
  if (norm in MARKET_COLUMNS) return norm;
  const canon = canonLang(raw);
  return canon && canon in LANG_LABEL ? canon : null;
}

/** Langue sous-jacente d'une clé de colonne : "MX" → "ES", "ZHT" → "ZH".
 *  C'est par elle qu'un mail détecté espagnol retrouve la colonne MX. */
export function baseLang(columnKey: string): string {
  const norm = normalize(columnKey);
  return MARKET_COLUMNS[norm] ?? canonLang(columnKey);
}

/** Normalise une chaîne brute : trim, upper, espaces multiples réduits. */
function normalize(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Canonicalise un code langue hétérogène vers un code ISO 639-1 upper.
 * Exemples :
 *   "KR", "KO", "ko-KR", "Korean"            -> "KO"
 *   "CN", "ZHS", "zh-CN", "Simplified Chinese" -> "ZH"
 *   "JP", "ja-JP"                             -> "JA"
 *   "EN (exl. US - CA)", "US - CA", "en-GB"   -> "EN"
 *   "ES - MX", "BR", "pt-BR"                  -> "ES" / "PT"
 * Si aucun alias ne matche, renvoie la chaîne normalisée telle quelle
 * (jamais d'exception : un code inconnu reste comparable à lui-même).
 */
export function canonLang(raw: string): string {
  const norm = normalize(raw);
  if (norm.length === 0) return "";

  // 1. Match direct sur la chaîne complète (couvre "US - CA", "ES - MX", "zh-CN"...)
  const direct = ALIASES[norm];
  if (direct) return direct;

  // 2. Retirer une éventuelle parenthèse : "EN (exl. US - CA)" -> "EN"
  const beforeParen = norm.split("(")[0].trim();
  if (beforeParen !== norm) {
    const hit = ALIASES[beforeParen];
    if (hit) return hit;
  }

  // 3. Préfixe avant "-" ou "_" : "ko-KR" -> "KO", "pt_BR" -> "PT"
  const prefix = beforeParen.split(/[-_/]/)[0].trim();
  if (prefix.length > 0) {
    const hit = ALIASES[prefix];
    if (hit) return hit;
  }

  // 4. Inconnu : renvoyer la forme normalisée (préfixe si dispo, sinon tout)
  return prefix.length > 0 ? prefix : norm;
}

/** Deux codes bruts désignent-ils la même langue ? */
export function sameLang(a: string, b: string): boolean {
  return canonLang(a) === canonLang(b);
}

/** Libellé d'affichage pour un code (brut, canonique ou de marché).
 *  Fallback : le code canonique. Le cas de marché passe AVANT, sinon "MX"
 *  s'afficherait "Español" — le libellé du voisin, exactement l'erreur que
 *  `canonColumn` existe pour ne plus commettre. */
export function displayLang(code: string): string {
  const norm = normalize(code);
  if (norm in MARKET_LABEL) return MARKET_LABEL[norm];
  const canon = canonLang(code);
  return LANG_LABEL[canon] ?? canon;
}
