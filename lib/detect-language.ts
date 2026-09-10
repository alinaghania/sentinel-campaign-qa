// Détection de la langue d'un email reçu par comparaison avec la grille du brief.
//
// Le brief est PAR LANGUE (pas par pays) : plusieurs colonnes (ex EN et US-CA)
// peuvent porter EXACTEMENT le même texte. Dans ce cas on ne tranche pas :
// on retourne la 1re langue du groupe + la liste `ambiguous`.

import type { BriefGrid, EmailFacts } from "./types";
import { canonLang } from "./lang-codes";

export interface DetectedLanguage {
  /** Code langue canonique détecté (1re langue du groupe si ambigu), ou null. */
  lang: string | null;
  /** Groupe de langues indistinguables (contenu identique dans le brief), ex ["EN","US-CA"]. */
  ambiguous?: string[];
  confidence: "high" | "medium" | "low";
}

/** Normalisation tolérante : espaces (y compris insécables), apostrophes
 *  typographiques, guillemets, casse. */
function normalize(s: string): string {
  return s
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[\u00a0\u2000-\u200b\u202f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Éclate une clé de langue potentiellement composite ("EN|US-CA") en codes canoniques. */
function expandLangKey(key: string): string[] {
  return key
    .split("|")
    .map((c) => canonLang(c.trim()) || c.trim())
    .filter((c) => c.length > 0);
}

interface LangScore {
  key: string; // clé telle qu'elle apparaît dans la grille
  codes: string[]; // codes canoniques (>=1, plusieurs si clé composite)
  score: number; // nb de blocs du brief retrouvés dans l'email
  signature: string; // empreinte du contenu (pour détecter les langues identiques)
}

/**
 * Détecte la langue d'un email reçu en le comparant au BriefGrid.
 *
 * Stratégie :
 * 1. Score chaque langue de la grille : nb de blocs (subject line, copies, CTA...)
 *    dont le texte normalisé est retrouvé dans le subject / les textBlocks de l'email.
 * 2. Si plusieurs langues gagnantes ont un contenu de brief IDENTIQUE (ex EN vs US-CA),
 *    on retourne la 1re + `ambiguous` = tout le groupe (on ne tranche pas artificiellement).
 * 3. Fallbacks (aucun match texte) : <html lang>, puis utm_campaign des liens, sinon null.
 */
export function detectEmailLanguage(
  facts: EmailFacts,
  grid: BriefGrid | null | undefined
): DetectedLanguage {
  // --- 1. Corpus de l'email, normalisé ---
  const emailTexts: string[] = [];
  if (facts.subject) emailTexts.push(normalize(facts.subject));
  if (facts.preheader) emailTexts.push(normalize(facts.preheader));
  for (const t of facts.textBlocks) {
    const n = normalize(t);
    if (n.length > 1) emailTexts.push(n);
  }
  const emailJoined = emailTexts.join(" \n ");

  // --- 2. Score par langue de la grille ---
  if (grid && grid.languages.length > 0 && grid.blocks.length > 0) {
    const scores: LangScore[] = grid.languages.map((key) => {
      const values: string[] = [];
      let score = 0;
      for (const block of grid.blocks) {
        const raw = block.valueByLang[key];
        if (!raw) continue;
        const val = normalize(raw);
        if (val.length < 2) continue;
        values.push(`${block.name}::${val}`);
        // Un bloc "matche" si sa valeur apparaît telle quelle dans l'email
        // (dans un textBlock, le subject, ou le corpus joint pour les blocs
        // éclatés sur plusieurs lignes). La direction inverse (val contient un
        // textBlock) n'est acceptée que si le textBlock couvre l'essentiel de
        // la valeur — sinon un bloc court commun ("Balenciaga") fait scorer
        // TOUTES les langues et un mail JA sort détecté EN.
        const matched =
          emailTexts.some(
            (t) =>
              t === val ||
              t.includes(val) ||
              (val.includes(t) && t.length >= 0.8 * val.length)
          ) || emailJoined.includes(val);
        if (matched) score++;
      }
      return {
        key,
        codes: expandLangKey(key),
        score,
        signature: values.join(" || "),
      };
    });

    const best = scores.reduce((a, b) => (b.score > a.score ? b : a), scores[0]);

    if (best && best.score > 0) {
      // Groupe des langues indistinguables : même score maximal ET même contenu de brief.
      const winners = scores.filter(
        (s) => s.score === best.score && s.signature === best.signature
      );
      const groupCodes = [...new Set(winners.flatMap((w) => w.codes))];

      // Vérifie qu'une autre langue (contenu différent) ne fait pas jeu égal :
      // dans ce cas la détection est incertaine.
      const rivals = scores.filter(
        (s) => s.score === best.score && s.signature !== best.signature
      );

      const confidence: DetectedLanguage["confidence"] =
        rivals.length > 0 ? "low" : best.score >= 2 ? "high" : "medium";

      return {
        lang: groupCodes[0] ?? null,
        ambiguous: groupCodes.length > 1 ? groupCodes : undefined,
        confidence,
      };
    }
  }

  // --- 3. Fallback : attribut <html lang> ---
  if (facts.lang) {
    const canon = canonLang(facts.lang);
    if (canon) return { lang: canon, confidence: "medium" };
  }

  // --- 4. Fallback : utm_campaign des liens (convention: utm_campaign = code langue, ex FR) ---
  // canonLang renvoie la chaîne normalisée même pour un inconnu : on ne garde que
  // les valeurs qui RESSEMBLENT à un code langue (évite de prendre un nom de
  // campagne "ADHOC_GLOBAL_..." pour une langue).
  const looksLikeLangCode = /^[A-Za-z]{2,3}([-_ ]+[A-Za-z]{2,3})?$/;
  const utmCounts = new Map<string, number>();
  for (const link of facts.links) {
    const utmCampaign = link.utm["utm_campaign"];
    if (!utmCampaign || !looksLikeLangCode.test(utmCampaign.trim())) continue;
    const canon = canonLang(utmCampaign);
    if (!canon) continue;
    utmCounts.set(canon, (utmCounts.get(canon) ?? 0) + 1);
  }
  let bestUtm: string | null = null;
  let bestUtmCount = 0;
  for (const [code, count] of utmCounts) {
    if (count > bestUtmCount) {
      bestUtm = code;
      bestUtmCount = count;
    }
  }
  if (bestUtm) return { lang: bestUtm, confidence: "low" };

  return { lang: null, confidence: "low" };
}
