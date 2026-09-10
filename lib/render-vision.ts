// Juge VISION du rendu réel : compare le screenshot Gmail/Outlook Web au
// mockup du brief (si présent) et signale les problèmes de rendu visibles.
//
// Règle de sévérité (héritée de l'audit MVP) : la vision est une heuristique →
// JAMAIS de CRITIQUE ici. MAJEUR max, rétrogradé côté verdict humain si besoin.
// Pas de diff pixel : on demande des différences STRUCTURELLES (blocs absents,
// images cassées, layout éclaté, texte coupé/clippé), pas des nuances de rendu.

import { promises as fs } from "fs";
import { z } from "zod";
import { runAgent } from "./structured";
import { workerModel } from "./foundry";
import type { ContentBlock } from "./foundry";
import { uid } from "./store";
import type { BriefMockup, Finding } from "./types";
import type { RealRender } from "./render-real";
import type { ResolvedRuleConfig } from "./rule-config";
import { LLM_RULE_BY_ID } from "./llm-rule-catalog";
import { activeRulesBlock } from "./agents";

const VisionReportSchema = z.object({
  findings: z.array(
    z.object({
      severite: z.enum(["MAJEUR", "MINEUR"]),
      message: z.string().min(10).max(300),
      evidence: z.string().max(300),
      suggestion: z.string().max(300).optional(),
      /** Même contrat que AgentFindingSchema.rule_id : optionnel, `string`
       *  libre, et un id non reconnu n'est JAMAIS filtré. Un modèle qui oublie
       *  d'étiqueter ne doit pas faire disparaître un vrai défaut de rendu. */
      rule_id: z
        .string()
        .max(60)
        .optional()
        .describe(
          "Identifiant de la règle vérifiée, copié EXACTEMENT depuis la liste RÈGLES À VÉRIFIER. Omets-le si le constat ne correspond à aucune règle de la liste."
        ),
    })
  ),
  checks_passed: z.array(z.object({ label: z.string().max(120) })),
});

const SYSTEM = `Tu es un expert QA email. Tu reçois le rendu RÉEL d'un email marketing dans un client mail web (Gmail ou Outlook) en DESKTOP et en MOBILE (largeur téléphone — les media queries responsive du mail sont actives), et éventuellement le mockup de référence du brief.

Signale UNIQUEMENT les problèmes de rendu STRUCTURELS et VISIBLES :
- bloc/section du mockup absent du rendu réel
- image cassée ou non chargée (icône d'image manquante, alt text affiché)
- layout éclaté : colonnes empilées à tort, débordement horizontal, chevauchement
- RESPONSIVE (screenshot mobile) : contenu coupé horizontalement, colonnes restées côte à côte au lieu de s'empiler, texte trop petit pour être lu sur téléphone, CTA tronqué ou hors écran
- texte coupé, clippé ou illisible (contraste, taille)
- CTA/bouton déformé ou absent
- footer/mentions légales absents à l'écran

NE SIGNALE PAS : différences de police de quelques pixels, nuances de couleur, espacements légèrement différents, contenu marketing (déjà audité par d'autres agents), la langue du contenu, le chrome du client mail (barre Gmail) visible en bord de capture.

Sévérité : MAJEUR = un destinataire verrait immédiatement que le mail est cassé ; MINEUR = imperfection visible mais mail exploitable. evidence = description factuelle de ce qui est visible sur le screenshot.

LANGUE DE SORTIE : tous les textes destinés à l'utilisateur (message, evidence, suggestion, labels de checks_passed) doivent être rédigés en ANGLAIS professionnel.

IMPORTANT : écris l'anglais directement en UTF-8 normal. N'utilise JAMAIS de séquences d'échappement unicode (\\uXXXX, \\f…) dans tes textes — elles corrompent l'affichage.`;

/** Plafonne la vision à MAJEUR (cf. invariant en tête de fichier). */
function clampVision(s: Finding["severite"]): "MAJEUR" | "MINEUR" {
  return s === "MINEUR" ? "MINEUR" : "MAJEUR";
}

/** Analyse vision de rendus réels (desktop + mobile). Findings categorie "rendu". */
export async function runRenderVision(opts: {
  renders: RealRender[];
  mockup?: BriefMockup | null;
  campaignName: string;
  /** Config des règles. Absente = comportement d'origine, à l'octet près. */
  cfg?: ResolvedRuleConfig | null;
  /** Bloc GLOSSAIRE déjà construit et désarmé par lib/glossary.ts, transmis par
   *  l'orchestrateur. Reçu tout fait plutôt que reconstruit ici : c'est la
   *  leçon de `rulesBlock` juste en dessous — une seconde construction locale
   *  diverge un jour, et l'écart ne se voit que dans un prompt que personne ne
   *  relit. */
  glossaryBlock?: string;
}): Promise<{
  findings: Finding[];
  passed: Array<{ categorie: string; label: string }>;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number };
}> {
  const provider = opts.renders[0]?.provider ?? "gmail";
  const clientLabel = provider === "gmail" ? "Gmail Web" : "Outlook Web";
  const imageLabels = opts.renders.map(
    (r, i) =>
      `image ${i + 1} = ${
        r.device === "desktop"
          ? `rendu RÉEL ${clientLabel} DESKTOP (capture du vrai client mail)`
          : `aperçu RESPONSIVE largeur ${r.device.replace("mobile-", "")}px${r.device === "mobile-320" ? " (petit écran — worst case)" : ""} (HTML du mail rendu en Chromium, PAS le client mail — juge uniquement le layout)`
      }`
  );
  if (opts.mockup) imageLabels.push(`image ${opts.renders.length + 1} = mockup de référence du brief`);
  // La liste des règles actives va dans le message UTILISATEUR (jamais le
  // système) : c'est une donnée de configuration, pas une consigne de rôle.
  // Construite par activeRulesBlock (lib/agents.ts) et NON à la main : ce bloc
  // porte aussi les EXEMPLES saisis dans /rules, et une copie locale les aurait
  // silencieusement laissés de côté — un exemple enregistré, affiché à l'écran,
  // qui n'atteint jamais le modèle est un réglage muet.
  const rulesBlock = activeRulesBlock("vision", opts.cfg);
  const content: ContentBlock[] = [
    {
      type: "text",
      text: `${opts.glossaryBlock ?? ""}${rulesBlock}Campagne "${opts.campaignName}" — ${imageLabels.join(" ; ")}${opts.mockup ? "" : " ; pas de mockup fourni, audite les rendus seuls"}.`,
    },
  ];
  for (const r of opts.renders) {
    const png = await fs.readFile(r.file);
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
    });
  }
  if (opts.mockup) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(opts.mockup.dataUrl);
    if (m) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: m[1], data: m[2] },
      });
    }
  }

  const res = await runAgent({
    model: workerModel(),
    system: SYSTEM,
    user: content,
    schema: VisionReportSchema,
    toolName: "emit_render_report",
    toolDescription: "Rends ton audit visuel structuré du rendu réel.",
    maxTokens: 2000,
  });
  if (!res.ok) return { findings: [], passed: [], error: res.error };

  const agentLabel = `Rendu réel (${provider === "gmail" ? "Gmail" : "Outlook"})`;
  const cfg = opts.cfg;
  const findings: Finding[] = res.data.findings
    .map((f) => {
      // Un id que le catalogue ne connaît pas est ignoré, jamais utilisé pour
      // filtrer : sinon un modèle qui invente un id ferait disparaître un défaut.
      const ruleId = f.rule_id && LLM_RULE_BY_ID[f.rule_id] ? f.rule_id : undefined;
      return {
        id: uid(),
        agent: agentLabel,
        categorie: "rendu" as const,
        // La vision reste une heuristique : MAJEUR maximum, invariant en tête
        // de fichier. Une sévérité configurée à CRITIQUE est donc rabattue —
        // aucun réglage de page ne doit pouvoir bloquer un envoi sur une
        // interprétation de capture d'écran.
        severite: clampVision(cfg && ruleId ? cfg.severity(ruleId, f.severite) : f.severite),
        title: "Problem in the rendering",
        message: f.message,
        evidence: f.evidence,
        locator: `screenshot:${provider}`,
        suggestion: f.suggestion,
        source: "agent" as const,
        ruleId,
        // La citation est une description d'image : non vérifiable par substring.
        quoteVerified: undefined,
      };
    })
    .filter((f) => !f.ruleId || !cfg || cfg.enabled(f.ruleId));
  const passed = res.data.checks_passed.map((c) => ({
    categorie: "rendu",
    label: `${agentLabel} — ${c.label}`,
  }));
  return { findings, passed, usage: res.usage };
}
