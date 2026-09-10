// Matching email reçu ↔ campagne : score multi-signaux.
// Score haut → rattachement auto ; ambigu → confirmation humaine (1 clic) ;
// jamais d'analyse silencieuse sur un mauvais match.

import type { Campaign, InboxEmail } from "./types";
import { parseEmailFacts } from "./parse-email";

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(norm(a).split(" ").filter((t) => t.length > 2));
  const tb = new Set(norm(b).split(" ").filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size);
}

export function matchEmailToCampaigns(
  email: InboxEmail,
  campaigns: Campaign[]
): { campaignId: string; score: number } | null {
  let best: { campaignId: string; score: number } | null = null;
  const utmCampaigns = new Set<string>();
  if (email.html) {
    try {
      for (const l of parseEmailFacts(email.html).links) {
        const c = l.utm["utm_campaign"];
        if (c) utmCampaigns.add(norm(c));
      }
    } catch {
      // HTML illisible — matching sur l'objet seulement
    }
  }

  for (const c of campaigns) {
    if (c.status === "ENVOYE") continue;
    let score = 0;
    // Signal fort : utm_campaign du mail ≈ nom de campagne ou utm du brief
    const expectedUtm = c.briefExtraction?.utm_campaign?.value;
    for (const u of utmCampaigns) {
      if (expectedUtm && u === norm(expectedUtm)) score += 0.6;
      else if (tokenOverlap(u, c.name) > 0.5) score += 0.4;
    }
    // Similarité objet reçu vs objet attendu / nom de campagne
    const expectedSubject = c.briefExtraction?.subject_line?.value;
    if (expectedSubject) score += 0.4 * tokenOverlap(email.subject, expectedSubject);
    score += 0.3 * tokenOverlap(email.subject, c.name);
    // Fenêtre temporelle : campagne en attente d'email
    if (c.status === "EMAIL_ATTENDU" || c.status === "CORRECTIONS") score += 0.1;

    if (score > (best?.score ?? 0)) best = { campaignId: c.id, score };
  }
  if (!best || best.score < 0.25) return null;
  return { ...best, score: Math.min(1, best.score) };
}

export const MATCH_AUTO_THRESHOLD = 0.6;
