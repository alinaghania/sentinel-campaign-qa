// L'INVARIANT PORTEUR de la conformité au template : une paire de colonnes en
// collision sort ENTIÈRE de `ambiguousLanguages`, ou n'en sort pas du tout.
//
// POURQUOI UN TROISIÈME FICHIER SUR LE TEMPLATE, et pourquoi celui-ci n'est pas
// écrit par la même main que les deux autres : `brief-template.test.ts` (boucle
// fermée déclaration→xlsx→parse) et `brief-template-conformance.test.ts` (les 5
// fichiers réels) sont écrits par qui écrit `brief-template.ts`. Leur contenu
// est utile et leur reste ; mais l'invariant ci-dessous décide de ce que la
// plateforme REPROCHE à un marché, et il ne peut pas être validé par la main qui
// l'a posé. Le prix est un fichier de plus sur le même sujet. Il est payé ici.
//
// CE QUE L'INVARIANT PROTÈGE, en une phrase : `ambiguousLanguages` est la liste
// des colonnes du template dont la CLÉ DE COLONNE est partagée avec une autre
// colonne ACTIVÉE. Les codes qui y figurent sont exclus du reproche
// « untranslated » (brief-template.ts:765, filtre `!ambiguousSet.has(code)`) —
// parce qu'on ne sait pas distinguer « la colonne manque » de « la colonne a été
// écrasée par sa jumelle ». Si un seul membre d'une paire venait à sortir,
// l'autre resterait reprochable : la plateforme écrirait « cette colonne n'est
// pas traduite » sur un brief où elle l'est, en s'appuyant sur une mesure
// qu'elle n'a pas su faire. C'est le faux le plus cher qu'on puisse produire
// ici — il a exactement la forme d'un vrai, et il est adressé à quelqu'un qui a
// fait son travail.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE FICHIER A CHANGÉ DE MÉTIER LE 2026-09-04, et il faut le dire précisément,
// parce que la version précédente est un CONSTAT daté qui n'est plus vrai.
//
// Elle mesurait deux collisions et une colonne impossible SUR LE TEMPLATE LIVRÉ :
// ES+MX retombaient sur "ES", ZHS+ZHT sur "ZH", et TH n'était d'aucun catalogue.
// Trois des onze colonnes déclarées n'arrivaient pas dans la grille. Ce n'était
// pas un défaut de cet invariant — l'invariant tenait, et c'est justement lui
// qui empêchait les faux reproches pendant que le parseur perdait les colonnes.
// C'était un défaut de `canonColumn`, réparé depuis (lib/lang-codes.ts : la clé
// d'une colonne est le CODE DÉCLARÉ, plus la langue qu'il parle).
//
// Sur le livré, les deux listes sont donc VIDES aujourd'hui, et le premier
// describe le mesure sur les 2048 sous-ensembles : c'est la garde de la
// réparation. Mais l'invariant, lui, n'a pas cessé d'être nécessaire — les
// templates sont devenus ÉDITABLES, et une collision se déclare maintenant à la
// main : "JP" et "JA" côte à côte retombent tous deux sur "JA", "PT" et "BR"
// sur "PT". Le mécanisme n'est plus exercé par le fichier livré, il l'est par
// des templates CONSTRUITS ici. Un invariant qu'aucune donnée n'atteint plus est
// un test vert qui ne mesure rien : le déplacer était le seul moyen de le garder
// vivant. Le contrôle d'INSTRUMENT (`la collision existe bien`) est donc
// obligatoire dans chaque describe, et il y est.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, validateAgainstTemplate } from "../brief-template";
import type { BriefTemplate } from "../brief-template";
import { LANG_LABEL, canonColumn, canonLang } from "../lang-codes";
import type { BriefGrid } from "../types";

/** Les 11 clés de colonne que la grille porte pour le template LIVRÉ — une par
 *  colonne déclarée, aucune fusion. Écrites en dur : les dériver de
 *  `languageColumns` ferait suivre l'énumération au template et l'invariant
 *  cesserait de couvrir ce qu'il couvre aujourd'hui sans jamais rougir. */
const CLES_LIVRE = ["EN", "IT", "FR", "ES", "MX", "PT", "JA", "KO", "ZHS", "ZHT", "TH"] as const;

/** Template ÉDITÉ portant deux collisions déclarées à la main. C'est le seul
 *  chemin par lequel une collision arrive encore : deux codes différents qui
 *  nomment la même colonne. */
const TEMPLATE_EDITE: BriefTemplate = {
  ...DEFAULT_TEMPLATE,
  languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "JA", "BR"],
};

/** Les deux paires en collision de CE template, mesurées puis écrites. */
const PAIRES = [
  ["JP", "JA"],
  ["PT", "BR"],
] as const;

/** Template ÉDITÉ déclarant une colonne qu'aucun catalogue ne connaît. */
const TEMPLATE_INCONNU: BriefTemplate = {
  ...DEFAULT_TEMPLATE,
  languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "SV"],
};

/** Grille minimale : un seul bloc appariable au template, traduit dans toutes
 *  les langues qu'on active. La VARIABLE est l'ensemble des langues activées,
 *  et rien d'autre — une fixture porterait ses propres trous. */
const grid = (languages: readonly string[]): BriefGrid => ({
  languages: [...languages],
  blocks: [
    {
      name: "Subject Line",
      valueByLang: Object.fromEntries(languages.map((l) => [l, `texte-${l}`])),
    },
  ],
  expectedLinks: [],
});

const verdict = (languages: readonly string[], tpl: BriefTemplate = DEFAULT_TEMPLATE) =>
  validateAgainstTemplate(grid(languages), tpl, { family: "field_value" });

/** Les 2^n sous-ensembles de `cles`. L'énumération exhaustive plutôt que
 *  quelques cas choisis : les cas qu'on choisit sont ceux auxquels on pense, et
 *  l'erreur qu'on cherche est précisément celle à laquelle on ne pense pas. */
const sousEnsembles = (cles: readonly string[]): string[][] =>
  Array.from({ length: 1 << cles.length }, (_, m) => cles.filter((_c, i) => m & (1 << i)));

describe("les prémisses — l'instrument, avant toute mesure", () => {
  it("le template LIVRÉ n'a plus aucune collision : 11 codes, 11 clés", () => {
    // Sans ce contrôle, « aucune ambiguïté sur le livré » pourrait être vrai
    // parce que `canonColumn` rend `null` partout, et la liste des ambiguës
    // serait vide pour la pire des raisons.
    const cles = DEFAULT_TEMPLATE.languageColumns.map((c) => canonColumn(c));
    expect(cles).toEqual([...CLES_LIVRE]);
    expect(new Set(cles).size).toBe(11);
  });

  it("les deux paires du template ÉDITÉ retombent bien sur la même clé", () => {
    // Sans elles, « aucune paire ne sort à moitié » serait vrai parce qu'aucune
    // paire n'existe — un invariant sur l'ensemble vide.
    for (const [a, b] of PAIRES) {
      expect(TEMPLATE_EDITE.languageColumns, `${a} déclarée`).toContain(a);
      expect(TEMPLATE_EDITE.languageColumns, `${b} déclarée`).toContain(b);
      expect(canonColumn(a), `${a}/${b} en collision`).toBe(canonColumn(b));
      expect(canonColumn(a), `${a} reste portable`).not.toBeNull();
    }
    // Et la collision est bien une PROPRIÉTÉ DU CODE, pas du template : ces deux
    // paires collisionnent partout, y compris hors de ce montage.
    expect(canonColumn("JP")).toBe("JA");
    expect(canonColumn("BR")).toBe("PT");
  });
});

describe("le template LIVRÉ — la garde de la réparation", () => {
  it("aucun des 2048 sous-ensembles ne produit d'ambiguïté ni de colonne perdue", () => {
    const ambigus: string[] = [];
    const perdues: string[] = [];
    let mesurables = 0;

    for (const langs of sousEnsembles(CLES_LIVRE)) {
      const out = verdict(langs);
      // Le verdict doit rester MESURABLE : un repli « hors périmètre » sur
      // certains sous-ensembles les retirerait de l'invariant en silence.
      expect(out.state, JSON.stringify(langs)).toBe("deviation");
      if (out.state !== "deviation") continue;
      mesurables++;
      if (out.ambiguousLanguages.length > 0) {
        ambigus.push(`${JSON.stringify(langs)} → ${JSON.stringify(out.ambiguousLanguages)}`);
      }
      if (out.unsupportedLanguages.length > 0) {
        perdues.push(`${JSON.stringify(langs)} → ${JSON.stringify(out.unsupportedLanguages)}`);
      }
    }

    expect(ambigus).toEqual([]);
    expect(perdues).toEqual([]);
    expect(mesurables).toBe(2048);
  });

  it("CONTRÔLE POSITIF — le silence vient de la réparation, pas d'une liste morte", () => {
    // Deux listes vides sont exactement ce que rendrait une fonction qui ne
    // calcule plus rien. La même grille, le même appel, contre un template
    // édité : les listes se remplissent. C'est ce qui rend le vert précédent
    // lisible comme une mesure et non comme une panne.
    const livre = verdict(["ES", "MX", "ZHS", "ZHT", "TH"]);
    const edite = verdict(["JA", "PT"], TEMPLATE_EDITE);
    expect(livre.state).toBe("deviation");
    expect(edite.state).toBe("deviation");
    if (livre.state !== "deviation" || edite.state !== "deviation") return;
    expect(livre.ambiguousLanguages).toEqual([]);
    expect(edite.ambiguousLanguages).toEqual(["PT", "JP", "JA", "BR"]);
  });
});

describe("invariant : une paire en collision sort ENTIÈRE, ou pas du tout", () => {
  it("aucun des 2048 sous-ensembles ne fait sortir un SEUL membre d'une paire", () => {
    const violations: string[] = [];
    let nonVides = 0;

    for (const langs of sousEnsembles(CLES_LIVRE)) {
      const out = verdict(langs, TEMPLATE_EDITE);
      expect(out.state, JSON.stringify(langs)).toBe("deviation");
      if (out.state !== "deviation") continue;

      const ambigus = out.ambiguousLanguages;
      if (ambigus.length > 0) nonVides++;
      for (const [a, b] of PAIRES) {
        if (ambigus.includes(a) !== ambigus.includes(b)) {
          violations.push(`${JSON.stringify(langs)} → ${JSON.stringify(ambigus)}`);
        }
      }
      // Et aucune colonne HORS paire ne peut être déclarée ambiguë : ce serait
      // une exclusion silencieuse du contrôle de traduction.
      for (const code of ambigus) {
        if (!PAIRES.flat().includes(code as (typeof PAIRES)[number][number])) {
          violations.push(`${JSON.stringify(langs)} → code isolé ${code}`);
        }
      }
    }

    expect(violations).toEqual([]);
    // CONTRÔLE POSITIF, et c'est lui qui rend l'assertion précédente lisible :
    // sans lui, une implémentation qui rendrait TOUJOURS une liste vide satisfait
    // « jamais un seul membre » parfaitement. 1536 = les 2048 moins les 512
    // sous-ensembles qui n'activent ni "JA" ni "PT".
    expect(nonVides).toBe(1536);
  });

  it("CONTRÔLE NÉGATIF — sans langue en collision activée, la liste est vide", () => {
    // L'autre bord : une implémentation qui déclarerait tout ambigu passerait le
    // test précédent (les paires sortiraient toujours entières) et éteindrait le
    // contrôle de traduction pour toutes les langues.
    const out = verdict(["EN"], TEMPLATE_EDITE);
    expect(out.state).toBe("deviation");
    if (out.state !== "deviation") return;
    expect(out.ambiguousLanguages).toEqual([]);

    const complet = verdict(CLES_LIVRE, TEMPLATE_EDITE);
    expect(complet.state).toBe("deviation");
    if (complet.state !== "deviation") return;
    expect(complet.ambiguousLanguages).toEqual(["PT", "JP", "JA", "BR"]);
  });
});

describe("ce que l'ambiguïté SUPPRIME — la raison d'être de l'invariant", () => {
  // Trois grilles identiques à une langue près. C'est le seul montage où l'écart
  // est attribuable à la collision et à rien d'autre.
  const sujetTraduitEnAnglaisSeulement = (languages: readonly string[], tpl: BriefTemplate) =>
    validateAgainstTemplate(
      { languages: [...languages], blocks: [{ name: "Subject Line", valueByLang: { EN: "texte-EN" } }], expectedLinks: [] },
      tpl,
      { family: "field_value" }
    );

  const reproches = (languages: readonly string[], tpl: BriefTemplate): string[][] => {
    const out = sujetTraduitEnAnglaisSeulement(languages, tpl);
    if (out.state !== "deviation") throw new Error(`état inattendu : ${out.state}`);
    return out.untranslated.filter((u) => u.key === "subject-line").map((u) => [...u.missingLanguages]);
  };

  it("une langue SANS jumelle est reprochée (contrôle négatif du cas suivant)", () => {
    // Sans ce cas, « JA n'est pas reproché » se lirait comme « le contrôle de
    // traduction ne marche pas », et non comme « il se tait exprès ».
    expect(reproches(["EN", "FR"], TEMPLATE_EDITE)).toEqual([["FR"]]);
  });

  it("une langue en collision n'est JAMAIS reprochée, ni elle ni sa jumelle", () => {
    // Même grille, une seule langue activée de différence : le reproche
    // disparaît. C'est cette suppression que l'invariant protège — un seul membre
    // qui sortirait laisserait l'AUTRE reprochable, et la plateforme écrirait un
    // manque sur une colonne qu'elle n'a pas su lire.
    expect(reproches(["EN", "JA"], TEMPLATE_EDITE)).toEqual([]);
    expect(reproches(["EN", "PT"], TEMPLATE_EDITE)).toEqual([]);
  });

  it("SUR LE LIVRÉ, les mêmes langues sont bel et bien reprochées", () => {
    // Le pendant du cas précédent, et la mesure du GAIN de la réparation : ES,
    // MX, ZHS, ZHT et TH étaient tous exclus du contrôle de traduction tant
    // qu'ils collisionnaient. Ils y sont rentrés. Un brief qui ne traduit pas la
    // colonne MX se l'entend dire — ce qui était impossible avant le 2026-09-04.
    expect(reproches(["EN", "ES", "MX", "ZHS", "ZHT", "TH"], DEFAULT_TEMPLATE)).toEqual([
      ["ES", "MX", "ZHS", "ZHT", "TH"],
    ]);
  });
});

describe("la colonne que la plateforme ne peut PAS porter", () => {
  it("TH est PORTÉE depuis la réparation — l'aveu ne la nomme plus", () => {
    // La prémisse de l'ancien aveu, sur une valeur : TH se canonicalisait, mais
    // le catalogue des langues ne le connaissait pas, et `canonColumn` refusait
    // donc la colonne. Les deux valeurs ont changé, et c'est ce qui a retiré TH
    // de `unsupportedLanguages` — pas un assouplissement du filtre.
    expect(canonLang("TH")).toBe("TH");
    expect("TH" in LANG_LABEL).toBe(true);
    expect(canonColumn("TH")).toBe("TH");
  });

  it("une colonne déclarée qu'aucun catalogue ne connaît est nommée pour tout sous-ensemble", () => {
    // `unsupportedLanguages` ne dépend pas des langues activées : c'est un aveu
    // d'INSTRUMENT (`canonColumn` rend `null`, la colonne n'arrive jamais dans la
    // grille), pas une mesure sur la campagne. Le mesurer sur les deux bords
    // évite qu'il devienne un jour une propriété du brief.
    expect(canonColumn("SV")).toBeNull();
    for (const langs of [[], ["EN"], ["EN", "ES"], [...CLES_LIVRE]]) {
      const out = verdict(langs, TEMPLATE_INCONNU);
      expect(out.state, JSON.stringify(langs)).toBe("deviation");
      if (out.state !== "deviation") continue;
      expect(out.unsupportedLanguages, JSON.stringify(langs)).toEqual(["SV"]);
    }
  });
});
