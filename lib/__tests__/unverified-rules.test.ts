// « Ces règles n'ont été lues par PERSONNE » — les champs `key` et
// `unverifiedRuleIds` de `AgentRun` (lib/types.ts). Le SYMBOLE et pas le numéro
// de ligne : les trois adresses que ce fichier citait ont toutes glissé en une
// journée, et une adresse fausse ne rougit jamais.
//
// Ce que le dispositif promet : quand un agent est sauté ou tombe en panne, le
// rapport NOMME les règles qui lui étaient confiées. Ce qui intéresse le métier
// n'est pas « l'agent vision a été sauté » — c'est « la règle que j'ai écrite
// hier n'a été lue par personne », alors que /rules l'affiche « On ».
//
// La question que ce fichier tranche est celle qui rend un tel dispositif
// dangereux : **une implémentation qui rendrait toujours une liste vide
// passerait tous les tests « pas de faux positif » sans rien garantir.** Un
// dispositif MUET et un dispositif qui n'a rien à dire se ressemblent
// exactement. D'où un contrôle positif sur une valeur NON VIDE en tête, et des
// listes écrites en dur plutôt que des comptes.
//
// Valeurs mesurées le 03/09 à 12:10:59 et 12:11:26, puis écrites en dur.
//
// PÉRIMÈTRE, corrigé le 03/09 à 14:42 : ce fichier épingle la valeur PRODUITE,
// pas ce qu'un écran en fait. L'avertissement qui tenait ici (« rien ne les
// affiche ») est devenu FAUX — B a livré la carte « Rules no model read » dans
// components/AnalysisView.tsx, qui NOMME les règles une par ligne au lieu de
// les compter, et son repli `unverifiedRuleName` marque un identifiant qu'il ne
// connaît pas au lieu de l'escamoter. Un seul cas ci-dessous touche à cet
// écran : que les 5 règles du template y soient nommables.

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { AGENT_KEYS } from "../agent-catalog";
import { activeRuleIdsForAgent, activeRulesBlock } from "../agents";
import { DEFAULT_TEMPLATE, validateAgainstTemplate } from "../brief-template";
import { ALL_RULE_BY_ID } from "../rule-registry";
import { TEMPLATE_RUN_KEY, templateConformanceRun } from "../template-conformance-run";
import type { BriefGrid } from "../types";
import {
  DEFAULT_RULE_CONFIG,
  customRulesAsBrandRules,
  emptyRuleConfig,
  isGuidelinesRule,
  resolveRuleConfig,
  type CustomRule,
  type ResolvedRuleConfig,
} from "../rule-config";

// --- Outils ---------------------------------------------------------------

const customRule = (id: string, agent?: string): CustomRule => ({
  id,
  title: `Règle ${id}`,
  instruction: "The copy must not use superlatives such as best or unbeatable.",
  category: "content",
  examples: [],
  severity: "MAJEUR",
  enabled: true,
  ...(agent ? { agent } : {}),
});

const withRules = (...rules: CustomRule[]): ResolvedRuleConfig =>
  resolveRuleConfig({ ...emptyRuleConfig(), customRules: rules });

const withDisabled = (ruleId: string): ResolvedRuleConfig =>
  resolveRuleConfig({ ...emptyRuleConfig(), overrides: { [ruleId]: { enabled: false } } });

/** Les 7 règles de l'agent vision, dans l'ordre où elles lui sont annoncées.
 *  Écrites en dur : un COMPTE se relit mal et se satisfait de n'importe quel
 *  contenu — « 7 règles » resterait vrai si les sept étaient celles d'un autre
 *  agent. */
const VISION_RULES = [
  "llm-vision-missing-block",
  "llm-vision-broken-image",
  "llm-vision-layout-broken",
  "llm-vision-responsive",
  "llm-vision-text-clipped",
  "llm-vision-cta-broken",
  "llm-vision-footer-missing",
];

// --- Le dispositif a-t-il quelque chose à dire ? ---------------------------

describe("les règles qu'un agent absent laisse sans juge", () => {
  it("CONTRÔLE POSITIF — l'agent vision porte 7 règles, et ce sont celles-ci", () => {
    // Le cas de PRODUCTION : RENDER_REAL=0 est figé dans infra/azure/main.bicep,
    // donc l'agent vision est sauté à chaque analyse. Si cette liste était vide,
    // le rapport dirait « rien à signaler » sur sept contrôles qui n'ont jamais
    // tourné — et tous les tests d'absence ci-dessous seraient verts.
    expect(activeRuleIdsForAgent("vision", DEFAULT_RULE_CONFIG)).toEqual(VISION_RULES);
  });

  it("chaque agent proposable porte ses propres règles, jamais celles d'un autre", () => {
    // Comptes mesurés, écrits en dur. Ils tomberaient si une règle changeait
    // d'agent — ce qui est un déplacement de RESPONSABILITÉ, pas un détail de
    // catalogue : la règle serait annoncée à un modèle qui n'a pas les faits
    // pour la juger.
    const counts = Object.fromEntries(
      AGENT_KEYS.map((k) => [k, activeRuleIdsForAgent(k, DEFAULT_RULE_CONFIG).length])
    );
    expect(counts).toEqual({
      assets: 4,
      liens: 3,
      tracking: 4,
      brief: 9,
      guidelines: 4,
      anomalies: 7,
      vision: 7,
    });
  });

  it("une règle ÉTEINTE dans /rules n'est pas « non vérifiée » — elle est hors périmètre", () => {
    // La distinction qui fait tout l'intérêt du dispositif : « personne ne l'a
    // lue » et « personne n'avait à la lire » se ressemblent dans un rapport et
    // n'appellent pas la même action. Confondre les deux ferait relancer une
    // analyse pour une règle que le métier a éteinte lui-même.
    const off = withDisabled("llm-vision-missing-block");
    expect(activeRuleIdsForAgent("vision", off)).toEqual(VISION_RULES.slice(1));

    // CONTRÔLE NÉGATIF, dans le même cas : les six autres NE bougent pas. Sans
    // lui, un accesseur `enabled` cassé qui éteindrait tout donnerait la même
    // première assertion en apparence — une liste plus courte.
    expect(activeRuleIdsForAgent("vision", off)).toHaveLength(6);
    expect(activeRuleIdsForAgent("vision", off)).not.toContain("llm-vision-missing-block");
  });

  it("une règle écrite à la main et routée vers un agent le suit dans sa panne", () => {
    // C'est la raison d'être du dispositif, dite par le lead : « la règle que
    // j'ai écrite hier n'a été lue par personne ». Elle doit donc figurer dans
    // la liste de l'agent auquel elle est confiée, sous le même identifiant que
    // partout ailleurs (`custom-<id>`).
    const cfg = withRules(customRule("ma-regle", "assets"));
    expect(activeRuleIdsForAgent("assets", cfg)).toEqual([
      "llm-assets-alt-relevance",
      "llm-assets-tracking-vs-content",
      "llm-assets-visual-consistency",
      "llm-assets-declared-dimensions",
      "custom-ma-regle",
    ]);
  });
});

// --- UN MANQUE, figé comme manque et pas comme comportement ----------------
//
// ⚠️ CE TEST DOIT DEVENIR ROUGE LE JOUR DE LA RÉPARATION. Il décrit l'état
// actuel, pas la spécification. Sans cet avertissement, il deviendrait
// l'argument qui empêche de réparer — « on ne peut pas, il y a un test dessus ».
//
// Et la péremption a été VÉRIFIÉE, pas seulement promise (03/09, 14:56:16) :
// sous une réparation simulée — les règles éditoriales custom rejoignant la
// liste de l'agent guidelines, comme elles le font déjà pour assets — le cas
// ci-dessous rougit, et son contrôle positif reste vert. Une promesse de
// péremption non mesurée est une promesse qu'on ne tient pas : le jour venu, on
// « ajuste » le test au lieu de le supprimer.

describe("la règle écrite à la main qu'AUCUN rapport ne pourra nommer", () => {
  const CFG_CUSTOM = () =>
    withRules(customRule("sans-agent"), customRule("vers-guidelines", "guidelines"));
  const GUIDELINES_CATALOGUE = [
    "llm-guidelines-formality",
    "llm-guidelines-tone",
    "llm-guidelines-wording",
    "llm-guidelines-rule-hijack",
  ];

  it.fails("⚠️ DÉFAUT OUVERT — la règle custom confiée à guidelines devrait pouvoir être nommée", () => {
    // ÉCRIT À L'ENVERS, ET C'EST VOULU. `it.fails` passe tant que le corps
    // ÉCHOUE : ce cas est donc vert aujourd'hui parce que le défaut existe, et
    // il deviendra ROUGE le jour de la réparation. Le rouge sera le signal
    // qu'il faut le retourner à un `it` normal — pas une régression.
    //
    // Pourquoi pas un test vert sur le comportement actuel : un vert sur un
    // comportement qu'on sait faux devient la spécification que le prochain
    // lecteur croit. Ce qui suit est donc ce que la réparation doit RENDRE, en
    // valeur, pas ce que le code rend.
    //
    // Le défaut lui-même : c'est la raison d'être du dispositif retournée
    // contre lui — « la règle que j'ai écrite hier n'a été lue par personne ».
    // Si l'agent Guidelines tombe en panne, `analyze.ts` écrit
    // `activeRuleIdsForAgent("guidelines")` dans `unverifiedRuleIds`, et ces
    // règles-là n'y sont pas. Le métier voit « On » dans /rules, aucune alerte
    // dans le rapport, et rien n'a été lu.
    //
    // Deux écritures, un seul sort : sans champ `agent` (le défaut de /rules)
    // ou avec `agent: "guidelines"` explicite.
    expect(activeRuleIdsForAgent("guidelines", CFG_CUSTOM())).toEqual([
      ...GUIDELINES_CATALOGUE,
      "custom-sans-agent",
      "custom-vers-guidelines",
    ]);
  });

  it("CONTRÔLE — l'appel ci-dessus VIT, il n'échoue pas pour une raison étrangère", () => {
    // Sans ce cas, le `it.fails` serait vert sur n'importe quel échec : un
    // import cassé, une signature changée, une faute de frappe. Il serait alors
    // un défaut FIGÉ par un instrument mort, ce qui est pire que pas de test.
    //
    // Assertion choisie pour survivre à la réparation : les 4 règles du
    // catalogue sont là, et la liste n'est pas vide. Épingler `toEqual` les 4
    // SEULES rendrait ce cas rouge le jour de la réparation — et cimenterait le
    // faux exactement là où je viens de refuser de le faire.
    const ids = activeRuleIdsForAgent("guidelines", CFG_CUSTOM());
    expect(ids).toEqual(expect.arrayContaining(GUIDELINES_CATALOGUE));
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });

  it("les règles custom sont bien ACTIVES — le rapport seul est aveugle, pas le modèle", () => {
    // Ce que le défaut n'est PAS, et il faut l'écrire ou la réparation partira
    // dans la mauvaise direction : les deux règles voyagent réellement jusqu'au
    // modèle, par `<editorial_rules>` / `guidelinesJson` — un canal que
    // `activeRuleIdsForAgent` ne connaît pas. Le modèle les reçoit ; c'est le
    // RAPPORT qui ne sait pas les nommer. Cette mesure-ci reste vraie après la
    // réparation, donc elle ne cimente rien.
    const cfg = CFG_CUSTOM();
    expect(customRulesAsBrandRules(cfg.customRules.filter(isGuidelinesRule)).map((r) => r.id)).toEqual([
      "custom-sans-agent",
      "custom-vers-guidelines",
    ]);
  });

  it("CONTRÔLE POSITIF — la même règle confiée à un vrai worker, elle, serait nommée", () => {
    // Sans ce cas, le précédent se lirait « les règles custom ne rejoignent
    // jamais un agent », c'est-à-dire une propriété du dispositif. C'est faux,
    // et c'est ce qui rend le manque réparable : le chemin existe et marche.
    // Le défaut est LOCAL à guidelines, seul agent dont les règles custom
    // passent par un canal séparé.
    expect(activeRuleIdsForAgent("assets", withRules(customRule("vers-assets", "assets")))).toEqual([
      "llm-assets-alt-relevance",
      "llm-assets-tracking-vs-content",
      "llm-assets-visual-consistency",
      "llm-assets-declared-dimensions",
      "custom-vers-assets",
    ]);
  });
});

// --- L'exception Traduction, écrite comme une décision ---------------------

describe("l'agent Traduction ne liste AUCUNE règle, et c'est un choix tenu", () => {
  it("il n'en porte aucune — trois mécanismes indépendants l'en empêchent", () => {
    // Ce n'est pas un cas limite qu'on aurait oublié de couvrir : sa panne
    // laisse des ÉCARTS NON ARBITRÉS, pas des règles sans juge. Son protocole
    // est fixe, il ne lit aucune règle de /rules. Un test qui exigerait une
    // liste non vide pour tous les agents casserait ce choix sans le comprendre
    // — d'où ce cas, écrit à l'endroit où quelqu'un viendrait « corriger ».
    expect(activeRuleIdsForAgent("translation", DEFAULT_RULE_CONFIG)).toEqual([]);

    // Et il ne peut pas en recevoir par accident. Trois portes, toutes fermées,
    // et chacune testée ailleurs : agent-catalog ne le propose pas, la route
    // refuse de l'enregistrer, et resolveRuleConfig ré-aiguille vers guidelines
    // une règle déjà stockée qui le nommerait. La conséquence se mesure ici.
    expect(AGENT_KEYS).not.toContain("translation");
    const cfg = withRules(customRule("visant-translation", "translation"));
    expect(activeRuleIdsForAgent("translation", cfg)).toEqual([]);
  });
});

// --- La propriété de conception : UNE sélection, deux rendus ---------------

describe("le rapport nomme EXACTEMENT ce qui a été annoncé au modèle", () => {
  it("pour chaque agent, les identifiants du rapport sont ceux du prompt", () => {
    // La propriété vaut mieux qu'une égalité vérifiée à la main : les deux
    // listes sortent d'une sélection unique (`activeRulesFor`, lib/agents.ts).
    // Le jour où quelqu'un les redédouble « pour simplifier », c'est ce test
    // qui doit tomber — sans lui, le rapport pourrait nommer des règles que
    // l'agent n'a jamais lues, ou taire celles qu'il devait lire, et les deux
    // erreurs sont invisibles depuis l'écran.
    for (const key of AGENT_KEYS) {
      const ids = activeRuleIdsForAgent(key, DEFAULT_RULE_CONFIG);
      const announced = [...activeRulesBlock(key, DEFAULT_RULE_CONFIG).matchAll(/^- (\S+) : /gm)].map(
        (m) => m[1]
      );
      expect(announced, key).toEqual(ids);
      // Contrôle positif de la lecture du bloc : un motif qui ne matcherait
      // plus rien rendrait deux listes vides, donc égales, donc vertes.
      expect(announced.length, key).toBeGreaterThan(0);
    }
  });

  it("une règle écrite à la main est annoncée au modèle SOUS LE MÊME identifiant", () => {
    const cfg = withRules(customRule("ma-regle", "tracking"));
    expect(activeRulesBlock("tracking", cfg)).toContain("- custom-ma-regle : Règle ma-regle");
    expect(activeRuleIdsForAgent("tracking", cfg)).toContain("custom-ma-regle");
  });
});

// --- Ce que la ligne du rapport doit porter -------------------------------
//
// Mesuré sur le SOURCE, faute de pouvoir appeler `runAnalysis` depuis la suite
// (il lui faut le pipeline complet). L'extraction est structurelle — appariement
// d'accolades, pas de numéros de ligne — parce que lib/analyze.ts bouge
// plusieurs fois par heure. Chaque cas porte son contrôle positif : une
// réécriture qui casserait l'extraction rend ce fichier ROUGE, pas muet.
//
// La leçon est fraîche : mon premier motif cherchait `key:` et donnait un faux
// « champ manquant » sur `{ agent, key, status }`, où la propriété est écrite
// en RACCOURCI. Un motif qui ne connaît qu'une syntaxe mesure sa propre syntaxe.
//
// VÉRIFIÉ PAR MUTATION le 03/09 à 14:42:18 et 14:42:38, sur des copies mutées
// du texte de analyze.ts (l'original jamais touché) : une ligne `done` qui se
// met à nommer des règles est vue · une DEUXIÈME ligne qui perd sa clé est vue
// par les deux gardes · un extracteur rendu muet fait ROUGIR les deux au lieu
// de les verdir. Ce dernier leurre est le seul qui compte vraiment : c'est la
// panne qui rend un fichier de gardes silencieusement inutile.

describe("les lignes d'agent écrites dans le rapport", () => {
  const pushes = (): Array<{ block: string; status: string }> => {
    const src = readFileSync(join(__dirname, "..", "analyze.ts"), "utf8");
    const out: Array<{ block: string; status: string }> = [];
    const re = /agentRuns\.push\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length - 1;
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      const block = src.slice(m.index, i + 1);
      out.push({ block, status: /status: "(\w+)"/.exec(block)?.[1] ?? "" });
    }
    return out;
  };

  /** `key: w.key` ET `key,` en raccourci : les deux écritures existent dans le
   *  fichier, et une seule des deux serait une mesure de ma syntaxe à moi. */
  const hasKey = (block: string) => /\bkey\s*[:,]/.test(block) || /\bkey\s*\}/.test(block);

  /** Les lignes d'agent que `analyze.ts` pousse par une VARIABLE, avec le test
   *  qui les couvre vraiment. Un nom qui n'est pas ici fait rougir : c'est le
   *  seul moyen que le déplacement d'une ligne hors de ce fichier reste visible. */
  const LIGNES_INDIRECTES: Record<string, string> = {
    templateRun: "templateConformanceRun — couvert plus bas, en EXÉCUTION",
  };

  it("l'extraction lit bien des lignes d'agent, de plusieurs statuts", () => {
    // Contrôle positif de l'instrument, avant toute affirmation d'absence : les
    // deux cas suivants sont des « aucun ne manque », et un extracteur qui ne
    // rendrait rien les rendrait verts.
    const all = pushes();
    expect(all.length).toBeGreaterThan(8);
    expect(new Set(all.map((p) => p.status))).toEqual(new Set(["error", "done", "skipped"]));
  });

  it("les DEUX extracteurs voient tous les pushes — aucun ne se range dans l'angle mort", () => {
    // Proposée par C après que le déplacement d'une ligne hors d'`analyze.ts`
    // eut rendu mon extracteur aveugle à un push sur douze, et gardée bien que
    // ma réparation par NOMMAGE soit plus précise que son COMPTE : les deux
    // instruments ne couvrent pas le même trou.
    //
    // Le mien lit deux formes — l'objet en toutes lettres `push({…})` et
    // l'identifiant nu `push(nom)`. Une troisième existe et n'entre dans
    // aucune : `agentRuns.push(makeRun())`. Elle ne serait ni comptée, ni
    // nommée, ni rouge — la ligne s'effacerait de mes gardes sans que rien ne
    // bouge. Le rapprochement ci-dessous l'attrape sans rien connaître de sa
    // forme, parce qu'il compte les `push(` BRUTS.
    const src = readFileSync(join(__dirname, "..", "analyze.ts"), "utf8");
    const bruts = src.match(/agentRuns\.push\(/g)?.length ?? 0;
    const litteraux = pushes().length;
    const indirects = [...src.matchAll(/agentRuns\.push\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].length;

    // Contrôle positif AVANT l'égalité : `0 === 0 + 0` serait vrai sur un
    // fichier vide, un chemin faux, ou une regex cassée — l'égalité seule est
    // satisfaite par l'instrument mort.
    expect(bruts).toBe(12); // mesuré le 03/09 à 15:06
    expect([litteraux, indirects]).toEqual([11, 1]);
    expect(litteraux + indirects).toBe(bruts);
  });

  it("toute ligne d'agent SAUTÉ ou EN PANNE porte sa clé", () => {
    // Le libellé ne suffit pas : il est traduit, réécrit, et deux agents peuvent
    // finir homonymes. La clé est la seule chose qui relie la ligne aux règles
    // qu'on vient d'y nommer — sans elle, `unverifiedRuleIds` est une liste
    // d'identifiants rattachée à rien.
    //
    // PORTÉE, et elle est plus étroite que le titre : cet extracteur ne voit que
    // les objets écrits EN TOUTES LETTRES dans l'appel. Le cas suivant garde
    // l'autre porte.
    const orphans = pushes()
      .filter((p) => p.status === "error" || p.status === "skipped")
      .filter((p) => !hasKey(p.block));
    expect(orphans.map((p) => p.block.slice(0, 80))).toEqual([]);
  });

  it("toute ligne qui ÉCRIT des règles non vérifiées porte sa clé, quel que soit son statut", () => {
    // Question du lead : le filtre `skipped || error` a-t-il un trou ? Le
    // raisonnement du cas précédent porte sur le LIEN entre la ligne et les
    // règles qu'elle nomme — pas sur son statut. Le critère juste est donc
    // peut-être celui-ci, et il ne se décide pas sur un énoncé.
    //
    // MESURÉ le 03/09 à 14:40:12, sur les 11 lignes écrites en toutes lettres :
    // 5 écrivent `unverifiedRuleIds` (1 `error`, 4 `skipped`), AUCUNE `done`.
    // Le trou n'existe donc pas aujourd'hui, et je n'élargis pas le cas
    // précédent sur une hypothèse. Ce cas-ci est la garde du jour où il
    // s'ouvrirait : une ligne `done` qui nommerait des règles rougit ici.
    const ecrivent = pushes().filter((p) => /unverifiedRuleIds/.test(p.block));
    // Contrôle positif sur une valeur : un extracteur cassé rendrait 0 ligne,
    // donc 0 orpheline, donc un vert parfait. Ce 5 est à re-mesurer — pas à
    // rapiécer — le jour où une ligne d'agent est ajoutée ou retirée.
    expect(ecrivent.length).toBe(5);
    expect(ecrivent.filter((p) => !hasKey(p.block)).map((p) => p.block.slice(0, 80))).toEqual([]);
    // Le fait daté, écrit comme une valeur plutôt qu'en commentaire : il
    // rougira le jour où il cessera d'être vrai.
    expect(ecrivent.map((p) => p.status).sort()).toEqual([
      "error",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  it("UNE seule ligne se passe de clé, et on sait laquelle", () => {
    // Troisième état plutôt qu'une exception muette : la ligne connue est
    // décrite par ce qu'elle EST (une capture d'écran réussie, qui ne nomme
    // aucune règle), et toute autre sort par son texte. Sans ce cas, une
    // deuxième ligne sans clé pourrait s'ajouter en `done` sans rien réveiller
    // — B s'appuie sur `agents.some((a) => a.key !== undefined)` dans
    // AnalysisView, un discriminant qui vaut au niveau du RAPPORT et ne dit
    // rien ligne par ligne.
    const sansCle = pushes().filter((p) => !hasKey(p.block));
    expect(sansCle.map((p) => p.status)).toEqual(["done"]);
    expect(sansCle.map((p) => /unverifiedRuleIds/.test(p.block))).toEqual([false]);
  });

  it("toute ligne poussée INDIRECTEMENT est couverte par un test EXÉCUTÉ", () => {
    // Écrit après un manque mesuré. À 14:24:59 ce fichier a rougi sur une ligne
    // `skipped` sans clé, écrite en toutes lettres dans analyze.ts. Elle a été
    // déplacée dans lib/template-conformance-run.ts et munie de sa clé — mais le
    // déplacement seul aurait suffi à éteindre l'alarme : `agentRuns.push(x)` ne
    // ressemble plus à `agentRuns.push({`. Une garde qu'un refactoring désarme
    // en silence est pire qu'une garde absente, parce qu'elle reste verte.
    //
    // TROIS états, donc : la valeur connue est nommée avec l'endroit où elle est
    // vraiment exécutée, l'inconnue est GARDÉE et sort par son nom.
    const src = readFileSync(join(__dirname, "..", "analyze.ts"), "utf8");
    const indirects = [...src.matchAll(/agentRuns\.push\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].map((m) => m[1]);
    // Contrôle positif de l'extraction, sur une valeur : sans lui, un motif qui
    // ne matcherait plus rien rendrait une liste vide, donc un fichier vert.
    expect(indirects).toEqual(["templateRun"]);
    expect(indirects.filter((n) => !(n in LIGNES_INDIRECTES))).toEqual([]);
  });

  it("aucune liste de règles non vérifiées n'est écrite VIDE", () => {
    // `undefined` se lit « inconnu », `[]` se lit « rien à signaler ». Les 133
    // rapports déjà enregistrés n'ont pas le champ : les confondre changerait
    // 133 rapports muets en 133 rapports rassurants. Tout ce qui est écrit dans
    // le champ passe donc par `nonEmpty`, directement ou par une liaison qui en
    // vient.
    const src = readFileSync(join(__dirname, "..", "analyze.ts"), "utf8");
    expect(src).toContain("const visionRuleIds = nonEmpty(");
    const values = [...src.matchAll(/unverifiedRuleIds:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(values.length).toBeGreaterThan(2); // contrôle positif de l'extraction
    for (const v of values) {
      expect(v, v).toMatch(/^(undefined|visionRuleIds|nonEmpty\()/);
    }
  });
});

// --- La ligne « Conformité au template », EXÉCUTÉE -------------------------
//
// Le seul endroit de ce fichier où une ligne d'agent est mesurée pour de vrai
// et non lue en texte : `lib/template-conformance-run.ts` a été sorti de
// analyze.ts précisément pour être appelable sans tirer Azure ni Playwright.
// La regex prouve qu'une ligne est ÉCRITE ; ceci prouve ce qu'elle VAUT.
//
// Ce que la fonction décide n'est pas cosmétique : elle choisit entre un AVEU
// (des règles actives n'ont eu aucun juge, on les NOMME) et un CONSTAT (le
// template ne gouverne pas ce brief). Se tromper de branche produit soit une
// alarme « règles non vérifiées » sur un brief hors sujet — le bruit qui
// apprend au métier à ignorer l'encadré — soit un silence sur des règles
// réellement non lues.
//
// Valeurs mesurées le 03/09 à 14:34:46 et 14:36:32, puis écrites en dur. Les
// trois états `not_applicable` viennent d'appels RÉELS à
// `validateAgainstTemplate`, pas d'objets fabriqués : un littéral que j'aurais
// écrit à la main testerait ma lecture du type, pas la valeur que la
// production fait circuler.
//
// VÉRIFIÉ PAR MUTATION le 03/09 à 14:37:50, sur le VRAI source : cinq copies
// mutées de template-conformance-run.ts, importées puis effacées, sans jamais
// modifier l'original. Les cinq sont vues — clé retirée, aveu débordant sur les
// constats, `nonEmpty` rendant `[]`, ligne jamais poussée, sélecteur de
// catalogue muet.
//
// CE QUI N'EST PAS COUVERT ICI, et il vaut mieux l'écrire que le laisser
// croire : la branche `selectorBroken` (« règles concernées non identifiables »)
// n'est pas atteignable depuis un test — il faudrait vider RULE_CATALOG. Elle a
// été vue rendre la bonne phrase sous mutation M5, et rien de plus.

describe("la ligne d'agent de la conformité au template", () => {
  /** Grille minimale. Le nom du bloc est la SEULE variable : « Subject Line »
   *  est un champ du template, « Zzz Inconnu » n'en est aucun. */
  const grid = (name: string): BriefGrid => ({
    languages: ["EN"],
    blocks: [{ name, valueByLang: { EN: "texte" } }],
    expectedLinks: [],
  });

  const conformance = (opts: { family?: string }, name = "Subject Line") =>
    validateAgainstTemplate(grid(name), DEFAULT_TEMPLATE, opts as Parameters<typeof validateAgainstTemplate>[2]);

  const AVEU = conformance({}); // family_unknown
  const HORS_FAMILLE = conformance({ family: "grid" }); // other_family
  const AUCUN_CHAMP = conformance({ family: "field_value" }, "Zzz Inconnu"); // no_field_matched

  /** Les 5 règles branchées sur `validateAgainstTemplate`, dans l'ordre du
   *  catalogue. Écrites en dur : un COMPTE resterait vrai si c'étaient les
   *  règles d'un autre contrôle, et c'est justement ce que la ligne promet de
   *  nommer. Elles étaient QUATRE dans ma première lecture du catalogue —
   *  `template-field-shared-cell` s'était glissée hors de ma fenêtre de grep. */
  const REGLES_TEMPLATE = [
    "template-structure",
    "template-language-coverage",
    "template-language-ambiguous",
    "template-language-unsupported",
    "template-field-shared-cell",
  ];

  it("les prémisses : les trois refus sont bien ceux que la production produit", () => {
    // Sans ce cas, tout ce qui suit pourrait porter sur un état que
    // `validateAgainstTemplate` ne rend jamais — un test parfaitement vert sur
    // une branche morte.
    expect([AVEU.state, HORS_FAMILLE.state, AUCUN_CHAMP.state]).toEqual([
      "not_applicable",
      "not_applicable",
      "not_applicable",
    ]);
    if (
      AVEU.state !== "not_applicable" ||
      HORS_FAMILLE.state !== "not_applicable" ||
      AUCUN_CHAMP.state !== "not_applicable"
    ) return;
    expect([AVEU.cause, HORS_FAMILLE.cause, AUCUN_CHAMP.cause]).toEqual([
      "family_unknown",
      "other_family",
      "no_field_matched",
    ]);
  });

  it("AVEU — famille inconnue : la ligne NOMME les 5 règles restées sans juge", () => {
    // « On ignore si ces règles s'appliquaient » ne se rend pas par un écran
    // vide : elles ont bel et bien été laissées sans juge. C'est le seul des
    // trois cas où la liste doit être écrite.
    expect(templateConformanceRun(AVEU, DEFAULT_RULE_CONFIG)).toEqual({
      agent: "Conformité au template",
      key: "template",
      status: "skipped",
      detail:
        "conformité au template NON mesurée — Brief layout was not measured for this campaign — no conformance verdict is issued against Kering EMAIL brief — v1.",
      unverifiedRuleIds: REGLES_TEMPLATE,
    });
  });

  it("CONSTAT — hors famille ou aucun champ : aucune règle n'est nommée", () => {
    // Le contrôle négatif de l'aveu, et la moitié de la valeur du dispositif :
    // lister ces règles sur un brief que le template ne gouverne pas serait la
    // même faute que compter une règle volontairement éteinte.
    for (const [nom, tc] of [
      ["other_family", HORS_FAMILLE],
      ["no_field_matched", AUCUN_CHAMP],
    ] as const) {
      const out = templateConformanceRun(tc, DEFAULT_RULE_CONFIG);
      expect(out?.key, nom).toBe("template");
      expect(out?.status, nom).toBe("skipped");
      // `undefined` se lit « inconnu », `[]` se lirait « on a regardé, rien à
      // signaler ». La distinction est tout le sujet de ce fichier.
      expect(out?.unverifiedRuleIds, nom).toBeUndefined();
      expect(out?.unverifiedRuleIds, nom).not.toEqual([]);
    }
    expect(templateConformanceRun(HORS_FAMILLE, DEFAULT_RULE_CONFIG)?.detail).toBe(
      'template hors périmètre pour ce brief — Brief layout "grid" is outside the canonical template (Kering EMAIL brief — v1).'
    );
    expect(templateConformanceRun(AUCUN_CHAMP, DEFAULT_RULE_CONFIG)?.detail).toBe(
      "template hors périmètre pour ce brief — No field of Kering EMAIL brief — v1 was recognised in this brief — it does not describe the EMAIL channel."
    );
  });

  it("un fichier ILLISIBLE est un AVEU, et il ne se confond pas avec l'autre aveu", () => {
    // Histoire de ce cas, parce qu'elle est la raison de sa forme. Une
    // quatrième cause est apparue vers 14:55 — `none`, le repli du parseur quand
    // il n'a reconnu aucune disposition, a reçu `layout_unreadable` au lieu de
    // se confondre avec `other_family`. Mesuré à 14:58:38, elle se rangeait
    // en SILENCE dans la branche constat : un classeur que la plateforme n'a PAS
    // SU LIRE était annoncé « template hors périmètre pour ce brief », avec
    // 0 règle nommée. `tsc` était vert — un ternaire est TOTAL sur une union,
    // donc aucun outil ne pouvait le voir. C'est réparé depuis 14:59 par un
    // `switch` exhaustif ; ce test est ce qui empêchera la cinquième cause de
    // refaire le même chemin.
    const tc = conformance({ family: "none" });
    expect(tc.state).toBe("not_applicable"); // prémisse, sur une valeur
    if (tc.state !== "not_applicable") return;
    expect(tc.cause).toBe("layout_unreadable");

    const out = templateConformanceRun(tc, DEFAULT_RULE_CONFIG);
    expect(out?.unverifiedRuleIds).toEqual(REGLES_TEMPLATE);

    // DEUX assertions et non une, parce que les deux moitiés de cette phrase
    // n'ont pas le même propriétaire ni la même durée de vie.
    //
    // Le PRÉFIXE porte la décision et appartient à `decideCause` : il reste un
    // littéral en dur. Il a d'ailleurs déjà bougé une fois — j'épinglais
    // « aucune disposition de brief lue », reformulé en production à 15:14:02
    // pour dire QUI n'a pas lu (l'analyse déterministe, laissant sa place au
    // scout LLM). Ma valeur était périmée, pas fausse ; c'est le bon sens de
    // rouge, et il a coûté une minute.
    //
    // La RAISON, elle, vient de brief-template.ts et se reformule au gré de
    // l'écran. Épingler la concaténation entière faisait de mon fichier un
    // frein à toute amélioration de prose écrite par quelqu'un d'autre : le
    // test devenait l'argument qui empêche de réparer. On vérifie donc le
    // CONTRAT d'assemblage — préfixe puis raison, dans cet ordre, séparés par
    // le tiret — sans réécrire la raison.
    expect(out?.detail).toBe(
      `aucune disposition de brief lue par l'analyse déterministe — conformité au template NON mesurée — ${tc.reason}`
    );
    // Et la raison n'est pas vide : sans ce contrôle, un `tc.reason` devenu
    // chaîne vide rendrait l'assertion ci-dessus verte sur une phrase tronquée.
    expect(tc.reason.length).toBeGreaterThan(40);

    // Les DEUX aveux nomment les mêmes règles — donc seule la phrase les
    // distingue, et cette phrase porte une différence qui compte :
    // `family_unknown` se résorbe seul (campagne antérieure à la mesure de
    // famille), `layout_unreadable` désigne un classeur que la QA n'ouvre pas
    // et ne se résorbera jamais. Sans cette assertion, les unifier plus tard
    // « pour simplifier » ne réveillerait rien.
    const aveuVoisin = templateConformanceRun(AVEU, DEFAULT_RULE_CONFIG);
    expect(aveuVoisin?.unverifiedRuleIds).toEqual(out?.unverifiedRuleIds);
    expect(aveuVoisin?.detail).not.toBe(out?.detail);
  });

  it("une cause INCONNUE est gardée du côté de l'aveu, et NOMMÉE", () => {
    // Le troisième état, et la seule branche que ni le type ni les fixtures ne
    // peuvent atteindre : un rapport enregistré hier peut porter une cause que
    // ce code ne connaît pas. Se replier sur « hors périmètre » referait
    // exactement le défaut de 14:58 — absoudre en silence. On force donc une
    // cause hors union, ce que seul un test peut faire.
    const futur = { ...(conformance({ family: "none" }) as object), cause: "zzz_futur", reason: "RAISON-INVENTEE" };
    const out = templateConformanceRun(futur as Parameters<typeof templateConformanceRun>[0], DEFAULT_RULE_CONFIG);
    expect(out?.detail).toBe(
      "conformité au template NON mesurée (cause non reconnue : zzz_futur) — RAISON-INVENTEE"
    );
    // GARDÉE, pas seulement nommée : les règles restent listées. Une inconnue
    // silencieuse serait un « rien à signaler » sur un contrôle jamais fait.
    expect(out?.unverifiedRuleIds).toEqual(REGLES_TEMPLATE);
    // Contrôle négatif : le constat, lui, ne bascule pas du côté de l'aveu.
    expect(templateConformanceRun(HORS_FAMILLE, DEFAULT_RULE_CONFIG)?.unverifiedRuleIds).toBeUndefined();
  });

  it("aucune ligne quand il n'y a rien à dire — et le contrôle positif juste à côté", () => {
    // Deux silences légitimes : le contrôle n'a pas tourné, ou il a JUGÉ (ses
    // écarts partent en findings, une ligne d'agent en plus raconterait deux
    // fois la même mesure). Le cas `deviation` vient d'un appel réel.
    expect(templateConformanceRun(null, DEFAULT_RULE_CONFIG)).toBeNull();
    const juge = conformance({ family: "field_value" });
    expect(juge.state).toBe("deviation"); // prémisse, sur une valeur
    expect(templateConformanceRun(juge, DEFAULT_RULE_CONFIG)).toBeNull();
    // Sans celui-ci, une fonction qui rendrait TOUJOURS `null` passerait les
    // deux assertions ci-dessus sans rien garantir.
    expect(templateConformanceRun(AVEU, DEFAULT_RULE_CONFIG)).not.toBeNull();
  });

  it("une règle de template ÉTEINTE dans /rules sort de la liste, les autres restent", () => {
    // Même distinction que pour les agents LLM : « personne ne l'a lue » et
    // « personne n'avait à la lire » n'appellent pas la même action.
    const uneEteinte = resolveRuleConfig({
      ...emptyRuleConfig(),
      overrides: { "template-structure": { enabled: false } },
    });
    expect(templateConformanceRun(AVEU, uneEteinte)?.unverifiedRuleIds).toEqual(
      REGLES_TEMPLATE.slice(1)
    );

    // Toutes éteintes : la ligne reste POUSSÉE — la conformité n'a toujours pas
    // été mesurée, et c'est une information — mais elle ne nomme plus personne,
    // et surtout pas `[]`.
    const toutesEteintes = resolveRuleConfig({
      ...emptyRuleConfig(),
      overrides: Object.fromEntries(REGLES_TEMPLATE.map((id) => [id, { enabled: false }])),
    });
    const out = templateConformanceRun(AVEU, toutesEteintes);
    expect(out?.detail).toContain("NON mesurée");
    expect(out?.unverifiedRuleIds).toBeUndefined();
  });

  it("les 5 identifiants sont NOMMABLES par l'écran qui les affiche", () => {
    // AnalysisView (`unverifiedRuleName`) rend l'identifiant brut suivi de
    // « rule id not in the current catalogue » quand il ne le connaît pas. Ce
    // repli est un bon troisième état, mais l'atteindre ici voudrait dire que
    // l'encadré affiche `template-language-ambiguous` à un chef de projet.
    expect(REGLES_TEMPLATE.map((id) => ALL_RULE_BY_ID[id]?.label ?? "ABSENT")).toEqual([
      "Brief follows the campaign template",
      "Every activated language is filled in",
      "Report languages the platform cannot tell apart",
      "Report template languages the platform cannot carry at all",
      "Report brief cells that carry several template fields",
    ]);
  });

  it("`template` IDENTIFIE la ligne sans devenir une cible de routage", () => {
    // La clé ne doit pas entrer dans AGENT_KEYS : elle deviendrait choisissable
    // dans /rules, et une règle écrite à la main qu'on lui confierait serait
    // enregistrée, affichée « On », et n'entrerait dans aucun prompt. C'est mot
    // pour mot la raison de l'exclusion de `translation`, déjà épinglée plus
    // haut. Le test vit ici parce que la tentation de « réparer » naîtra en
    // lisant `AgentRun.key` — c'est-à-dire en lisant ce fichier.
    expect(TEMPLATE_RUN_KEY).toBe("template");
    expect(AGENT_KEYS).not.toContain(TEMPLATE_RUN_KEY);
    const cfg = withRules(customRule("visant-template", TEMPLATE_RUN_KEY));
    expect(activeRuleIdsForAgent(TEMPLATE_RUN_KEY, cfg)).toEqual([]);
    // Contrôle positif : la même règle confiée à un vrai agent, elle, arrive.
    expect(activeRuleIdsForAgent("assets", withRules(customRule("visant-assets", "assets")))).toContain(
      "custom-visant-assets"
    );
  });
});
