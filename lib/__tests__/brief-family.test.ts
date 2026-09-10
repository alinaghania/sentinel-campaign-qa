// `briefFamily` : la famille du brief, de son écriture à l'import jusqu'au
// verdict de conformité au template.
//
// POURQUOI CE FICHIER EXISTE À PART, et pourquoi il est écrit par quelqu'un qui
// n'a touché aucun des trois maillons : la chaîne traverse quatre fichiers
// (route d'import → Campaign → analyze → checks-code → brief-template) et
// chaque maillon a été posé par une main différente. Chacune de ces mains, en
// validant son propre maillon, mesurerait le geste qu'elle vient de faire.
// Ce qui manque n'est pas la vérification d'un maillon, c'est celle du PASSAGE.
//
// Ce que le champ décide : sans lui, un brief d'une AUTRE famille reçoit un
// verdict circonstancié — mesuré sur bal-newsletter-grid.xlsx, 3 champs
// reconnus et 10 requis déclarés manquants — contre une spec qui ne le
// gouverne pas. Un appelant qui omet la famille ne dégrade pas la mesure : il
// en FABRIQUE une. C'est le défaut le plus coûteux du lot, parce que le faux
// qu'il produit a exactement la forme d'un vrai.
//
// Toutes les valeurs attendues ci-dessous ont été MESURÉES le 03/09 à 12:02:36,
// puis écrites en dur. Aucune n'est recalculée depuis le code testé. Les états
// « famille absente » et « hors périmètre » ont été REMESURÉS à 14:14:42, après
// que checks-code.ts a cessé de rendre `null` sans famille (cf. le test du
// troisième état, qui porte l'histoire de ce changement).

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { runCodeChecks } from "../checks-code";
import { parseEmailFacts } from "../parse-email";
import type { BriefGrid } from "../types";

// --- Le sujet constant -----------------------------------------------------

/** Grille écrite à la main, et non un des cinq fichiers réels : ici la VARIABLE
 *  est la famille, et rien d'autre. Une fixture porterait sa propre famille,
 *  ses propres langues et ses propres trous — trois raisons pour un chiffre de
 *  bouger, quand on veut n'en mesurer qu'une. Les cas sur fichiers réels vivent
 *  dans brief-template-conformance.test.ts et répondent à une autre question. */
const GRID: BriefGrid = {
  languages: ["EN"],
  blocks: [{ name: "Subject line", valueByLang: { EN: "Spring drop" } }],
  expectedLinks: [],
};

const EMAIL = "<html><body><p>Hello</p></body></html>";

type Family = "field_value" | "grid" | "none";

const run = (briefFamily?: Family) =>
  runCodeChecks({
    facts: parseEmailFacts(EMAIL),
    linkResults: [],
    briefGrid: GRID,
    briefFamily,
    detectedLanguage: { lang: "EN", confidence: "high" },
  });

/** Les findings du template se reconnaissent à leur LOCATEUR, pas seulement à
 *  leur ruleId : c'est `template#<champ>` qui désigne l'endroit du brief mis en
 *  cause, et c'est ce que le lead a demandé de compter. Un finding dont le
 *  ruleId serait perdu en route resterait visible ici. */
const templateLocators = (out: ReturnType<typeof run>): string[] =>
  out.findings.filter((f) => f.locator.startsWith("template#")).map((f) => f.locator);

// --- Les quatre états, sur la valeur rendue ---------------------------------

describe("briefFamily décide si le template a un SUJET", () => {
  it("CONTRÔLE NÉGATIF — famille field_value : le verdict réel sort toujours", () => {
    // Il vient d'abord, parce que c'est lui qui donne son sens à tous les
    // autres : une garde qui rendrait « hors périmètre » PARTOUT ferait passer
    // les trois cas suivants sans avoir rien montré, et aurait éteint le
    // contrôle en silence. Le vert des cas « zéro finding » n'est lisible
    // qu'à côté de ce rouge-ci.
    const out = run("field_value");
    expect(out.templateConformance?.state).toBe("deviation");
    if (out.templateConformance?.state !== "deviation") return;
    expect(out.templateConformance.matched).toBe(1);
    expect(out.templateConformance.missing).toHaveLength(12);
    expect(out.templateConformance.extra).toHaveLength(0);

    // 12 = les 12 champs requis absents, et RIEN d'autre. Ils valaient 13
    // jusqu'au 2026-09-04 : le treizième était un signalement d'INSTRUMENT (la
    // colonne TH du template, qu'aucun catalogue ne connaissait). Il ne parlait
    // pas du brief, il disait ce qui n'avait pas pu être mesuré — et les compter
    // ensemble sans le nommer aurait fait passer un aveu pour un reproche.
    // L'aveu a disparu parce que sa cause a été réparée (TH est portée), pas
    // parce qu'on a cessé de l'émettre : le mécanisme garde sa garde, sur un
    // template construit, en lib/__tests__/brief-template.test.ts.
    const locators = templateLocators(out);
    expect(locators).toHaveLength(12);
    expect(locators).toContain("template#preheader");
    expect(locators).not.toContain("template#unsupported-languages");
  });

  it("CONTRÔLE POSITIF — famille grid : hors périmètre, ZÉRO finding template#", () => {
    // Le cas qui fabrique aujourd'hui un verdict quand la famille ne circule
    // pas : la même grille, la même spec, et 13 reproches qui deviennent 0
    // parce qu'on a dit au contrôle sur quoi il porte.
    const out = run("grid");
    expect(out.templateConformance?.state).toBe("not_applicable");
    expect(templateLocators(out)).toEqual([]);
    // Ni finding NI « contrôle conforme » : un OK afficherait une conformité
    // qu'on n'a pas mesurée — l'erreur symétrique, et la plus tranquille des
    // deux, puisqu'elle rassure.
    expect(out.passed.filter((p) => p.ruleId?.startsWith("template-"))).toEqual([]);
  });

  it("TROISIÈME ÉTAT — famille absente : un AVEU nommé, pas un « hors périmètre »", () => {
    // « Hors périmètre » affirme quelque chose sur le BRIEF. L'absence de
    // famille dit qu'on n'a pas mesuré. Repliés sur le même résultat visible
    // — zéro finding — ils ne disent pas la même chose, et les confondre
    // fabriquerait un constat à partir d'une DATE D'IMPORT : toute campagne
    // importée avant l'existence du champ porte `briefFamily: undefined`.
    //
    // ÉTAT ANTÉRIEUR, et pourquoi celui-ci vaut mieux : jusqu'au 03/09 midi le
    // champ valait `null` ici. La distinction existait donc, mais elle tenait à
    // l'ABSENCE d'objet — et `checks-code.ts` court-circuitait sur
    // `opts.briefFamily &&`, si bien que la cause `family_unknown` du validateur
    // n'était atteignable par AUCUNE exécution de production. Un état nommé que
    // rien ne peut produire ne vaut pas mieux que le silence qu'il remplace.
    // Le refus est le même ; ce qui change est qu'il s'écrit désormais.
    // (Mesuré à 14:14:42 après le changement, sur la valeur rendue.)
    const out = run(undefined);
    expect(out.templateConformance?.state).toBe("not_applicable");
    if (out.templateConformance?.state !== "not_applicable") return;
    expect(out.templateConformance.cause).toBe("family_unknown");
    expect(templateLocators(out)).toEqual([]);

    // La distinction est portée par une VALEUR, pas par une phrase : c'est la
    // seule forme qui survive à une reformulation du `reason` en anglais.
    const horsPerimetre = run("grid").templateConformance;
    expect(horsPerimetre?.state).toBe("not_applicable");
    if (horsPerimetre?.state !== "not_applicable") return;
    expect(horsPerimetre.cause).toBe("other_family");
    expect(horsPerimetre.cause).not.toBe(out.templateConformance.cause);
  });

  it("le motif du « hors périmètre » nomme la famille qui l'a produit", () => {
    // Sans quoi `grid` et `none` rendraient un refus indistinguable, alors
    // qu'ils ne disent pas la même chose : `grid` est une famille RECONNUE que
    // le template ne gouverne pas ; `none` est le repli du parseur quand il n'a
    // reconnu aucune disposition (brief-grid.ts:255, `emptyTelemetry`).
    const gridReason = run("grid").templateConformance;
    const noneReason = run("none").templateConformance;
    expect(gridReason?.state).toBe("not_applicable");
    expect(noneReason?.state).toBe("not_applicable");
    if (gridReason?.state !== "not_applicable" || noneReason?.state !== "not_applicable") return;
    expect(gridReason.reason).toContain('"grid"');
    expect(gridReason.reason).not.toBe(noneReason.reason);

    // ✅ LE ROUGE ANNONCÉ EST ARRIVÉ, et c'était bien un progrès. Ce test disait
    // jusqu'à 14:57 que `grid` et `none` partageaient la cause `other_family`,
    // en annonçant qu'il rougirait le jour où `none` recevrait la sienne. C'est
    // fait : `none` porte désormais `layout_unreadable`. Le refus ne se lit plus
    // « ce fichier a une autre mise en page » là où la mesure dit « je n'ai pas
    // su le lire ». Re-mesuré sur la valeur à 14:58:24.
    //
    // La distinction est portée par la CAUSE et pas par la phrase : c'est la
    // seule forme qui survive à une reformulation du `reason` en anglais — et
    // `none` ne nomme d'ailleurs plus aucune famille dans sa phrase, il décrit
    // ce que le parseur n'a pas su faire.
    expect(gridReason.cause).toBe("other_family");
    expect(noneReason.cause).toBe("layout_unreadable");
    expect(noneReason.cause).not.toBe(gridReason.cause);
  });

  it("les quatre entrées rendent QUATRE causes distinctes, pas trois plus un repli", () => {
    // Le contrôle qui manquait tant que `none` et `grid` se confondaient : c'est
    // la table entière qui doit être injective, sinon un état se dissout dans un
    // autre sans que rien ne le dise. Mesuré à 14:58:24.
    const cause = (family?: string) => {
      const tc = run(family as Parameters<typeof run>[0]).templateConformance;
      return tc?.state === "not_applicable" ? tc.cause : tc?.state;
    };
    const table = {
      inconnue: cause(undefined),
      grid: cause("grid"),
      none: cause("none"),
      field_value: cause("field_value"),
    };
    expect(table).toEqual({
      inconnue: "family_unknown",
      grid: "other_family",
      none: "layout_unreadable",
      field_value: "deviation",
    });
    // Contrôle positif de l'injectivité, sur une valeur : une implémentation qui
    // rendrait partout la même cause donnerait un objet parfaitement cohérent
    // avec lui-même.
    expect(new Set(Object.values(table)).size).toBe(4);
  });

  it("aucune famille n'éteint le contrôle bloc-par-bloc", () => {
    // Les deux sujets sont indépendants : ici on compare le BRIEF à la SPEC,
    // là l'EMAIL au brief. Si « hors périmètre » éteignait le second, le
    // rapport écrirait « traduction non vérifiée » pour une raison fausse — et
    // trois règles Translation s'éteindraient sans que rien ne le dise.
    for (const family of ["field_value", "grid", "none", undefined] as const) {
      expect(run(family).translationChecked, String(family)).toBe(true);
    }
  });
});

// --- Le PASSAGE : les deux maillons que rien d'autre ne mesure --------------
//
// Ces deux cas lisent du SOURCE, et c'est un choix contraint que j'expose au
// lieu de le taire : la chaîne passe par des handlers de route (`app/api/...`)
// que la suite ne peut pas importer — il n'y a pas de config vitest, donc
// l'alias `@/` des routes ne se résout pas ici, et `runAnalysis` demande un
// pipeline complet. Ce qui est mesuré est donc le TEXTE, pas l'exécution.
//
// La parade au défaut d'un test de texte — un motif qui ne matche plus rien et
// qui passe au vert en n'ayant rien lu — est le contrôle positif joint à chaque
// cas : l'extraction doit d'abord retrouver quelque chose de connu. Une
// réécriture qui casserait le motif rend ce fichier ROUGE, pas silencieux.

describe("le passage de briefFamily, d'un bout à l'autre", () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, "..", "..", ...parts), "utf8");

  it("analyze.ts passe la famille à runCodeChecks", () => {
    // Le maillon sans lequel tout le reste de ce fichier ne mesure qu'une
    // fonction jamais appelée ainsi en production. `runCodeChecks` honore la
    // famille (cas ci-dessus) ; encore faut-il que quelqu'un la lui donne.
    const src = read("lib", "analyze.ts");
    const start = src.indexOf("const codeCheckOpts = {");
    expect(start, "l'objet d'options a été renommé — ce test ne lit plus rien").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n  };", start));
    // Contrôle positif de l'extraction : un champ dont on sait qu'il y est.
    expect(block).toContain("briefGrid:");
    expect(block).toContain("briefFamily:");
  });

  it("la famille « none » est PRODUITE par le parseur, pas écrite par la route", async () => {
    // Le premier maillon du seul producteur connu de l'état `layout_unreadable`.
    // E a eu raison de se méfier d'une cause qu'aucune exécution n'atteindrait —
    // ce serait le défaut que C venait de corriger, un cran plus loin. Elle est
    // atteignable, mais par un chemin que la description qu'on m'en a faite
    // n'énonce pas : on m'a dit « la route stocke briefFamily = "none" quand le
    // parseur échoue ». Ouvert avant de l'affirmer, la route écrit
    // `c.briefFamily = telemetry?.family`, et son commentaire REFUSE
    // explicitement d'écrire "none" elle-même. Le "none" vient d'ailleurs :
    // `emptyTelemetry()` initialise le champ AVANT toute lecture, et le parseur
    // rend cette valeur initiale telle quelle quand il n'a rien su lire.
    //
    // Mesuré en EXÉCUTION le 03/09 à 15:09:59, sur deux entrées qui n'ont en
    // commun que d'être illisibles.
    const { parseBriefGridDetailed } = await import("../brief-grid");
    const pasUnClasseur = await parseBriefGridDetailed(Buffer.from("ceci n'est pas un classeur"));
    const vide = await parseBriefGridDetailed(Buffer.alloc(0));
    expect(pasUnClasseur.grid).toBeNull();
    expect(pasUnClasseur.telemetry.family).toBe("none");
    expect(vide.telemetry.family).toBe("none");

    // Ce que ça implique et qui vaut d'être écrit : la valeur ne survit pas à un
    // changement de `emptyTelemetry`. Si son initialisation passait un jour à
    // `undefined` — ce qui serait défendable, "none" étant une famille
    // RECONNUE — la cause `layout_unreadable` deviendrait inatteignable sans
    // que rien d'autre ne bouge. C'est la seconde porte, et ce cas la garde.
  });

  it("le scout remplit la GRILLE sans toucher la FAMILLE — le couple est fortuit", () => {
    // Second maillon. La campagne finit avec une grille NON NULLE et la famille
    // "none" : la route a écrit la famille du parseur raté, puis le scout LLM a
    // posé une grille par-dessus sans revenir sur la famille. C'est ce couple —
    // et lui seul — qui fait arriver `validateAgainstTemplate` avec une grille à
    // juger et `family: "none"`, donc `layout_unreadable`.
    //
    // Personne n'a VOULU ce couple : il tient à une omission. Un nettoyage qui
    // poserait la famille au passage — geste raisonnable, qu'un relecteur
    // approuverait — rendrait la branche morte, et le seul signe en serait un
    // écran qui cesse d'avouer. D'où cette garde, qui rougit sur l'omission
    // réparée au lieu de la laisser passer pour une amélioration.
    //
    // Instrument plus faible que le précédent, et je le déclare : c'est une
    // lecture de SOURCE, pas une exécution. La mutation à surveiller étant
    // elle-même une modification du source, c'est l'instrument qui correspond ;
    // il ne dit rien de ce que le code REND.
    const src = read("lib", "brief-scout-job.ts");
    const start = src.indexOf("if (!fresh.briefGrid) {");
    expect(start, "le bloc d'auto-application du scout a changé de forme — ce test ne lit plus rien").toBeGreaterThan(-1);
    const bloc = src.slice(start, src.indexOf("\n      } else {", start));
    // Contrôles positifs : l'extraction a bien attrapé les deux écritures
    // qu'on sait présentes. Sans eux, une fenêtre vide rendrait le `not` vert.
    expect(bloc).toContain("fresh.briefGrid = res.grid");
    expect(bloc).toContain("fresh.expectedLanguages");
    expect(bloc).not.toContain("briefFamily");
  });

  it("briefFamily n'est PAS modifiable par le PATCH de campagne", () => {
    // Le champ vit sur la Campagne et non dans `briefGrid` — et c'est délibéré :
    // `briefGrid` est dans la liste blanche du PATCH, donc éditable depuis le
    // navigateur, et il a trois écrivains dont deux sans télémétrie. Le jour où
    // quelqu'un « range » briefFamily dans la grille, ou l'ajoute à cette
    // liste, la famille devient une donnée que l'écran peut poser — et le
    // périmètre du template se choisit à la souris. Un commentaire ne l'aurait
    // pas empêché ; celui-ci rougit.
    const src = read("app", "api", "campaigns", "[id]", "route.ts");
    const m = /const allowed = \[([\s\S]*?)\] as const;/.exec(src);
    expect(m, "la liste blanche du PATCH a changé de forme — ce test ne lit plus rien").not.toBeNull();
    const allowed = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    // Contrôle positif : l'extraction a bien lu une liste, et la bonne.
    expect(allowed).toContain("briefGrid");
    expect(allowed).toContain("name");
    expect(allowed).not.toContain("briefFamily");
  });
});
