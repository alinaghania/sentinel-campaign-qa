// Registre unifié des règles pilotables depuis /rules.
//
// Trois catalogues, un seul point d'entrée :
//   - RULE_CATALOG            (rule-catalog.ts)       règles déterministes de checks-code.ts
//   - LLM_RULE_CATALOG        (llm-rule-catalog.ts)   ce que les agents IA vérifient
//   - PERIPHERAL_RULE_CATALOG (peripheral-rule-catalog.ts) réglages hors checks-code
//
// Ce module est le SEUL endroit qui les assemble. rule-catalog.ts reste une
// feuille (types + 30 règles) pour qu'aucun cycle d'import n'apparaisse : les
// deux autres catalogues importent ses types, jamais l'inverse.
//
// Ce module ne dépend d'AUCUNE API Node : il est importé par la page client.

import { RULE_CATALOG, RETIRED_IDS } from "./rule-catalog";
import type { RuleCatalogEntry } from "./rule-catalog";
import { LLM_RULE_CATALOG } from "./llm-rule-catalog";
import { PERIPHERAL_RULE_CATALOG } from "./peripheral-rule-catalog";

export const ALL_CATALOG: RuleCatalogEntry[] = [
  ...RULE_CATALOG,
  ...LLM_RULE_CATALOG,
  ...PERIPHERAL_RULE_CATALOG,
];

// Un id dupliqué entre deux catalogues ferait silencieusement piloter la
// mauvaise règle (le second écrase le premier dans la table). On échoue au
// CHARGEMENT du module — donc au build et au démarrage, jamais en production
// au milieu d'une analyse.
{
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const r of ALL_CATALOG) {
    if (seen.has(r.id)) dupes.push(r.id);
    seen.add(r.id);
  }
  for (const id of RETIRED_IDS) {
    if (seen.has(id)) dupes.push(`${id} (retired id reused)`);
  }
  if (dupes.length > 0) {
    throw new Error(`Duplicate rule id(s) in the catalogue: ${dupes.join(", ")}`);
  }
}

export const ALL_RULE_BY_ID: Record<string, RuleCatalogEntry> = Object.fromEntries(
  ALL_CATALOG.map((r) => [r.id, r])
);

/** Ids des règles vérifiées par les agents LLM — utilisé pour n'injecter que
 *  celles-là dans les prompts, et pour ne filtrer un finding d'agent que si son
 *  ruleId est bien une règle LLM connue. */
export const LLM_RULE_IDS: string[] = LLM_RULE_CATALOG.map((r) => r.id);

/** Règles LLM d'un agent donné (`key` du worker), actives uniquement. */
export function llmRulesForAgent(
  agentKey: string,
  isEnabled: (ruleId: string) => boolean
): RuleCatalogEntry[] {
  return LLM_RULE_CATALOG.filter((r) => r.agent === agentKey && isEnabled(r.id));
}
