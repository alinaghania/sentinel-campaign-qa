// Règles PAR MARQUE : une couche posée au-dessus de la config globale.
//
// Même modèle "overlay" que la config globale, un cran plus haut : la config
// d'une marque ne stocke que ses ÉCARTS par rapport à la config globale (qui
// elle-même ne stocke que ses écarts par rapport au code). Résolution, du plus
// faible au plus fort : code → global → marque.
//   - "override" : un écart de marque l'emporte sur l'écart global, champ par
//     champ (une marque peut ne changer que la sévérité et garder les
//     paramètres globaux) ;
//   - "par-dessus" : les règles custom de la marque s'AJOUTENT aux globales.
//
// Module sans dépendance serveur (types seuls) : la page /rules l'importe pour
// calculer ce qu'elle envoie, le serveur pour ce qu'il applique — les deux
// lisent la même fonction, donc le même résultat.

import type {
  CustomCategory,
  CustomRule,
  RuleConfig,
  RuleOverride,
} from "./rule-config";

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Écart de marque posé sur un écart global : champ par champ, `params` clé par
 *  clé. Les exemples REMPLACENT (pas de concaténation) : la vue d'édition d'une
 *  marque part des exemples globaux, un aller-retour merge → diff doit rendre
 *  exactement ce qui a été saisi. */
function mergeOverride(base: RuleOverride | undefined, brand: RuleOverride): RuleOverride {
  const merged: RuleOverride = { ...base, ...brand };
  if (base?.params || brand.params) merged.params = { ...base?.params, ...brand.params };
  return merged;
}

export function mergeOverrides(
  base: Record<string, RuleOverride>,
  brand: Record<string, RuleOverride>
): Record<string, RuleOverride> {
  const out: Record<string, RuleOverride> = { ...base };
  for (const [id, o] of Object.entries(brand)) out[id] = mergeOverride(base[id], o);
  return out;
}

/** Inverse de mergeOverrides : ce que `merged` change par rapport à `base`.
 *  Sert à la page pour n'enregistrer, côté marque, que de vrais écarts. */
export function diffOverrides(
  base: Record<string, RuleOverride>,
  merged: Record<string, RuleOverride>
): Record<string, RuleOverride> {
  const out: Record<string, RuleOverride> = {};
  for (const [id, m] of Object.entries(merged)) {
    const b = base[id] as Record<string, unknown> | undefined;
    const d: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(m)) {
      if (value === undefined) continue;
      if (key === "params") {
        const params: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!same((b?.params as Record<string, unknown> | undefined)?.[k], v)) params[k] = v;
        }
        if (Object.keys(params).length > 0) d.params = params;
      } else if (!same(b?.[key], value)) {
        d[key] = value;
      }
    }
    // `summary`/`by` ne sont pas des écarts de comportement : un override réduit
    // à ces seuls champs n'est pas un écart.
    if (Object.keys(d).length > 0) out[id] = d as RuleOverride;
  }
  return out;
}

export function mergeCategories(
  base: CustomCategory[],
  brand: CustomCategory[]
): CustomCategory[] {
  const byId = new Map(base.map((c) => [c.id, c]));
  for (const c of brand) byId.set(c.id, c);
  return [...byId.values()];
}

/** Config EFFECTIVE d'une marque. `null` seulement si ni l'une ni l'autre
 *  n'existe (= tous les défauts du code, comportement historique à l'octet). */
export function mergeRuleConfigs(
  global: RuleConfig | null,
  brand: RuleConfig | null
): RuleConfig | null {
  if (!brand) return global;
  const g = global;
  const globalRuleIds = new Set((g?.customRules ?? []).map((r) => r.id));
  const customRules: CustomRule[] = [
    ...(g?.customRules ?? []),
    // Un id déjà pris par une règle globale est ignoré : il écraserait ou
    // doublerait une règle qu'on ne voit pas depuis l'écran de la marque.
    ...brand.customRules.filter((r) => !globalRuleIds.has(r.id)),
  ];
  return {
    id: g?.id ?? "default",
    overrides: mergeOverrides(g?.overrides ?? {}, brand.overrides),
    customRules,
    customCategories: mergeCategories(g?.customCategories ?? [], brand.customCategories ?? []),
    // Somme : monotone, change dès que l'une OU l'autre config est sauvegardée.
    version: (g?.version ?? 0) + brand.version,
    updatedAt: brand.updatedAt,
    updatedBy: brand.updatedBy,
    history: [],
  };
}
