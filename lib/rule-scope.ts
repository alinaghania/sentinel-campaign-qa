// Quelle configuration de règles s'applique à QUELLE campagne.
//
// Point d'entrée unique des appelants serveur (analyse, lot) : ils passent la
// marque de la campagne, et reçoivent la config globale surchargée par la marque
// — ou la globale seule quand la marque n'a rien configuré.

import { resolveRuleConfig, type ResolvedRuleConfig } from "./rule-config";
import { mergeRuleConfigs } from "./rule-overlay";
import { Settings } from "./store";

export async function loadRuleConfig(brandId?: string | null): Promise<ResolvedRuleConfig> {
  const [global, brand] = await Promise.all([
    Settings.get(),
    brandId ? Settings.get(brandId) : Promise.resolve(null),
  ]);
  return resolveRuleConfig(mergeRuleConfigs(global, brand));
}
