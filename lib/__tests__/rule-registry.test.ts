// Garde-fous du catalogue ÉLARGI (règles code + règles IA + réglages
// périphériques), et de la configuration des deux nouveaux types de paramètre.
//
// Ce que ces tests protègent, dans l'ordre d'importance :
//  1. aucune config = comportement d'origine, à l'octet près ;
//  2. un identifiant est un contrat : jamais dupliqué, jamais réutilisé ;
//  3. une règle affichée en lecture seule ne peut pas être modifiée par un
//     appel API direct — le contrôle de la page n'est pas une sécurité ;
//  4. une règle IA annoncée éditable est réellement injectée dans un prompt.

import { describe, it, expect } from "vitest";
import { RULE_CATALOG, RETIRED_IDS } from "../rule-catalog";
import { LLM_RULE_CATALOG } from "../llm-rule-catalog";
import { PERIPHERAL_RULE_CATALOG } from "../peripheral-rule-catalog";
import { ALL_CATALOG, ALL_RULE_BY_ID, llmRulesForAgent } from "../rule-registry";
import {
  DEFAULT_RULE_CONFIG,
  resolveRuleConfig,
  validateAgainstCatalog,
  type RuleConfig,
  type RuleOverride,
} from "../rule-config";
import { linkOptionsFromConfig } from "../check-links";

/** Miroir exact de l'appel de la route (`app/api/rules/route.ts`, PUT) : elle
 *  n'injecte AUCUNE liste, elle laisse le défaut de validateAgainstCatalog —
 *  AGENT_KEYS, lu du même lib/agent-catalog.ts que la liste servie à la page.
 *  Un test qui injecterait la sienne resterait vert si ce défaut désignait
 *  autre chose : c'est justement le seul endroit où le référentiel n'est plus
 *  visible dans l'appel. Que le paramètre soit honoré quand on l'injecte est
 *  mesuré dans agent-catalog.test.ts, pas ici. */
const validate = (body: Parameters<typeof validateAgainstCatalog>[0]): string[] => validateAgainstCatalog(body);

function cfgWith(overrides: Record<string, RuleOverride>): RuleConfig {
  return {
    id: "default",
    overrides,
    customRules: [],
    customCategories: [],
    version: 1,
    updatedAt: new Date(0).toISOString(),
    history: [],
  };
}

// --- (a) intégrité du catalogue -------------------------------------------

describe("intégrité du catalogue complet", () => {
  it("réunit les trois catalogues sans en perdre", () => {
    expect(ALL_CATALOG.length).toBe(
      RULE_CATALOG.length + LLM_RULE_CATALOG.length + PERIPHERAL_RULE_CATALOG.length
    );
  });

  it("n'a aucun identifiant en double", () => {
    // Un doublon ferait qu'un interrupteur en éteint une autre : le module
    // lève au chargement, ce test le constate plutôt que d'attendre la prod.
    const ids = ALL_CATALOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ne réutilise aucun identifiant retiré", () => {
    for (const id of RETIRED_IDS) expect(ALL_RULE_BY_ID[id]).toBeUndefined();
  });

  it("cite la source de chaque règle IA et périphérique", () => {
    // Sans source, on ne peut plus vérifier qu'une règle décrit un contrôle qui
    // existe vraiment — et une règle inventée est pire qu'une règle absente.
    for (const r of [...LLM_RULE_CATALOG, ...PERIPHERAL_RULE_CATALOG]) {
      expect(r.source, r.id).toBeTruthy();
    }
  });

  it("rattache chaque règle IA à un agent connu", () => {
    const AGENTS = new Set([
      "assets",
      "liens",
      "tracking",
      "brief",
      "guidelines",
      "anomalies",
      "vision",
    ]);
    for (const r of LLM_RULE_CATALOG) expect(AGENTS.has(r.agent ?? ""), r.id).toBe(true);
  });

  it("explique le verrou de chaque règle en lecture seule", () => {
    // Une règle verrouillée SANS raison affichée ressemble à un oubli : la
    // personne qui la lit doit savoir pourquoi elle ne peut pas y toucher.
    for (const r of ALL_CATALOG.filter((x) => x.readOnly)) {
      expect(r.lockedReason, r.id).toBeTruthy();
      expect(r.lockedValue, r.id).toBeTruthy();
    }
  });

  it("donne un défaut à chaque paramètre, dans ses propres bornes", () => {
    for (const r of ALL_CATALOG) {
      for (const p of r.params ?? []) {
        if (p.kind === "int") {
          expect(p.default, `${r.id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
          expect(p.default, `${r.id}.${p.key}`).toBeLessThanOrEqual(p.max);
        } else if (p.kind === "int-list") {
          expect(p.default.length, `${r.id}.${p.key}`).toBeLessThanOrEqual(p.maxItems);
          for (const n of p.default) {
            expect(n, `${r.id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
            expect(n, `${r.id}.${p.key}`).toBeLessThanOrEqual(p.max);
          }
        }
      }
    }
  });
});

// --- (b) aucune config = comportement d'origine ----------------------------

describe("sans configuration, rien ne bouge", () => {
  it("garde les options de vérification des liens telles qu'elles sont dans le code", () => {
    // Le vrai risque de tout ce chantier : qu'ouvrir un réglage change
    // silencieusement sa valeur par défaut. Les nombres ci-dessous sont ceux
    // de check-links.ts, écrits à la main exprès — les relire depuis le
    // catalogue ne prouverait rien.
    const o = linkOptionsFromConfig(DEFAULT_RULE_CONFIG);
    expect(o.timeoutMs).toBe(15_000);
    expect(o.concurrency).toBe(6);
    expect(o.maxRedirects).toBe(5);
    expect(o.blockedStatuses).toEqual([400, 403, 405, 429]);
    expect(o.brokenStatuses).toEqual([404, 410]);
  });

  it("laisse toutes les règles IA actives", () => {
    for (const r of LLM_RULE_CATALOG) {
      expect(DEFAULT_RULE_CONFIG.enabled(r.id), r.id).toBe(true);
    }
  });

  it("laisse le seuil de rattachement automatique à 60%", () => {
    expect(DEFAULT_RULE_CONFIG.int("matching-auto-threshold", "autoThresholdPercent", 60)).toBe(60);
  });
});

// --- (c) les nouveaux types de paramètre ----------------------------------

describe("listes de nombres et interrupteurs", () => {
  it("applique une liste de codes modifiée", () => {
    const cfg = resolveRuleConfig(
      cfgWith({ "links-status-classification": { params: { brokenStatuses: [404, 410, 451] } } })
    );
    expect(linkOptionsFromConfig(cfg).brokenStatuses).toEqual([404, 410, 451]);
  });

  it("revient au défaut si la liste a été vidée", () => {
    // Une liste vide voudrait dire "plus aucun code n'est un lien mort" : le
    // contrôle disparaîtrait sans que personne ne l'ait demandé.
    const cfg = resolveRuleConfig(
      cfgWith({ "links-status-classification": { params: { brokenStatuses: [] } } })
    );
    expect(linkOptionsFromConfig(cfg).brokenStatuses).toEqual([404, 410]);
  });

  it("refuse un code hors de la plage HTTP", () => {
    const errors = validate({
      overrides: { "links-status-classification": { params: { brokenStatuses: [404, 9999] } } },
      customRules: [],
      customCategories: [],
      version: 1,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("refuse une liste de nombres là où des mots sont attendus", () => {
    const errors = validate({
      overrides: { "links-status-classification": { params: { brokenStatuses: ["404"] } } },
      customRules: [],
      customCategories: [],
      version: 1,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// --- (d) le verrou des règles en lecture seule ----------------------------

describe("une règle verrouillée l'est côté serveur", () => {
  const READ_ONLY = "links-unsubscribe-excluded";

  it("rejette tout écart enregistré sur elle", () => {
    // La page ne propose pas de contrôle, mais un appel direct à l'API le
    // pourrait : c'est le serveur qui doit refuser, pas l'écran.
    const errors = validate({
      overrides: { [READ_ONLY]: { enabled: false } },
      customRules: [],
      customCategories: [],
      version: 1,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("la garde active même si un écart traînait déjà en base", () => {
    const cfg = resolveRuleConfig(cfgWith({ [READ_ONLY]: { enabled: false } }));
    expect(cfg.enabled(READ_ONLY)).toBe(true);
  });

  it("ignore une sévérité forcée sur elle", () => {
    const cfg = resolveRuleConfig(cfgWith({ [READ_ONLY]: { severity: "MINEUR" } }));
    expect(cfg.severity(READ_ONLY, "MAJEUR")).toBe("MAJEUR");
  });

  it('reste allumée malgré un "Delete" enregistré sur elle', () => {
    // "Delete" éteint la règle en la masquant : sur une entrée verrouillée,
    // c'est la désactivation refusée plus haut, avec un autre bouton.
    const cfg = resolveRuleConfig(cfgWith({ [READ_ONLY]: { removed: true } }));
    expect(cfg.enabled(READ_ONLY)).toBe(true);
  });

  it('rejette l\'écriture d\'un "Delete" sur elle', () => {
    const errors = validate({
      overrides: { [READ_ONLY]: { removed: true } },
      customRules: [],
      customCategories: [],
      version: 1,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// --- (e) ce qui est éteint disparaît vraiment du prompt --------------------

describe("éteindre une règle IA la retire du prompt de son agent", () => {
  it("ne liste plus la règle désactivée", () => {
    const target = LLM_RULE_CATALOG.find((r) => r.agent === "anomalies" && !r.protected)!;
    const cfg = resolveRuleConfig(cfgWith({ [target.id]: { enabled: false } }));
    const listed = llmRulesForAgent("anomalies", (id) => cfg.enabled(id)).map((r) => r.id);
    expect(listed).not.toContain(target.id);
    expect(listed.length).toBeGreaterThan(0);
  });

  it("garde une règle protégée quoi qu'on enregistre", () => {
    const cfg = resolveRuleConfig(cfgWith({ "llm-guidelines-rule-hijack": { enabled: false } }));
    const listed = llmRulesForAgent("guidelines", (id) => cfg.enabled(id)).map((r) => r.id);
    expect(listed).toContain("llm-guidelines-rule-hijack");
  });
});

// --- (f) le plafond de sévérité de la vision ------------------------------

describe("les règles vision ne montent jamais en CRITIQUE", () => {
  it("n'en propose que MAJEUR et MINEUR", () => {
    // Le moteur rabat déjà (render-vision.ts) ; proposer CRITIQUE afficherait
    // durablement un réglage que l'analyse n'applique pas.
    for (const r of LLM_RULE_CATALOG.filter((x) => x.agent === "vision")) {
      expect(r.severityOptions, r.id).toEqual(["MAJEUR", "MINEUR"]);
    }
  });

  it("refuse une sévérité CRITIQUE enregistrée sur elles", () => {
    const errors = validate({
      overrides: { "llm-vision-broken-image": { severity: "CRITIQUE" } },
      customRules: [],
      customCategories: [],
      version: 1,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepte MINEUR", () => {
    const errors = validate({
      overrides: { "llm-vision-broken-image": { severity: "MINEUR" } },
      customRules: [],
      customCategories: [],
      version: 1,
    });
    expect(errors).toEqual([]);
  });
});
