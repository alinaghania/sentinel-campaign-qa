// Rattachement email → campagne par heuristique pure (pas de LLM).
// Matche les tokens significatifs du nom de campagne (et du nom de marque
// si la liste des marques est fournie) dans le sujet du mail.
// Ex : sujet "[TEST WW Balenciaga Le 7 Bowling Bag]" → campagne "Balenciaga Le 7".

import type { Brand, Campaign } from "./types";

/** Tokens trop génériques pour signifier quoi que ce soit dans un sujet de mail. */
const STOPWORDS = new Set([
  // marqueurs de test / routine
  "test",
  "proof",
  "draft",
  "final",
  "preview",
  // vocabulaire campagne
  "email",
  "mail",
  "newsletter",
  "campagne",
  "campaign",
  "adhoc",
  "global",
  "oto",
  // marchés / scopes fréquents
  "ww",
  "worldwide",
  // liaisons FR/EN restantes après filtre longueur
  "the",
  "les",
  "des",
  "pour",
  "avec",
  "and",
  "new",
]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens significatifs : ≥ 3 caractères, hors stopwords. */
function significantTokens(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Trouve la campagne la plus probable pour un email à partir de son sujet
 * (et accessoirement de l'expéditeur). Heuristique par recouvrement de tokens :
 * chaque token significatif du nom de campagne / de marque présent dans le
 * sujet compte, les tokens longs (≥ 5, typiquement le nom de marque) pèsent double.
 *
 * @param brands optionnel — permet de résoudre campaign.brandId → nom de marque ;
 *               si absent, le brandId est ignoré.
 * @returns le meilleur match au-dessus du seuil, avec un niveau de confiance,
 *          ou null si rien de convaincant.
 */
export function matchCampaignForEmail(
  email: { subject?: string; from?: string },
  campaigns: Campaign[],
  brands?: Array<Pick<Brand, "id" | "name">>
): { campaignId: string; confidence: "high" | "medium" | "low" } | null {
  const subject = email.subject ?? "";
  const haystackTokens = new Set([
    ...significantTokens(subject),
    ...significantTokens(email.from ?? ""),
  ]);
  if (!haystackTokens.size) return null;

  const brandNameById = new Map<string, string>();
  for (const b of brands ?? []) brandNameById.set(b.id, b.name);

  let best: { campaignId: string; score: number; ratio: number } | null = null;

  for (const c of campaigns) {
    const nameTokens = significantTokens(c.name);
    const brandName = c.brandId ? brandNameById.get(c.brandId) : undefined;
    const brandTokens = brandName ? significantTokens(brandName) : [];
    const candidates = new Set([...nameTokens, ...brandTokens]);
    if (!candidates.size) continue;

    let score = 0;
    let matched = 0;
    for (const t of candidates) {
      if (!haystackTokens.has(t)) continue;
      matched++;
      // Les tokens longs (noms de marque/produit) sont bien plus discriminants.
      score += t.length >= 5 ? 2 : 1;
    }
    if (!matched) continue;
    const ratio = matched / candidates.size;

    if (
      !best ||
      score > best.score ||
      (score === best.score && ratio > best.ratio)
    ) {
      best = { campaignId: c.id, score, ratio };
    }
  }

  // Seuil : au moins un token discriminant (long) ou deux tokens courts.
  if (!best || best.score < 2) return null;

  const confidence: "high" | "medium" | "low" =
    best.score >= 4 || (best.score >= 2 && best.ratio >= 0.75)
      ? "high"
      : best.score >= 3 || best.ratio >= 0.5
        ? "medium"
        : "low";

  return { campaignId: best.campaignId, confidence };
}
