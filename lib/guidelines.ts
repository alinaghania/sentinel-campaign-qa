// Compilateur de guidelines : texte libre ("Pas de tutoiement. Prix 99 €...")
// → règles typées code/llm/hybride, revues par l'humain, versionnées par marque.

import { judgeModel } from "./foundry";
import { GuidelinesCompilationSchema, type GuidelinesCompilationOut } from "./schemas";
import { runAgent } from "./structured";
import type { BrandRule } from "./types";

export async function compileGuidelines(
  sourceText: string,
  brandName: string
): Promise<{ ok: true; rules: BrandRule[]; contradictions: string[] } | { ok: false; error: string }> {
  const res = await runAgent({
    model: judgeModel(),
    toolName: "emit_rules",
    toolDescription: "Rends les règles compilées depuis les guidelines de la marque.",
    system: `Tu es un compilateur de chartes éditoriales pour la QA d'emails marketing. Tu transformes des guidelines en texte libre en règles ATOMIQUES et EXÉCUTABLES.

Pour chaque règle, choisis le bon moteur :
- "code" : vérifiable mécaniquement → renseigne params.check :
  · forbidden_terms + params.tokens (mots/expressions interdits, sans regex complexe)
  · required_text + params.exactText (mention obligatoire mot pour mot)
  · max_length + params.max (longueur de l'objet)
- "llm" : jugement linguistique pur (ton, style, formulations floues)
- "hybrid" : détectable par mots-clés mais avec exceptions contextuelles (ex. tutoiement : pronoms détectables, mais citations client à exclure) → params.tokens pour le pré-filtre + description précise pour le LLM.

Règles impératives :
- Une guideline = une ou plusieurs règles atomiques. id en kebab-case.
- severity : error = bloquant (légal, interdits stricts), warning = à corriger, suggestion = style.
- examples.good / examples.bad : 1-2 exemples courts chacun quand utile (few-shot).
- exceptions : cas où la règle ne s'applique pas, si mentionnés ou évidents.
- Détecte les contradictions entre guidelines et liste-les dans "contradictions" (ne tranche pas toi-même).
- N'invente pas de règles non demandées. Réponds en français.`,
    user: `Marque : ${brandName}\n\nGUIDELINES (texte libre collé par l'utilisateur) :\n\n${sourceText.slice(0, 20_000)}\n\nCompile en règles via emit_rules.`,
    schema: GuidelinesCompilationSchema,
    maxTokens: 4000,
  });
  if (!res.ok) return res;
  const data = res.data as GuidelinesCompilationOut;
  const rules: BrandRule[] = data.rules.map((r) => ({ ...r, enabled: true }));
  return { ok: true, rules, contradictions: data.contradictions };
}
