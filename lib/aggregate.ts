// Agrégation déterministe : dédup, compteurs, verdict à TROIS états.
// Pas de score /100 (indéfendable) : 1 CRITIQUE non arbitré = NO-GO, point.

import type { Finding, Verdict } from "./types";

export type { Verdict };

/** Un verdict qui INTERDIT l'envoi. Seul NO_GO bloque.
 *  Centralisé ici pour qu'aucun appelant ne réinvente `!== "GO"` — ce test-là
 *  rangerait les réserves du côté du refus, ce qui est précisément l'erreur
 *  que le troisième état corrige. */
export function isBlocking(verdict: Verdict): boolean {
  return verdict === "NO_GO";
}

function normMsg(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function dedupFindings(findings: Finding[]): Finding[] {
  const order = { CRITIQUE: 3, MAJEUR: 2, MINEUR: 1, OK: 0 } as const;
  const map = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.categorie}|${f.locator}|${normMsg(f.message)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, f);
    } else {
      // garder la sévérité max, concaténer les agents ; le diff expected/
      // received et le title survivent même s'ils sont portés par le PERDANT
      // (sinon le surlignage disparaît de l'UI/Excel à la dédup).
      const keep = order[f.severite] > order[existing.severite] ? f : existing;
      const lose = keep === f ? existing : f;
      const agents = new Set([existing.agent, f.agent]);
      map.set(key, {
        ...keep,
        agent: [...agents].join(" + "),
        title: keep.title ?? lose.title,
        expected: keep.expected ?? lose.expected,
        received: keep.received ?? lose.received,
      });
    }
  }
  const sevRank = (f: Finding) => -order[f.severite];
  return [...map.values()].sort((a, b) => sevRank(a) - sevRank(b));
}

export function computeVerdict(findings: Finding[]): {
  verdict: Verdict;
  counters: { critiques: number; majeurs: number; mineurs: number; passed: number };
} {
  // tout finding arbitré par l'humain (traité) sort du décompte et du verdict
  const active = findings.filter((f) => !f.review);
  const critiques = active.filter((f) => f.severite === "CRITIQUE").length;
  const majeurs = active.filter((f) => f.severite === "MAJEUR").length;
  const mineurs = active.filter((f) => f.severite === "MINEUR").length;
  return {
    // Exigence Alina (process client Kering), RÉVISÉE le 04/09/2026 par Alina
    // après mesure : la règle précédente (`active.length > 0 ? NO_GO : GO`)
    // rendait NO_GO sur le MOINDRE finding, y compris MINEUR. Elle prévoyait
    // que le GO s'obtienne par l'arbitrage humain de chaque finding ; sur les
    // 40 analyses du build déployé, cet arbitrage a eu lieu 1 fois sur 2 118
    // findings, et le GO n'a donc JAMAIS été atteint.
    //
    // Ce qui NE change pas : un seul CRITIQUE actif bloque, sans discussion.
    // Ce qui change : un mail sans critique n'est plus refusé — il est rendu
    // avec ses réserves, qui restent toutes visibles et toutes arbitrables.
    // Aucune règle n'est désactivée, aucun finding n'est masqué : seule la
    // PHRASE de sortie change.
    verdict: critiques > 0 ? "NO_GO" : active.length > 0 ? "GO_AVEC_RESERVES" : "GO",
    counters: { critiques, majeurs, mineurs, passed: 0 },
  };
}
