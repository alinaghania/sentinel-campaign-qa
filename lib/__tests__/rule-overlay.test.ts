// Règles par marque : la config d'une marque se pose sur la globale.
// Contrats protégés : (1) la marque l'emporte champ par champ, (2) ses règles
// custom s'ajoutent, (3) merge → diff est un aller-retour exact (c'est ce que
// la page enregistre), (4) la config de marque change l'empreinte de cache.
import { describe, expect, it } from "vitest";
import { emptyRuleConfig, resolveRuleConfig, type CustomRule, type RuleConfig } from "../rule-config";
import { diffOverrides, mergeOverrides, mergeRuleConfigs } from "../rule-overlay";
import { RULE_CATALOG } from "../rule-catalog";

const adjustable = RULE_CATALOG.find((r) => r.severityAdjustable && !r.protected && !r.readOnly)!;
const withParams = RULE_CATALOG.find((r) => r.params?.length && !r.readOnly && !r.protected);

const rule = (id: string): CustomRule => ({
  id,
  title: `Rule ${id}`,
  instruction: "Never say hello",
  category: "brand",
  examples: [],
  severity: "major" as CustomRule["severity"],
  enabled: true,
});

const cfg = (patch: Partial<RuleConfig>): RuleConfig => ({ ...emptyRuleConfig(), ...patch });

describe("mergeRuleConfigs", () => {
  it("sans config de marque, rend la globale telle quelle", () => {
    const g = cfg({ version: 3 });
    expect(mergeRuleConfigs(g, null)).toBe(g);
    expect(mergeRuleConfigs(null, null)).toBeNull();
  });

  it("l'écart de marque l'emporte sur le global, champ par champ", () => {
    const g = cfg({ overrides: { [adjustable.id]: { enabled: false, severity: "minor" as never } } });
    const b = cfg({ overrides: { [adjustable.id]: { enabled: true } } });
    const merged = mergeRuleConfigs(g, b)!;
    expect(merged.overrides[adjustable.id].enabled).toBe(true);
    expect(merged.overrides[adjustable.id].severity).toBe("minor");
    expect(resolveRuleConfig(merged).enabled(adjustable.id)).toBe(true);
    expect(resolveRuleConfig(g).enabled(adjustable.id)).toBe(false);
  });

  it("les règles custom de la marque s'ajoutent aux globales", () => {
    const merged = mergeRuleConfigs(cfg({ customRules: [rule("g1")] }), cfg({ customRules: [rule("b1")] }))!;
    expect(resolveRuleConfig(merged).customRules.map((r) => r.id)).toEqual(["g1", "b1"]);
  });

  it("une marque seule, sans config globale, fonctionne", () => {
    const merged = mergeRuleConfigs(null, cfg({ customRules: [rule("b1")] }))!;
    expect(resolveRuleConfig(merged).customRules).toHaveLength(1);
  });

  it("la config de marque change l'empreinte de cache", () => {
    const g = cfg({});
    const a = resolveRuleConfig(mergeRuleConfigs(g, cfg({ customRules: [rule("b1")] })));
    expect(a.hash).not.toBe(resolveRuleConfig(g).hash);
  });

  it("deux marques n'ont pas la même empreinte", () => {
    const g = cfg({});
    const a = resolveRuleConfig(mergeRuleConfigs(g, cfg({ overrides: { [adjustable.id]: { enabled: false } } })));
    const b = resolveRuleConfig(mergeRuleConfigs(g, cfg({ overrides: { [adjustable.id]: { enabled: true } } })));
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("diffOverrides", () => {
  it("merge puis diff rend exactement les écarts de la marque", () => {
    const base = { [adjustable.id]: { enabled: false, severity: "minor" as never } };
    const brand = { [adjustable.id]: { enabled: true } };
    expect(diffOverrides(base, mergeOverrides(base, brand))).toEqual(brand);
  });

  it("ne garde rien quand la vue marque n'a pas bougé", () => {
    const base = { [adjustable.id]: { enabled: false } };
    expect(diffOverrides(base, mergeOverrides(base, {}))).toEqual({});
  });

  it.skipIf(!withParams)("ne diffe que les paramètres modifiés", () => {
    const p = withParams!.params![0];
    const base = { [withParams!.id]: { params: { [p.key]: p.default as never } } };
    const merged = { [withParams!.id]: { params: { [p.key]: p.default as never } } };
    expect(diffOverrides(base, merged)).toEqual({});
  });
});
