// Le référentiel des agents auxquels une règle écrite à la main peut être
// confiée depuis /rules.
//
// HISTOIRE DE CE FICHIER, à lire avant d'y toucher — le test de cohérence
// `WORKERS` ↔ liste proposée y a été retiré, remis, puis retiré à nouveau. Ce
// n'est pas de l'indécision : à chaque fois c'est la PRÉMISSE qui a changé, et
// le critère est resté le même — un test qui ne peut pas échouer ne dit rien,
// et un test qui recopie du code déjà exécuté ne dit rien non plus.
//
//  1. liste DÉRIVÉE de `WORKERS` dans lib/agents.ts → divergence
//     structurellement impossible → test retiré ;
//  2. lib/agent-catalog.ts créé avec une liste ÉCRITE À LA MAIN → deux
//     expressions indépendantes, divergence possible ET présente
//     (`translation` proposé d'un côté, refusé de l'autre) → test remis ;
//  3. lib/agents.ts a transformé sa dérivation en VÉRIFICATION au chargement
//     (lib/agents.ts:373-400) : les deux listes existent toujours, mais leur
//     désaccord est désormais détecté par le code de production lui-même, dans
//     les quatre sens qui cassent. Le réécrire ici ne testerait plus le
//     référentiel, seulement ma capacité à recopier cette boucle → retiré.
//
// Ce qu'il reste à tester est donc d'un cran en amont : **la garde jette-t-elle
// vraiment ?** Une garde muette et une garde satisfaite se ressemblent
// exactement — les deux laissent le build passer. D'où un contrôle positif par
// SENS (quatre), chacun sur son message exact, plus un contrôle négatif sur les
// modules réels.
//
// Puis, en aval, l'aiguillage d'une règle custom vers un agent, à l'écriture.

import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_CHOICES, AGENT_KEYS, GUIDELINES_AGENT_KEY } from "../agent-catalog";
import { WORKERS, activeRuleIdsForAgent } from "../agents";

import {
  RuleConfigWriteSchema,
  customRulesAsBrandRules,
  emptyRuleConfig,
  isGuidelinesRule,
  resolveRuleConfig,
  validateAgainstCatalog,
  type CustomRule,
  type ResolvedRuleConfig,
  type RuleConfig,
  type RuleConfigWrite,
} from "../rule-config";

// --- Outils ---------------------------------------------------------------

type WritableCustomRule = CustomRule & { severity: "MAJEUR" | "MINEUR" };

function custom(over: Partial<WritableCustomRule> = {}): WritableCustomRule {
  return {
    id: "r1",
    title: "No superlatives",
    instruction: "The copy must not use superlatives such as best or unbeatable.",
    category: "content",
    examples: [],
    severity: "MAJEUR",
    enabled: true,
    ...over,
  };
}

function write(over: Partial<RuleConfigWrite> = {}): RuleConfigWrite {
  return { overrides: {}, customRules: [], customCategories: [], version: 0, ...over };
}

const offeredKeys = (): string[] => AGENT_CHOICES.map((c) => c.key);
const workerKeys = (): string[] => WORKERS.map((w) => w.key);

/** Miroir exact de la route (`app/api/rules/route.ts:78`) : elle appelle SANS
 *  2ᵉ argument, donc contre le référentiel par défaut. Lui en passer un ici
 *  testerait un câblage qui n'est celui de personne — c'est justement la liste
 *  par défaut qu'on veut voir décider. Le paramètre a son propre test plus bas. */
const validate = (body: RuleConfigWrite): string[] => validateAgainstCatalog(body);

// --- La garde au CHARGEMENT de lib/agents.ts -----------------------------

/** L'agent fantôme des contrôles positifs. Choisi pour ne ressembler à rien :
 *  s'il se trouvait par accident dans WORKERS ou dans le catalogue, les tests
 *  passeraient à vide. */
const PHANTOM = "agent-fantome-de-test";

type Choice = { key: string; label: string };

/** Remplace lib/agent-catalog.ts par une liste fabriquée. Le module est pur (il
 *  n'importe rien, c'est sa raison d'être), donc le mocker ne casse aucun autre
 *  invariant : ce qui jette au chargement ne peut être QUE le désaccord voulu. */
function mockCatalog(choices: readonly Choice[]) {
  vi.doMock("../agent-catalog", () => ({
    AGENT_CHOICES: choices,
    AGENT_KEYS: choices.map((c) => c.key),
  }));
}

/** La liste réelle, à modifier localement dans chaque cas. */
const REAL: Choice[] = AGENT_CHOICES.map((c) => ({ key: c.key, label: c.label }));

afterEach(() => {
  vi.doUnmock("../llm-rule-catalog");
  vi.doUnmock("../agent-catalog");
  vi.resetModules();
});

describe("garde au chargement : le catalogue et WORKERS doivent s'accorder", () => {
  it("le fantôme des contrôles positifs n'existe pas pour de vrai", () => {
    // Garde-fou du garde-fou : si PHANTOM était par malheur un agent réel, les
    // tests suivants n'échoueraient pas — et leur succès signifierait le
    // contraire de ce qu'ils prétendent.
    expect(offeredKeys()).not.toContain(PHANTOM);
    expect(workerKeys()).not.toContain(PHANTOM);
  });

  // Les messages sont écrits EN DUR, un par sens. C'est ce que quelqu'un lira
  // dans un build cassé, et une assertion sur le seul préfixe du message
  // (« lib/agent-catalog.ts est en désaccord avec le reste du code ») passerait
  // aussi bien avec un message qui ne dit pas LEQUEL des quatre sens a cassé.
  //
  // L'assertion porte sur le REJET DE L'IMPORT : la garde s'exécute au
  // chargement du module, aucun expect(fn).toThrow() ne peut l'atteindre.

  it("CONTRÔLE POSITIF 1 — un worker générique absent du catalogue est invisible dans /rules", async () => {
    vi.resetModules();
    mockCatalog(REAL.filter((c) => c.key !== "assets"));
    await expect(import("../agents")).rejects.toThrow(
      'worker générique "assets" absent de agent-catalog.ts'
    );
  });

  it("CONTRÔLE POSITIF 2 — un worker à runner proposé serait jugé par personne", async () => {
    // LE sens qui a réellement cassé : `translation` a été proposé pendant
    // quelques heures. Une règle qu'on lui confie est enregistrée, affichée
    // « On », et lue par aucun prompt — son protocole est fixe.
    vi.resetModules();
    mockCatalog([...REAL, { key: "translation", label: "Translation" }]);
    await expect(import("../agents")).rejects.toThrow(
      'worker à runner "translation" proposé dans agent-catalog.ts — il ne lit aucune règle écrite à la main'
    );
  });

  it("CONTRÔLE POSITIF 3 — un agent proposé sans worker ni agent externe n'exécute rien", async () => {
    vi.resetModules();
    mockCatalog([...REAL, { key: PHANTOM, label: "Fantôme" }]);
    await expect(import("../agents")).rejects.toThrow(
      `agent proposé "${PHANTOM}" sans worker ni agent externe`
    );
  });

  it("CONTRÔLE POSITIF 4 — un agent nommé par le catalogue LLM doit être proposable", async () => {
    // Le catalogue est mocké en AJOUTANT une règle au catalogue RÉEL, pas en le
    // remplaçant par un faux : tous les autres invariants vérifiés au chargement
    // (unicité des identifiants, familles connues…) restent satisfaits. Sinon la
    // garde jetterait peut-être — mais pour une autre raison, et le test
    // passerait au vert en n'ayant rien montré.
    vi.resetModules();
    vi.doMock("../llm-rule-catalog", async () => {
      const real =
        await vi.importActual<typeof import("../llm-rule-catalog")>("../llm-rule-catalog");
      const catalog = [
        ...real.LLM_RULE_CATALOG,
        { ...real.LLM_RULE_CATALOG[0], id: "phantom-agent-rule", agent: PHANTOM },
      ];
      return {
        ...real,
        LLM_RULE_CATALOG: catalog,
        LLM_RULE_BY_ID: Object.fromEntries(catalog.map((r) => [r.id, r])),
      };
    });
    await expect(import("../agents")).rejects.toThrow(
      `agent "${PHANTOM}" du catalogue LLM non proposable`
    );
  });

  it("CONTRÔLE NÉGATIF — sur les modules réels, la garde laisse passer", async () => {
    // Sans lui, une garde qui jetterait TOUJOURS ferait passer les quatre tests
    // ci-dessus. Et le message doit rester attaché à sa cause : ce chargement-ci
    // ne doit produire aucune erreur.
    vi.resetModules();
    const mod = await import("../agents");
    expect(mod.WORKERS.length).toBeGreaterThan(0);
  });
});

// --- Ce qui est proposé doit être ACCEPTÉ ---------------------------------

describe("agent d'une règle custom", () => {
  it("chaque agent AFFICHÉ est accepté à l'écriture", () => {
    // Ce que la page met dans son <select> — elle importe lib/agent-catalog.ts
    // directement (app/rules/page.tsx:59), la route ne la lui sert plus — contre
    // ce que la route ACCEPTE ensuite au PUT. Les deux lisent le même module,
    // mais par deux chemins : un choix offert puis refusé en 400 est un mur que
    // la personne ne peut ni comprendre ni contourner.
    for (const agent of offeredKeys()) {
      expect(validate(write({ customRules: [custom({ agent })] })), agent).toEqual([]);
    }
  });

  it("un agent inconnu est refusé", () => {
    // Le contrôle vit dans validateAgainstCatalog, pas dans Zod : le schéma
    // accepte n'importe quelle chaîne, c'est le référentiel injecté qui tranche.
    expect(validate(write({ customRules: [custom({ agent: "does-not-exist" })] }))).toEqual([
      expect.stringContaining("does-not-exist"),
    ]);
  });

  it("un worker à runner est refusé à l'écriture", () => {
    // La liste déroulante ne le propose pas — mais le formulaire n'est pas le
    // seul chemin vers le PUT, et un contrôle qui ne vit que dans la page se
    // contourne par un appel direct. C'est le serveur qu'on mesure ici, pas
    // l'absence de l'option : les deux se ressemblent depuis la page.
    //
    // La prémisse d'abord : sans elle, ce test ne se distingue plus de « un
    // agent inconnu est refusé » juste au-dessus. Le jour où `translation` est
    // renommé, il resterait vert en mesurant une chaîne quelconque, et la seule
    // couverture du refus d'un worker SPÉCIALISÉ disparaîtrait sans bruit.
    expect(WORKERS.find((w) => w.key === "translation")?.runner).toBe("translation");

    expect(validate(write({ customRules: [custom({ agent: "translation" })] }))).toEqual([
      expect.stringContaining("translation"),
    ]);
  });

  it("agent absent = accepté (la règle revient à l'agent guidelines)", () => {
    // Contrôle positif du refus ci-dessus : un référentiel cassé qui refuserait
    // TOUT ferait passer le test précédent sans rien garantir.
    expect(RuleConfigWriteSchema.safeParse(write({ customRules: [custom()] })).success).toBe(true);
    expect(validate(write({ customRules: [custom()] }))).toEqual([]);
  });

  it("la liste injectée est bien celle qui décide", () => {
    // La liste est un PARAMÈTRE, et le test doit le montrer : s'il était ignoré
    // au profit d'une liste codée en dur dans la fonction, « agent inconnu
    // refusé » resterait vert et on ne le verrait nulle part.
    expect(
      validateAgainstCatalog(write({ customRules: [custom({ agent: "guidelines" })] }), ["assets"])
    ).toEqual([expect.stringContaining("guidelines")]);
    expect(
      validateAgainstCatalog(write({ customRules: [custom({ agent: "assets" })] }), ["assets"])
    ).toEqual([]);
  });
});

// --- Une règle DÉJÀ ENREGISTRÉE qui nomme un agent retiré du catalogue -----
//
// Le trou que les tests ci-dessus ne peuvent pas voir : ils partent tous de la
// liste COURANTE, donc d'un agent qui existe. Une règle enregistrée le jour où
// "translation" était encore proposable, elle, dort dans la config avec une clé
// que plus personne ne porte — et le repli habituel `agent ?? guidelines` ne la
// rattrape pas : il ne joue que sur un champ ABSENT, jamais sur un champ qui
// nomme un inconnu. Avant le ré-aiguillage de resolveRuleConfig, elle restait
// affichée « On » dans /rules et n'était lue par PERSONNE.
//
// Deux canaux mènent à un modèle, et il faut les mesurer TOUS LES DEUX dans le
// même cas : un test qui ne regarderait que <editorial_rules> passerait au vert
// si la règle partait dans un bloc d'agent, et réciproquement. D'où les deux
// témoins qui encadrent l'orpheline — un par canal.
describe("règle custom dont l'agent n'est plus au catalogue", () => {
  /** Une clé qui n'est ni proposable ni portée par un worker : c'est l'état
   *  d'une clé retirée du catalogue, sans avoir à en retirer une pour de vrai. */
  const ORPHAN_AGENT = "agent-retire-du-catalogue";

  const ids = { guidelines: "temoin-guidelines", assets: "temoin-assets", orphan: "orpheline" };

  const stored = (): RuleConfig => ({
    ...emptyRuleConfig(),
    customRules: [
      custom({ id: ids.guidelines, title: "Témoin guidelines" }),
      custom({ id: ids.assets, title: "Témoin assets", agent: "assets" }),
      custom({ id: ids.orphan, title: "Orpheline", agent: ORPHAN_AGENT }),
    ],
  });

  /** CANAL 1 — les blocs d'agent. Les lecteurs réels sont exactement les agents
   *  PROPOSABLES : la garde au chargement (testée plus haut) garantit que cette
   *  liste est celle des workers génériques plus les agents externes. Surtout ne
   *  pas interroger un worker à `runner` : son bloc n'est jamais construit en
   *  production, on lirait un canal qui n'existe pas. */
  const agentBlocksReading = (cfg: ResolvedRuleConfig, ruleId: string): string[] =>
    AGENT_KEYS.filter((k) => activeRuleIdsForAgent(k, cfg).includes(`custom-${ruleId}`));

  /** CANAL 2 — <editorial_rules>. L'orchestrateur y envoie le COMPLÉMENT de ce
   *  que prennent les blocs d'agent : cf. `extraRules` dans lib/analyze.ts.
   *
   *  Le prédicat était RECOPIÉ ici. Il ne l'est plus : `isGuidelinesRule` est
   *  exporté de rule-config, et c'est la fonction que la production appelle.
   *  L'ancienne note citait « lib/analyze.ts:377-379 », adresse déjà périmée
   *  quand on me l'a signalée — le filtre avait glissé de six lignes sans que
   *  rien ne rougisse. On ne cite plus que des SYMBOLES ici : un numéro n'est
   *  vrai qu'à l'instant où on l'écrit.
   *
   *  Ce que ce changement COÛTE, et je le nomme parce qu'il ne se voit pas :
   *  appeler la même fonction que la production ne teste plus le LIEN entre les
   *  deux — débrancher l'appel dans analyze.ts laisserait cet instrument vert.
   *  C'est pourquoi un test dédié, plus bas, vérifie que l'appel existe. */
  const editorialRulesReading = (cfg: ResolvedRuleConfig, ruleId: string): boolean =>
    customRulesAsBrandRules(cfg.customRules.filter(isGuidelinesRule)).some(
      (r) => r.id === `custom-${ruleId}`
    );

  it("les prémisses : la clé orpheline n'est ni proposable ni portée, 'assets' l'est", () => {
    // Sans elles, l'orpheline pourrait être un agent réel (le test mesurerait un
    // aiguillage ordinaire) et le témoin "assets" un agent mort (son canal
    // serait vide pour une tout autre raison que celle qu'on croit lire).
    expect(AGENT_KEYS).not.toContain(ORPHAN_AGENT);
    expect(WORKERS.map((w) => w.key)).not.toContain(ORPHAN_AGENT);
    expect(AGENT_KEYS).toContain("assets");
  });

  it("TÉMOIN 1 — agent absent : lue par <editorial_rules>, par aucun bloc d'agent", () => {
    const cfg = resolveRuleConfig(stored());
    expect(agentBlocksReading(cfg, ids.guidelines)).toEqual([]);
    expect(editorialRulesReading(cfg, ids.guidelines)).toBe(true);
  });

  it("TÉMOIN 2 — agent 'assets' : lue par le bloc assets SEUL, pas par <editorial_rules>", () => {
    // Le second canal compte autant que le premier : une règle qui partirait
    // dans les deux serait jugée deux fois et sortirait en doublon.
    const cfg = resolveRuleConfig(stored());
    expect(agentBlocksReading(cfg, ids.assets)).toEqual(["assets"]);
    expect(editorialRulesReading(cfg, ids.assets)).toBe(false);
  });

  it("l'orpheline est RENDUE à guidelines, pas jetée", () => {
    // Le défaut symétrique de l'oubli : un repli écrit à l'envers (règle écartée
    // au lieu d'être rendue) laisserait les deux canaux vides, exactement comme
    // avant le correctif. C'est la seconde assertion qui distingue les deux.
    const cfg = resolveRuleConfig(stored());
    expect(agentBlocksReading(cfg, ids.orphan)).toEqual([]);
    expect(editorialRulesReading(cfg, ids.orphan)).toBe(true);
  });

  it("la config STOCKÉE garde la clé morte : /rules continue de l'afficher", () => {
    // Le ré-aiguillage est une réparation À LA LECTURE. S'il réécrivait la
    // config, l'écran montrerait « guidelines » et la personne ne saurait jamais
    // que son choix n'existe plus — un troisième état effacé en silence.
    const cfgObject = stored();
    resolveRuleConfig(cfgObject);
    expect(cfgObject.customRules.map((r) => r.agent)).toEqual([
      undefined,
      "assets",
      ORPHAN_AGENT,
    ]);
  });

  it("et elle reste refusée à l'ÉCRITURE", () => {
    // Troisième état complet : gardée à la lecture, visible à l'écran, jamais
    // ré-enregistrable. Réparer la lecture ne doit pas rouvrir la porte d'entrée.
    expect(validate(write({ customRules: [custom({ agent: ORPHAN_AGENT })] }))).toEqual([
      expect.stringContaining(ORPHAN_AGENT),
    ]);
  });
});

// --- Les deux réécritures que la factorisation appelle ----------------------
//
// `isGuidelinesRule` (rule-config) et le filtre de `customRulesForAgent`
// (agents.ts) se ressemblent au point qu'on croit l'un factorisable dans
// l'autre. DEUX commentaires de production mettent en garde contre cette
// réécriture, et ils ne décrivent PAS la même mutation ni le même dégât. Ce
// bloc les départage sur des valeurs, parce qu'une mise en garde fausse coûte
// plus cher que pas de mise en garde : elle fait surveiller la mauvaise porte.
//
// Les trois routages sont MODÉLISÉS ici — c'est assumé, `customRulesForAgent`
// n'est pas exportée. Le premier modèle est ancré sur la production par une
// égalité (contrôle positif) : s'il ne reproduisait plus l'aiguillage réel, les
// deux comparaisons qui suivent ne diraient plus rien du dépôt.
//
// Mesuré le 03/09 à 14:20:34, valeurs écrites en dur.
describe("aiguillage d'une règle custom : ce que chaque réécriture ferait", () => {
  const RULES = [
    custom({ id: "sans-agent", title: "Sans agent" }),
    custom({ id: "vers-assets", title: "Vers assets", agent: "assets" }),
    custom({ id: "vers-vision", title: "Vers vision", agent: "vision" }),
  ];
  const cfg = resolveRuleConfig({ ...emptyRuleConfig(), customRules: RULES });

  /** Aiguillage RÉEL, lu sur la valeur rendue par la production. */
  const production = (): Record<string, string[]> =>
    Object.fromEntries(
      AGENT_KEYS.map((k) => [k, activeRuleIdsForAgent(k, cfg).filter((x) => x.startsWith("custom-"))])
    );

  /** Les trois filtres candidats, avec la sortie précoce de guidelines qui les
   *  précède tous dans `customRulesForAgent`. */
  const model = (predicate: (k: string) => (r: CustomRule) => boolean): Record<string, string[]> =>
    Object.fromEntries(
      AGENT_KEYS.map((k) => [
        k,
        k === GUIDELINES_AGENT_KEY ? [] : cfg.customRules.filter(predicate(k)).map((r) => `custom-${r.id}`),
      ])
    );

  const ACTUEL = { assets: ["custom-vers-assets"], liens: [], tracking: [], brief: [], guidelines: [], anomalies: [], vision: ["custom-vers-vision"] };

  it("CONTRÔLE POSITIF — le modèle « égalité stricte » reproduit la production", () => {
    // Sans cette ancre, les deux tests suivants compareraient trois fictions
    // entre elles et resteraient verts quoi qu'il arrive au dépôt.
    expect(production()).toEqual(ACTUEL);
    expect(model((k) => (r) => r.agent === k)).toEqual(ACTUEL);
  });

  it("ajouter le repli `?? guidelines` au filtre d'agent est un NO-OP", () => {
    // Le commentaire de `isGuidelinesRule` (rule-config) annonce que cette
    // mutation-là enverrait les règles sans agent DEUX fois et produirait des
    // findings en double. Mesuré : elle ne change strictement rien. La sortie
    // précoce sur guidelines a déjà consommé le seul cas où le repli jouerait,
    // et "guidelines" n'est jamais égal à la clé d'un autre agent.
    //
    // La mise en garde n'est pas inutile pour autant — le dégât qu'elle décrit
    // existe (test suivant) — mais elle nomme la mauvaise mutation. Remonté à A,
    // dont c'est le fichier ; ici on épingle la VALEUR.
    expect(model((k) => (r) => (r.agent ?? GUIDELINES_AGENT_KEY) === k)).toEqual(ACTUEL);
  });

  it("remplacer le filtre par `isGuidelinesRule` PERMUTE l'aiguillage", () => {
    // La réécriture que la ressemblance appelle vraiment, et le commentaire de
    // agents.ts a raison sur elle. `isGuidelinesRule` ignore `agentKey` : chaque
    // bloc reçoit alors la règle SANS agent, et les règles explicitement
    // routées disparaissent de leur destinataire.
    const permute = model(() => isGuidelinesRule);
    expect(permute).toEqual({
      assets: ["custom-sans-agent"],
      liens: ["custom-sans-agent"],
      tracking: ["custom-sans-agent"],
      brief: ["custom-sans-agent"],
      guidelines: [],
      anomalies: ["custom-sans-agent"],
      vision: ["custom-sans-agent"],
    });

    // Les deux dégâts, séparément, parce qu'ils ne se voient pas pareil :
    // 1. DOUBLON — la règle sans agent part dans 6 blocs ET dans
    //    <editorial_rules>, donc jugée 7 fois. Un doublon se repère au rapport.
    expect(Object.values(permute).flat().filter((id) => id === "custom-sans-agent")).toHaveLength(6);
    expect(
      customRulesAsBrandRules(cfg.customRules.filter(isGuidelinesRule)).map((r) => r.id)
    ).toEqual(["custom-sans-agent"]);
    // 2. DISPARITION — vision et assets perdent la leur. Celle-là ne se repère
    //    nulle part : un rapport sans le finding attendu ressemble à un rapport
    //    propre. C'est le dégât cher, et c'est le silencieux.
    expect(Object.values(permute).flat()).not.toContain("custom-vers-vision");
    expect(Object.values(permute).flat()).not.toContain("custom-vers-assets");
  });

  it("analyze.ts APPELLE bien le prédicat qu'on mesure ici", () => {
    // La contrepartie de ne plus recopier le filtre : cet instrument appelle
    // désormais la même fonction que la production, donc il resterait vert si
    // quelqu'un débranchait l'appel. Ce test-ci est le lien, et il rougit.
    // Lecture de SOURCE, faute de pouvoir importer l'orchestrateur (pas de
    // config vitest, l'alias `@/` ne se résout pas dans la suite).
    const src = readFileSync(join(__dirname, "..", "analyze.ts"), "utf8");
    // Contrôle positif : le champ existe et on a bien lu le bon fichier.
    expect(src).toContain("extraRules:");
    expect(src).toContain("filter(isGuidelinesRule)");
  });
});
