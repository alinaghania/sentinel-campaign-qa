// Audit LLM de complétude du parsing de brief — format-agnostique (reçoit le
// TEXTE extrait, marche pour Excel/PPT/PDF/Word). Compare le brief brut à ce
// qu'on a capté automatiquement et liste ce qui a été MANQUÉ (bloc, marché de
// lien, langue, mention légale, note). Non bloquant : [] en cas d'échec.

import { z } from "zod";
import { judgeModel } from "./foundry";
import { runAgent } from "./structured";

const BriefAuditSchema = z.object({
  warnings: z
    .array(z.string())
    .describe(
      "Éléments PRÉSENTS dans le brief mais absents de l'extraction automatique. Messages courts, en anglais. [] si rien ne manque."
    ),
});

export interface BriefAuditExtracted {
  languages?: string[];
  blocks?: string[];
  markets?: string[];
  salesforceCampaignName?: string | null;
}

export async function auditBriefCompleteness(
  rawText: string,
  extracted: BriefAuditExtracted
): Promise<string[]> {
  try {
    const res = await runAgent({
      model: judgeModel(),
      system:
        "Tu audites la complétude du parsing automatique d'un brief email Kering. " +
        "On te donne le brief BRUT (texte extrait du fichier, tout format) et ce que le " +
        "parseur a capté automatiquement. Liste ce qui est PRÉSENT dans le brief mais NON " +
        "capté : bloc de contenu, marché de lien (WW/CN/JP/US…), langue, mention légale, " +
        "note importante. Messages courts et actionnables, rédigés en ANGLAIS professionnel. " +
        "Si rien ne manque, warnings=[]. N'invente rien : uniquement ce qui figure dans le brief.",
      user:
        // 50k : même borne que le digest du scout — un classeur pathologique ne
        // doit pas exploser le contexte (troncature déclarée au modèle).
        `## Brief brut\n\n${rawText.length > 50_000 ? `${rawText.slice(0, 50_000)}\n…[brief tronqué à 50k caractères]` : rawText}\n\n` +
        `## Capté automatiquement\n\n` +
        `- Langues : ${extracted.languages?.length ? extracted.languages.join(", ") : "(aucune)"}\n` +
        `- Blocs : ${extracted.blocks?.length ? extracted.blocks.join(", ") : "(aucun)"}\n` +
        `- Marchés : ${extracted.markets?.length ? extracted.markets.join(", ") : "(aucun)"}\n` +
        `- Nom de campagne Salesforce : ${extracted.salesforceCampaignName ?? "(aucun)"}`,
      schema: BriefAuditSchema,
      toolName: "emit_audit",
      toolDescription:
        "Rends la liste des éléments du brief non captés par le parsing automatique.",
      maxTokens: 800,
    });
    return res.ok ? res.data.warnings : [];
  } catch {
    return [];
  }
}
