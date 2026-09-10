// Conformance du template mesurée sur les 5 FICHIERS RÉELS du dépôt
// (lib/__tests__/fixtures — données client, cf. README, ne pas publier).
//
// Ce fichier a une fonction précise et une seule : empêcher que le référentiel
// rende un VERDICT là où il n'a pas de SUJET. Il ne juge aucun contenu rédigé.
//
// Il est écrit à partir de ce qui a été MESURÉ sur les cinq fichiers, pas de ce
// qu'on attendait d'eux — et la mesure a corrigé trois choses que la lecture
// avait laissé passer (voir les commentaires de chaque cas). Un test écrit
// depuis l'intention aurait confirmé l'intention.
//
// La répartition observée, qui est le vrai résultat :
//   amq-grid            → not_applicable  (autre famille)
//   bal-newsletter-grid → not_applicable  (autre famille)
//   bal-stj-fieldvalue  → not_applicable  (même famille, AUTRE CANAL)
//   blank-template      → conformant      (contrôle positif)
//   mx-guadalajara      → deviation       (le seul écart réel, et il est nommé)
//
// Trois « hors spec » pour un seul écart : c'est le rapport attendu d'un
// référentiel de MESURE. Un instrument qui trouverait un écart partout serait
// suspect avant d'être utile.

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseBriefGridDetailed } from "../brief-grid";
import { DEFAULT_TEMPLATE, templateRevision, validateAgainstTemplate } from "../brief-template";
import { buildStoredTemplate, checkTemplateCoherence } from "../template-edit";
import type { BriefTemplate, TemplateConformance } from "../brief-template";
import { runCodeChecks } from "../checks-code";
import { parseEmailFacts } from "../parse-email";
import { emptyRuleConfig, resolveRuleConfig, type ResolvedRuleConfig } from "../rule-config";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name));

/** Parse + valide, comme le fera lib/checks-code.ts. La télémétrie est passée :
 *  sans elle, « écart » et « hors périmètre » deviennent indistinguables. */
async function conformanceOf(name: string): Promise<TemplateConformance> {
  const { grid, telemetry } = await parseBriefGridDetailed(fixture(name));
  expect(grid, `${name} : le parseur ne rend aucune grille`).not.toBeNull();
  return validateAgainstTemplate(grid!, DEFAULT_TEMPLATE, { family: telemetry.family });
}

describe("conformance au template sur les 5 briefs réels", () => {
  // ── Le seul écart réel du corpus ───────────────────────────────────────────

  it("MX Guadalajara : un écart NOMMÉ, pas un score", async () => {
    const res = await conformanceOf("mx-guadalajara.xlsm");
    expect(res.state).toBe("deviation");
    if (res.state !== "deviation") return;

    // 7 champs sur 14 reconnus. Ce n'est PAS un brief bâclé : c'est un brief
    // mono-marché à un seul CTA, et le template décrit une campagne à deux.
    //
    // Ce chiffre valait 5 avant l'arbitrage de fusion, et le 5 décrivait un
    // DÉFAUT, pas une propriété du brief : "Hero Asset URL" et "CTA 1 URL"
    // étaient comptés manquants alors que leur URL est écrite dans le fichier.
    expect(res.matched).toBe(7);

    // Les manques sont énumérés, jamais résumés en un chiffre : « 6 écarts » ne
    // se relit pas, cette liste-ci se relit. Deux natures distinctes s'y
    // mélangent, et c'est l'information utile :
    //  - Body Copy 2 / CTA 2 Label : la campagne n'a qu'un bloc et un CTA. Un
    //    métier peut décider que ces champs ne sont pas requis — le template
    //    est éditable, c'est exactement à ça que sert `required`.
    //  - les URLs : Packshots et CTA 2 sont réellement absents du fichier.
    //
    // CONTRÔLE NÉGATIF, et c'est le point de la liste : "CTA 2 URL - WOMEN" et
    // "CTA 2 URL - MEN" doivent RESTER là. Le remède écarté — découper le
    // libellé fusionné sur "/" — les aurait fait disparaître, parce que la
    // moitié "CTA URL" se normalise en "cta" et s'apparie par préfixe à ces
    // deux champs-là. Il aurait supprimé trois faux reproches en masquant deux
    // absences vraies : une liste qui raccourcit n'est pas une liste qui
    // s'améliore.
    expect(res.missing.map((m) => m.label)).toEqual([
      "Body Copy 2",
      "CTA 2 Label",
      "Packshots 1 URL",
      "Packshots 2 URL",
      "CTA 2 URL - WOMEN",
      "CTA 2 URL - MEN",
    ]);

    // Plus rien en trop : le libellé du brief est reconnu, il ne lui est plus
    // reproché d'exister.
    expect(res.extra).toEqual([]);

    // Mais la fusion n'est pas absorbée pour autant. Deux champs que le
    // template déclare séparément tombent sur UNE cellule ; c'est dit, avec les
    // deux clés, parce qu'une valeur unique ne peut pas attester deux contenus
    // distincts. Sans cette ligne, l'alias aurait échangé un faux reproche
    // contre un silence — le même défaut dans l'autre sens.
    //
    // Les deux premières entrées sont la réduction MIROIR, et elles ne sont pas
    // une régression : elles étaient déjà là, muettes. « Subject Line (female) »
    // et « Subject Line (male & others) » sont deux LIGNES du brief que
    // `normLabel` ramène à « subject line » ; la lecture gardait la dernière, et
    // le verdict dépendait donc de l'ordre des lignes du classeur. Le brief de
    // Guadalajara distingue deux genres sur le sujet ET sur le titre : quatre
    // lignes réellement écrites, deux valeurs mesurées, aucune trace.
    expect(res.sharedCells).toEqual([
      {
        label: "Subject Line (male & others)",
        keys: ["subject-line"],
        sources: ["Subject Line (male & others)", "Subject Line (female)"],
      },
      {
        label: "Headline (male & others)",
        keys: ["headline"],
        sources: ["Headline (male & others)", "Headline (female)"],
      },
      { label: "Hero Asset / CTA URL", keys: ["hero-asset-url", "cta-1-url"] },
    ]);
  });

  it("MX Guadalajara : le verdict ne dépend PAS de l'ordre des lignes", async () => {
    // Le contrôle qui manquait. Tant que la lecture gardait la dernière ligne
    // d'un groupe fusionné, inverser deux lignes du classeur changeait la valeur
    // retenue — donc, si l'une des deux était vide, le verdict. Un test qui lit
    // le fichier dans son ordre naturel ne peut pas voir cela : il mesure UN
    // ordre et le prend pour la mesure.
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("mx-guadalajara.xlsm"));
    expect(grid).not.toBeNull();
    const inverse = { ...grid!, blocks: [...grid!.blocks].reverse() };
    const opts = { family: telemetry.family };
    const a = validateAgainstTemplate(grid!, DEFAULT_TEMPLATE, opts);
    const b = validateAgainstTemplate(inverse, DEFAULT_TEMPLATE, opts);
    if (a.state !== "deviation" || b.state !== "deviation") throw new Error("état inattendu");
    expect(b.missing.map((m) => m.label)).toEqual(a.missing.map((m) => m.label));
    expect(b.untranslated).toEqual(a.untranslated);
    expect(b.matched).toBe(a.matched);
    // Contrôle positif : l'inversion a bien eu lieu et porte sur des lignes qui
    // FUSIONNENT — sans quoi l'égalité ci-dessus serait vraie sans rien prouver.
    expect(a.sharedCells.some((s) => (s.sources?.length ?? 0) > 1)).toBe(true);
    expect(inverse.blocks[0].name).not.toBe(grid!.blocks[0].name);
  });

  // ── Les trois « hors spec », par trois raisons DIFFÉRENTES ─────────────────

  it("McQueen : autre famille ⟹ hors spec, et le brief reste analysé", async () => {
    const res = await conformanceOf("amq-grid.xlsx");
    expect(res.state).toBe("not_applicable");
    if (res.state !== "not_applicable") return;
    // Le motif est destiné à être AFFICHÉ. « not_applicable » sans phrase se
    // lirait comme une panne ; ici le métier lit pourquoi rien n'est jugé.
    expect(res.reason).toMatch(/grid/);
  });

  it("Balenciaga newsletter : autre famille aussi — la famille n'est pas propre à McQueen", async () => {
    // Deux marques différentes dans la même famille `grid`. C'est ce qui
    // interdit de traiter `grid` comme « le format McQueen » : figer le
    // template sur field_value retirerait aussi des briefs Balenciaga.
    const res = await conformanceOf("bal-newsletter-grid.xlsx");
    expect(res.state).toBe("not_applicable");
  });

  it("Balenciaga STJ : MÊME famille, autre canal ⟹ hors spec quand même", async () => {
    // Le cas le plus instructif du corpus, et celui que le tri par famille
    // laissait passer. Ce brief est bien `field_value` ; le classeur Kering
    // concatène ses canaux dans "Campaign Brief" et la première section de
    // celui-ci est TASK. Le template décrit EMAIL : il n'a rien à en dire.
    const res = await conformanceOf("bal-stj-fieldvalue.xlsm");
    expect(res.state).toBe("not_applicable");
    if (res.state !== "not_applicable") return;
    expect(res.reason).toMatch(/EMAIL/);
  });

  // ── Contrôle positif ───────────────────────────────────────────────────────

  it("contrôle positif : le classeur vierge officiel est conforme", async () => {
    // Sans ce cas, les quatre précédents seraient satisfaits par un validateur
    // qui ne rend JAMAIS "conformant" — trois `not_applicable` et un
    // `deviation` sont exactement ce que produirait un instrument cassé.
    const res = await conformanceOf("blank-template.xlsm");
    expect(res.state).toBe("conformant");
    if (res.state !== "conformant") return;
    // 14 = les 15 champs déclarés moins `mock-up`, qui est du kind `meta` et
    // n'entre donc pas dans la comparaison de structure.
    expect(res.matched).toBe(DEFAULT_TEMPLATE.fields.filter((f) => f.kind !== "meta").length);
  });

  // ── Garde sur l'usage, pas sur le résultat ────────────────────────────────

  it("sans `family`, la fonction REFUSE de mesurer — et dit qu'elle n'a pas mesuré", async () => {
    // Ce test mesurait auparavant l'inverse : sans `family`, bal-newsletter
    // rendait un `deviation` circonstancié (3 reconnus, 10 requis manquants)
    // sur un brief que le template ne gouverne pas. La démonstration a servi —
    // c'est elle qui a fait fermer le chemin aveugle — et elle n'est plus
    // reproductible, parce que le défaut qu'elle décrivait n'existe plus.
    //
    // Ce qu'elle garde maintenant : la fermeture, ET le MOTIF. Une famille
    // absente est l'état de toute campagne importée avant que `briefFamily`
    // n'existe ; la replier sur « autre famille » rendrait la même valeur avec
    // un sens faux — un constat fabriqué à partir d'une date d'import.
    const bal = await parseBriefGridDetailed(fixture("bal-newsletter-grid.xlsx"));
    const blind = validateAgainstTemplate(bal.grid!, DEFAULT_TEMPLATE, {});
    expect(blind.state).toBe("not_applicable");
    if (blind.state !== "not_applicable") return;
    expect(blind.cause).toBe("family_unknown");

    // CONTRÔLE NÉGATIF du motif : le MÊME brief, famille connue, rend le même
    // état pour une raison DIFFÉRENTE. Sans ce cas, `cause` pourrait être une
    // constante et le test passerait quand même.
    const known = validateAgainstTemplate(bal.grid!, DEFAULT_TEMPLATE, { family: bal.telemetry.family });
    expect(known.state).toBe("not_applicable");
    if (known.state !== "not_applicable") return;
    expect(known.cause).toBe("other_family");
  });

  it("`none` n'est pas une famille : le repli du parseur reste un AVEU", async () => {
    // `none` n'est pas une mise en page reconnue, c'est la valeur INITIALE de la
    // télémétrie (`emptyTelemetry`, brief-grid.ts:255, posée à :463) — ce qui
    // reste quand aucun format n'a été lu. Le ranger sous `other_family` faisait
    // écrire « ce fichier a une AUTRE mise en page », un constat, là où la seule
    // chose mesurée est « je n'ai rien su lire », un aveu. Les deux ne se lisent
    // pas pareil : un constat clôt la question, un aveu la garde ouverte.
    //
    // La combinaison testée ici n'est pas une hypothèse de laboratoire, elle est
    // ATTEIGNABLE en production et c'est la seule raison d'écrire ce cas :
    // quand le parseur déterministe échoue (grid `null`, famille `none`), la
    // route stocke bien `briefFamily = "none"` (route brief :149), puis le scout
    // LLM remplit la grille en arrière-plan — `fresh.briefGrid = res.grid`,
    // brief-scout-job.ts:32-34 — SANS jamais toucher à `briefFamily`. La
    // campagne porte alors une grille non nulle et la famille `none`, et
    // checks-code.ts appelle le validateur avec exactement ce couple.
    //
    // C'est le cas où la distinction compte le plus : la grille a été
    // reconstruite par un modèle, aucun parseur ne l'a lue. La présenter comme
    // « autre mise en page » affirmerait une lecture qui n'a pas eu lieu.
    const bal = await parseBriefGridDetailed(fixture("bal-newsletter-grid.xlsx"));
    const unread = validateAgainstTemplate(bal.grid!, DEFAULT_TEMPLATE, { family: "none" });
    expect(unread.state).toBe("not_applicable");
    if (unread.state !== "not_applicable") return;
    expect(unread.cause).toBe("layout_unreadable");

    // CONTRÔLE NÉGATIF, et il porte sur le point exact du défaut : la MÊME
    // grille, avec la famille que le parseur lui a réellement donnée, doit
    // rendre l'autre cause. Sans lui, `layout_unreadable` pourrait être une
    // constante et le test passerait.
    expect(bal.telemetry.family).toBe("grid");
    const other = validateAgainstTemplate(bal.grid!, DEFAULT_TEMPLATE, { family: bal.telemetry.family });
    expect(other.state).toBe("not_applicable");
    if (other.state !== "not_applicable") return;
    expect(other.cause).toBe("other_family");

    // Et les deux AVEUX ne se confondent pas non plus : `family_unknown` dit
    // « j'ignore si ces règles s'appliquaient » (campagne antérieure à la mesure
    // de famille, cela se résorbe au prochain import), `layout_unreadable` dit
    // « je n'ai rien su lire de ce fichier » (cela ne se résorbe pas tout seul).
    // Le lead les veut comptables séparément : la garde le vérifie sur la
    // VALEUR, sinon la distinction ne vivrait que dans le `reason` anglais.
    const blind = validateAgainstTemplate(bal.grid!, DEFAULT_TEMPLATE, {});
    if (blind.state !== "not_applicable") return;
    expect(blind.cause).toBe("family_unknown");
    expect(blind.cause).not.toBe(unread.cause);

    // La phrase ne doit pas nommer une mise en page qui n'existe pas. C'est ce
    // que l'ancien repli écrivait : `Brief layout "none" is outside…`.
    expect(unread.reason).not.toContain('"none"');
  });

  it("les deux gardes ne se remplacent pas : la famille ne suffit pas", async () => {
    // Quatre causes rendent `not_applicable`, et elles ne sont pas redondantes.
    //
    // McQueen est rattrapé DEUX fois : famille `grid`, et des libellés ("sl",
    // "ph", "body") qui ne s'apparient à rien. La seconde protection est de la
    // CHANCE — elle tient à ce que cette marque abrège ses libellés — donc on
    // ne peut pas s'y fier.
    const mcq = await parseBriefGridDetailed(fixture("amq-grid.xlsx"));
    const byFamily = validateAgainstTemplate(mcq.grid!, DEFAULT_TEMPLATE, { family: mcq.telemetry.family });
    expect(byFamily.state).toBe("not_applicable");
    if (byFamily.state !== "not_applicable") return;
    expect(byFamily.cause).toBe("other_family");

    // bal-stj est le cas que SEULE la seconde garde attrape : bonne famille
    // (`field_value`), mais sa première section est le canal TASK. Le tri par
    // famille le laisse passer ; sans l'ancrage il rendrait 13 requis
    // « manquants » sur un brief de production valide.
    const stj = await parseBriefGridDetailed(fixture("bal-stj-fieldvalue.xlsm"));
    expect(stj.telemetry.family).toBe("field_value");
    const byAnchor = validateAgainstTemplate(stj.grid!, DEFAULT_TEMPLATE, { family: stj.telemetry.family });
    expect(byAnchor.state).toBe("not_applicable");
    if (byAnchor.state !== "not_applicable") return;
    expect(byAnchor.cause).toBe("no_field_matched");
  });
});

// Une entrée de catalogue et un contrôle qui TOURNE sont deux choses
// différentes — c'est la raison d'être de la garde de checks-code-config.test.ts
// (« une règle affichée mais jamais posée sur un finding serait un interrupteur
// qui n'allume rien »). Elle vérifie qu'un `section("id")` existe dans le
// source ; elle ne vérifie pas qu'il produise quoi que ce soit. Ces cas-ci
// mesurent la sortie.
describe("les règles template sont réellement exécutées par runCodeChecks", () => {
  const emailOf = (html: string) => parseEmailFacts(html);

  it("avec la famille : les findings portent les ruleId du catalogue", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("mx-guadalajara.xlsm"));
    const out = runCodeChecks({
      facts: emailOf("<html><body><p>Hola</p></body></html>"),
      linkResults: [],
      briefGrid: grid,
      briefFamily: telemetry.family,
      detectedLanguage: { lang: "ES", confidence: "high" },
    });

    expect(out.templateConformance?.state).toBe("deviation");
    const ids = new Set(out.findings.map((f) => f.ruleId));
    expect(ids.has("template-structure")).toBe(true);
    // Les deux signalements d'INSTRUMENT se taisent sur ce brief, et c'est le
    // verdict juste depuis le 2026-09-04 : ES/MX ne se confondent plus (la clé
    // de colonne est le CODE DÉCLARÉ, pas la langue) et TH est au catalogue.
    // Ils étaient tous deux attendus VRAIS ici — sur ce même fixture, sans
    // qu'aucune de ces deux lignes ne change. Ce qui a changé est mesuré à côté.
    expect(ids.has("template-language-ambiguous")).toBe(false);
    expect(ids.has("template-language-unsupported")).toBe(false);
  });

  it("les deux règles d'INSTRUMENT tournent toujours — sur un template qui les déclenche", async () => {
    // Sans ce cas, les deux `expect(...).toBe(false)` ci-dessus seraient
    // exactement ce que rendrait un `section()` supprimé, une sévérité éteinte ou
    // un `if` inversé. Le silence d'une règle réparée et le silence d'une règle
    // débranchée s'écrivent pareil : il faut la faire parler pour les séparer.
    //
    // C'est aussi le cas RÉEL de demain, et non un montage de laboratoire — les
    // templates sont éditables : quelqu'un peut déclarer "JA" à côté de "JP"
    // (même colonne interne) ou "SV" (aucun catalogue), et il doit l'apprendre
    // par ces deux findings et non par une colonne qui s'évapore.
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("mx-guadalajara.xlsm"));
    const out = runCodeChecks({
      facts: emailOf("<html><body><p>Hola</p></body></html>"),
      linkResults: [],
      // La grille du fixture n'active que MX ; l'ambiguïté ne se signale que sur
      // les langues EN JEU, donc on active aussi la clé en collision.
      briefGrid: { ...grid!, languages: [...grid!.languages, "JA"] },
      briefFamily: telemetry.family,
      detectedLanguage: { lang: "ES", confidence: "high" },
      template: { ...DEFAULT_TEMPLATE, languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "JA", "SV"] },
    });

    expect(out.templateConformance?.state).toBe("deviation");
    const ids = new Set(out.findings.map((f) => f.ruleId));
    expect(ids.has("template-language-ambiguous")).toBe(true);
    expect(ids.has("template-language-unsupported")).toBe(true);
    // Et chacun NOMME ce qu'il n'a pas su mesurer : un aveu qui ne dit pas sur
    // quoi il porte renvoie le métier à une relecture intégrale du brief.
    const ambigu = out.findings.find((f) => f.ruleId === "template-language-ambiguous");
    const inconnu = out.findings.find((f) => f.ruleId === "template-language-unsupported");
    expect(ambigu?.message).toContain("JP, JA");
    expect(inconnu?.message).toContain("SV");
  });

  it("sans la famille : le contrôle ne tourne PAS, et le dit", async () => {
    const { grid } = await parseBriefGridDetailed(fixture("mx-guadalajara.xlsm"));
    const out = runCodeChecks({
      facts: emailOf("<html><body><p>Hola</p></body></html>"),
      linkResults: [],
      briefGrid: grid,
      detectedLanguage: { lang: "ES", confidence: "high" },
    });
    // Le contrôle est bien APPELÉ — c'est le validateur qui refuse, et son
    // refus s'écrit. Une version antérieure de ce test attendait `null`, hérité
    // du temps où checks-code.ts court-circuitait sur `opts.briefFamily &&` :
    // la cause `family_unknown` était alors inatteignable depuis le seul chemin
    // de production, donc jamais affichable. `null` et `not_applicable` rendent
    // le même écran vide mais ne disent pas la même chose — l'un est « ce
    // contrôle n'a pas eu lieu », l'autre « il a eu lieu et a refusé de
    // conclure, voici pourquoi ».
    expect(out.templateConformance?.state).toBe("not_applicable");
    if (out.templateConformance?.state === "not_applicable") {
      // Distingué par une VALEUR, pas par une phrase : `reason` change au
      // premier reformulage, `cause` non.
      expect(out.templateConformance.cause).toBe("family_unknown");
    }
    // Refuser de mesurer n'autorise à écrire ni reproche ni « contrôle passé ».
    expect(out.findings.some((f) => f.ruleId?.startsWith("template-"))).toBe(false);
    expect(out.passed.some((p) => p.ruleId?.startsWith("template-"))).toBe(false);
  });

  it("le curseur de `template-structure` ne déplace PAS la cellule fusionnée", async () => {
    // GARDE EXÉCUTABLE d'une décision de référentiel, pas du rangement.
    //
    // Mesuré par A : l'override de sévérité est par ID, le défaut passé à
    // `cfg.severity(id, fallback)` est par APPEL. Tant que les deux
    // signalements sortaient sous `template-structure`, MINEUR et MAJEUR ne
    // tenaient que par l'inaction : un cran de curseur vers CRITIQUE promouvait
    // une cellule fusionnée au rang d'un champ absent, un cran vers MINEUR
    // rétrogradait en silence les vrais défauts de structure. Les deux
    // fabriquent un faux et le second est muet.
    //
    // Sans ce test, l'id distinct est une convention. Une convention ne se
    // mesure pas, et c'est exactement la faute que je reproche ailleurs :
    // l'étiquette écrite avant l'appel.
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("mx-guadalajara.xlsm"));
    const run = (config?: ResolvedRuleConfig) =>
      runCodeChecks({
        facts: emailOf("<html><body><p>Hola</p></body></html>"),
        linkResults: [],
        briefGrid: grid,
        briefFamily: telemetry.family,
        detectedLanguage: { lang: "ES", confidence: "high" },
        config,
      });

    const sevOf = (out: ReturnType<typeof run>, ruleId: string) =>
      out.findings.filter((f) => f.ruleId === ruleId).map((f) => f.severite);

    // CONTRÔLE POSITIF de l'instrument : sans réglage, les deux règles sortent
    // bien, à des niveaux différents. Un test dont les deux listes seraient
    // vides passerait pour la mauvaise raison.
    const plain = run();
    // TROIS signalements, pas un : la cellule « Hero Asset / CTA URL » qui porte
    // deux champs du template, plus les deux réductions MIROIR du brief
    // (sujet et titre, chacun en deux lignes de genre). Le nombre est écrit ici
    // plutôt qu'assoupli en `.every(...)` : une liste qui rétrécirait sans
    // qu'on le veuille repasserait sinon au vert.
    expect(sevOf(plain, "template-field-shared-cell")).toEqual(["MINEUR", "MINEUR", "MINEUR"]);
    expect(sevOf(plain, "template-structure").length).toBeGreaterThan(0);
    expect(new Set(sevOf(plain, "template-structure"))).toEqual(new Set(["MAJEUR"]));

    // Le curseur poussé au maximum sur les champs manquants. Il DOIT emporter
    // `template-structure` — sinon c'est le réglage d'Alina qui serait cassé,
    // et ce test célébrerait une régression.
    const raised = run(
      resolveRuleConfig({
        ...emptyRuleConfig(),
        overrides: { "template-structure": { severity: "CRITIQUE" } },
      })
    );
    expect(new Set(sevOf(raised, "template-structure"))).toEqual(new Set(["CRITIQUE"]));
    // Et il ne DOIT PAS emporter la cellule fusionnée.
    expect(sevOf(raised, "template-field-shared-cell")).toEqual(["MINEUR", "MINEUR", "MINEUR"]);
  });

  it("McQueen : le contrôle tourne, ne juge rien, et n'éteint pas le contrôle §4", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("amq-grid.xlsx"));
    const out = runCodeChecks({
      facts: emailOf("<html><body><p>hello</p></body></html>"),
      linkResults: [],
      briefGrid: grid,
      briefFamily: telemetry.family,
      detectedLanguage: { lang: "EN", confidence: "high" },
    });
    // Hors spec : aucun finding de template, et aucun « contrôle passé » non
    // plus — un OK afficherait une conformité jamais mesurée.
    expect(out.templateConformance?.state).toBe("not_applicable");
    expect(out.findings.some((f) => f.ruleId?.startsWith("template-"))).toBe(false);
    expect(out.passed.some((p) => p.ruleId?.startsWith("template-"))).toBe(false);
    // Et le contrôle bloc-par-bloc, lui, a bien tourné : les deux sujets sont
    // indépendants. Si `not_applicable` l'éteignait, le rapport dirait
    // « traduction non vérifiée » pour une raison fausse.
    expect(out.translationChecked).toBe(true);
  });
});

// ── La RÉVISION du référentiel ───────────────────────────────────────────────
//
// `version` est un ordinal posé à la main ; `templateRevision()` est une
// empreinte dérivée de la déclaration. Tant que le template n'était modifiable
// qu'en éditant brief-template.ts, l'oubli d'incrémenter se voyait à la
// relecture. Avec l'édition par l'UI, plus personne n'incrémente — et une clé
// qui ne bouge pas pendant que le référentiel bouge sert des rapports en cache
// comme s'ils avaient été jugés par le nouveau template, SANS lever d'erreur.
describe("templateRevision — la clé technique suit la déclaration", () => {
  const tpl = DEFAULT_TEMPLATE;

  it("est stable, et distincte de l'ordinal affiché", () => {
    // Reproductible : deux appels sur deux objets ÉGAUX mais distincts doivent
    // rendre la même chose. `{ ...tpl }` casse volontairement la mémoïsation par
    // identité — sinon on ne testerait que la WeakMap.
    expect(templateRevision({ ...tpl })).toBe(templateRevision({ ...tpl }));
    expect(templateRevision(tpl)).toMatch(/^[0-9a-f]{12}$/);

    // Et ce n'est PAS l'ordinal déguisé : le libellé « v1 » ne doit pas suffire
    // à retrouver la clé, sinon la séparation des deux n'existe que dans les
    // noms de variables.
    expect(templateRevision(tpl)).not.toBe(String(tpl.version));
  });

  it("le COSMÉTIQUE n'invalide rien, la DÉCLARATION invalide tout", () => {
    const base = templateRevision(tpl);

    // Ce qui ne doit RIEN changer : corriger une faute dans le libellé affiché
    // ou redater le référentiel n'a jamais changé un verdict. Si ces champs
    // entraient dans l'empreinte, la révision mesurerait l'activité d'édition
    // au lieu de mesurer le référentiel, et chaque sauvegarde purgerait le cache.
    // Typés `BriefTemplate` et non passés en littéral : `templateRevision` prend
    // un `BriefTemplateData`, et un littéral portant `label`/`version` y serait
    // refusé par le contrôle de propriétés excédentaires. Ce refus est correct —
    // il dit que ces champs ne font pas partie de la déclaration — mais ici on
    // veut justement vérifier qu'ils n'ont AUCUN effet quand ils sont présents.
    const cosmetiques: readonly BriefTemplate[] = [
      { ...tpl, label: "Autre libellé" },
      { ...tpl, version: 99 },
      { ...tpl, updatedAt: "2027-01-01T00:00:00.000Z" },
    ];
    for (const c of cosmetiques) expect(templateRevision(c)).toBe(base);

    // Ce qui doit TOUT changer. Chaque cas est une façon réelle de fausser un
    // verdict, et chacun est vérifié séparément : un test qui n'en garderait
    // qu'un passerait alors que les autres champs auraient été oubliés du hachage.
    const f0 = tpl.fields[0];
    const mut: Array<[string, BriefTemplate]> = [
      // Politique : rend un champ facultatif — supprime des « champ manquant ».
      ["required", { ...tpl, fields: [{ ...f0, required: !f0.required }, ...tpl.fields.slice(1)] }],
      // Politique : décide si les traductions sont exigées sur ce champ.
      ["translatable", { ...tpl, fields: [{ ...f0, translatable: !f0.translatable }, ...tpl.fields.slice(1)] }],
      // Appariement : le libellé attendu en colonne FIELD.
      ["label", { ...tpl, fields: [{ ...f0, label: `${f0.label} (edited)` }, ...tpl.fields.slice(1)] }],
      // Appariement : un alias fait répondre un libellé de plus.
      ["aliases", { ...tpl, fields: [{ ...f0, aliases: ["Zzz Alias"] }, ...tpl.fields.slice(1)] }],
      // Nature : url/text/meta décide si le champ devient un lien attendu.
      ["kind", { ...tpl, fields: [{ ...f0, kind: f0.kind === "url" ? "text" : "url" }, ...tpl.fields.slice(1)] }],
      // ADRESSE de la cellule : c'est `rowOffset` qui la fixe, PAS le rang du
      // champ dans la liste — le vierge laisse une ligne vide avant "Mock Up".
      // Ce cas est celui qu'une première version du hachage laissait passer.
      ["rowOffset", { ...tpl, fields: [{ ...f0, rowOffset: f0.rowOffset + 1 }, ...tpl.fields.slice(1)] }],
      // Géométrie de la feuille : déplace toutes les adresses d'un coup.
      ["headerRow", { ...tpl, headerRow: tpl.headerRow + 1 }],
      ["firstLangCol", { ...tpl, firstLangCol: tpl.firstLangCol + 1 }],
      // Couverture : retirer une langue retire des contrôles de traduction.
      ["languageColumns", { ...tpl, languageColumns: tpl.languageColumns.slice(1) }],
      // Un champ en moins, c'est un requis qui cesse d'être exigé.
      ["fields", { ...tpl, fields: tpl.fields.slice(1) }],
      // GLOSSAIRE — il part dans le prompt de chaque agent (lib/glossary.ts).
      // Une phrase ajoutée change ce qui est demandé au modèle, donc peut
      // changer un verdict ; hors empreinte, elle ferait resservir en cache des
      // rapports jugés SANS elle pendant que l'écran affiche la nouvelle.
      ["glossary", { ...tpl, glossary: `${tpl.glossary ?? ""}\nUne phrase de plus.` }],
      ["note de champ", { ...tpl, fields: [{ ...f0, note: "Ce champ tolère l'absence de ponctuation finale." }, ...tpl.fields.slice(1)] }],
      ["note de langue", { ...tpl, languages: [{ ...tpl.languages[0], note: "Marché à part." }, ...tpl.languages.slice(1)] }],
    ];
    for (const [nom, edited] of mut) {
      expect(templateRevision(edited), `« ${nom} » ne déplace pas la révision`).not.toBe(base);
    }
  });

  it("la révision couvre TOUTE la déclaration — sinon ce test rougit", () => {
    // Le hachage ÉNUMÈRE ses entrées au lieu de sérialiser l'objet, pour que
    // personne n'y fasse entrer un champ sans le décider. Le revers est qu'un
    // champ de déclaration ajouté demain serait oublié EN SILENCE. Cette garde
    // épingle donc les clés de `BriefTemplateData` : ajouter un champ à
    // l'interface fait rougir ici, et le rouge demande une décision — dans
    // l'empreinte (il peut changer un verdict) ou hors d'elle (cosmétique).
    //
    // On épingle les clés d'une VALEUR, pas la liste écrite dans le commentaire
    // du hachage : une liste recopiée à la main resterait verte le jour où
    // l'interface change.
    const DANS_L_EMPREINTE = [
      "channel", "headerRow", "fieldCol", "descCol", "valueCol", "firstLangCol",
      "languageColumns", "fields",
      // `glossary` : il est RECOPIÉ dans le prompt de chaque agent, donc il
      // peut changer un verdict — la raison la plus directe qu'un champ puisse
      // avoir d'entrer ici (cf. lib/glossary.ts).
      "glossary",
      // `languages` : PAS parce qu'il change un verdict — mesuré le 04/09/2026,
      // il n'en change aucun aujourd'hui (cf. le cas « une liste de langues
      // distincte s'archive à part » plus bas, qui teste la vraie raison :
      // l'empreinte sert de CLÉ D'IDENTITÉ à l'archive).
      "languages",
    ];
    // HORS empreinte, et chacun pour une raison énoncée :
    //  - `source`     : provenance du fichier extrait, jamais un critère de verdict ;
    //  - `preamble`   : lignes d'en-tête décoratives du classeur généré.
    const HORS_EMPREINTE = ["source", "preamble"];

    const observees = Object.keys(DEFAULT_TEMPLATE).filter(
      (k) => !["version", "updatedAt", "updatedBy", "label"].includes(k)
    );
    const classees = new Set([...DANS_L_EMPREINTE, ...HORS_EMPREINTE]);
    const nonClassees = observees.filter((k) => !classees.has(k));
    expect(nonClassees, "champ de déclaration ni haché ni exclu explicitement").toEqual([]);

    // CONTRÔLE POSITIF : la garde doit savoir DÉTECTER un champ non classé,
    // sinon elle passerait aussi sur une liste `observees` vide ou cassée.
    const avecIntrus = [...observees, "champZzzNonClasse"].filter((k) => !classees.has(k));
    expect(avecIntrus).toEqual(["champZzzNonClasse"]);
  });
});

// L'empreinte doit valoir PREUVE : elle atteste quel référentiel a rendu CE
// verdict. Une empreinte recopiée d'une branche à l'autre, ou captée sur un
// autre template en portée, serait pire que pas d'empreinte — elle attesterait
// une lecture qui n'a pas eu lieu.
//
// La branche `deviation` est testée en premier parce que c'est la plus lue :
// c'est elle qui produit l'écart affiché au métier. Si l'empreinte y est fausse,
// le seul moment où ça se verra est six mois plus tard, sur un rapport qu'on ne
// saura plus dater — donc jamais.
describe("templateRevision — l'empreinte suit le template qui a JUGÉ", () => {
  it("la branche `deviation` porte la révision de SON template, pas une constante", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("mx-guadalajara.xlsm"));
    const parDefaut = validateAgainstTemplate(grid!, DEFAULT_TEMPLATE, { family: telemetry.family });
    expect(parDefaut.state).toBe("deviation"); // contrôle positif : on est bien dans la branche visée
    if (parDefaut.state !== "deviation") return;
    expect(parDefaut.templateRevision).toBe(templateRevision(DEFAULT_TEMPLATE));

    // Le MÊME brief jugé par un référentiel DIFFÉRENT doit porter une empreinte
    // différente. Sans ce second tirage, l'assertion ci-dessus passerait aussi
    // si `templateRevision` rendait une constante, ou si la valeur posée sur la
    // branche avait été captée sur `DEFAULT_TEMPLATE` au lieu du `tpl` reçu.
    const edite: BriefTemplate = {
      ...DEFAULT_TEMPLATE,
      fields: DEFAULT_TEMPLATE.fields.map((f, i) => (i === 0 ? { ...f, required: !f.required } : f)),
    };
    const parEdite = validateAgainstTemplate(grid!, edite, { family: telemetry.family });
    // Assertion AVANT le rétrécissement de type. Un `if (… !== "deviation") return`
    // seul est un test qui se DÉSARME : le jour où la mutation ferait basculer le
    // verdict, il sortirait vert sans avoir rien comparé. Le `if` qui suit ne sert
    // qu'à TypeScript, il ne décide plus de rien.
    expect(parEdite.state, "le template muté doit rester dans la branche mesurée").toBe("deviation");
    if (parEdite.state !== "deviation") return;
    expect(parEdite.templateRevision).toBe(templateRevision(edite));
    expect(parEdite.templateRevision).not.toBe(parDefaut.templateRevision);
  });

  it("les trois états portent l'empreinte, pas seulement celui qu'on regarde", async () => {
    // `conformant` et `not_applicable` sont les deux états où l'on est le moins
    // tenté de vérifier quoi que ce soit — donc ceux où une empreinte absente ou
    // figée survivrait le plus longtemps. Un « conforme » qu'on ne sait pas
    // dater est exactement le cas que cette empreinte existe pour éviter.
    const attendue = templateRevision(DEFAULT_TEMPLATE);

    const vierge = await parseBriefGridDetailed(fixture("blank-template.xlsm"));
    const conforme = validateAgainstTemplate(vierge.grid!, DEFAULT_TEMPLATE, {
      family: vierge.telemetry.family,
    });
    expect(conforme.state).toBe("conformant");
    expect(conforme.templateRevision).toBe(attendue);

    // Les quatre causes de `not_applicable`, chacune sortant d'un `return`
    // distinct : c'est une sortie par ligne de code, pas une par état.
    const bal = await parseBriefGridDetailed(fixture("bal-newsletter-grid.xlsx"));
    const stj = await parseBriefGridDetailed(fixture("bal-stj-fieldvalue.xlsm"));
    const sorties: TemplateConformance[] = [
      validateAgainstTemplate(bal.grid!, DEFAULT_TEMPLATE, {}), // family_unknown
      validateAgainstTemplate(bal.grid!, DEFAULT_TEMPLATE, { family: "none" }), // layout_unreadable
      validateAgainstTemplate(bal.grid!, DEFAULT_TEMPLATE, { family: "grid" }), // other_family
      validateAgainstTemplate(stj.grid!, DEFAULT_TEMPLATE, { family: "field_value" }), // no_field_matched
    ];
    const causes = sorties.map((s) => (s.state === "not_applicable" ? s.cause : s.state));
    // Contrôle positif : les quatre sorties sont bien DISTINCTES. Sans lui, le
    // test passerait en mesurant quatre fois la même branche.
    expect(new Set(causes).size).toBe(4);
    for (const s of sorties) expect(s.templateRevision, String(causes)).toBe(attendue);
  });
});

// ── Éditabilité : qui a le droit de devenir un référentiel ────────────────────
//
// Ces tests vivent dans CE fichier et pas dans un `template-edit.test.ts` dédié
// uniquement pour une raison de périmètre (lib/__tests__ appartient à un autre
// agent, sauf ce fichier). Thématiquement leur place est ailleurs — à déplacer
// dès que le lead ouvre le dossier.
describe("checkTemplateCoherence — un template faux ne doit pas pouvoir mesurer", () => {
  // LE test le plus utile du lot, et le seul qui puisse invalider mes propres
  // règles plutôt qu'un template : si le référentiel LIVRÉ ne passe pas mes
  // contrôles, ce sont les contrôles qui ont tort. Sans lui, j'aurais pu écrire
  // une validation parfaitement cohérente et rigoureusement insauvegardable —
  // l'éditeur se serait ouvert sur le template par défaut et aurait refusé de
  // l'enregistrer sans qu'on y ait touché.
  it("le template livré s'ouvre et se ré-enregistre sans ERREUR", () => {
    const check = checkTemplateCoherence(DEFAULT_TEMPLATE);
    const erreurs = check.problems.filter((p) => p.severity === "error");
    expect(erreurs.map((e) => e.message)).toEqual([]);
    // Contrôle positif : un `problems` vide ne prouve rien si aucun contrôle
    // n'a tourné. `checkedCount` existe pour distinguer les deux, donc on le lit.
    expect(check.checkedCount).toBeGreaterThanOrEqual(8);
  });

  // La fusion "Hero Asset / CTA URL" est délibérée et documentée. Elle DOIT
  // ressortir — sinon la validation ne voit pas ce que le moteur voit — mais en
  // avertissement, jamais en erreur : la classer erreur rendrait le template
  // livré insauvegardable, ce que le test précédent attraperait. Les deux
  // tiennent la même décision par ses deux bouts.
  it("la fusion voulue du template livré est DITE, sans bloquer", () => {
    const { problems } = checkTemplateCoherence(DEFAULT_TEMPLATE);
    const partages = problems.filter((p) => p.message.includes("SAME cell"));
    expect(partages.length).toBeGreaterThan(0);
    expect(partages.every((p) => p.severity === "warning")).toBe(true);
  });

  // ── Les trois contrôles de COLONNE DE LANGUE (2026-09-04) ─────────────────
  // Ils existent parce que la perte qu'ils annoncent s'est produite en vrai, et
  // s'est produite EN SILENCE : le template livré déclarait "TH", aucun
  // catalogue ne le connaissait, et un brief thaï rempli était lu vide. Ce qui
  // était alors un défaut de code est devenu, avec l'éditeur, un geste que
  // n'importe qui peut refaire d'un clic. Ces trois-là le disent à la saisie —
  // le seul moment où la correction est gratuite.
  it("le template livré ne déclenche AUCUN des trois contrôles de langue", () => {
    // La condition de base, et elle n'est pas décorative : ces contrôles
    // tournent sur chaque frappe de l'éditeur. Un seul faux positif sur le
    // livré rendrait les trois illisibles au bout d'une journée, et le vrai
    // avertissement se perdrait dans le bruit qu'ils feraient.
    const messages = checkTemplateCoherence(DEFAULT_TEMPLATE).problems.map((p) => p.message);
    expect(messages.filter((m) => m.includes("not a language the platform knows"))).toEqual([]);
    expect(messages.filter((m) => m.includes("both mean"))).toEqual([]);
    expect(messages.filter((m) => m.includes("no language name next to it"))).toEqual([]);
  });

  it("une colonne qu'aucun catalogue ne connaît est DITE, sans bloquer", () => {
    const casse = {
      ...DEFAULT_TEMPLATE,
      languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "SV"],
      languages: [...DEFAULT_TEMPLATE.languages, { code: "SV", name: "Swedish" }],
    };
    const p = checkTemplateCoherence(casse).problems.filter((x) => x.message.includes('"SV"'));
    expect(p).toHaveLength(1);
    // Avertissement et non erreur : `validateAgainstTemplate` continue de
    // mesurer tout le reste sur un tel template, et bloquer ici dirait le
    // contraire du juge — deux validations qui se contredisent produisent un
    // formulaire qui refuse d'enregistrer ce que le moteur accepte de juger.
    expect(p[0].severity).toBe("warning");
    expect(p[0].message).toContain("dropped when a brief is read");
  });

  it("deux orthographes d'une même colonne : DITES, là où le contrôle des doublons ne voit rien", () => {
    // "JP" et "JA" ne sont pas la même chaîne : le contrôle 6 (doublon
    // littéral) les laisse passer, et il a raison — ce sont deux colonnes du
    // classeur, à deux adresses. La perte est en aval, au jugement.
    const casse = {
      ...DEFAULT_TEMPLATE,
      languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "JA"],
      languages: [...DEFAULT_TEMPLATE.languages, { code: "JA", name: "Japanese" }],
    };
    const { problems } = checkTemplateCoherence(casse);
    const jumeaux = problems.filter((p) => p.message.includes("both mean"));
    expect(jumeaux).toHaveLength(1);
    expect(jumeaux[0].severity).toBe("warning");
    expect(jumeaux[0].message).toContain("JP and JA");
    // Et surtout : le contrôle des doublons littéraux reste MUET dessus. C'est
    // ce qui prouve que le nouveau contrôle couvre un cas que l'ancien ratait,
    // et non le même cas une seconde fois.
    expect(problems.filter((p) => p.message.includes("appears more than once"))).toEqual([]);
  });

  it("une colonne sans nom est DITE — c'est le code nu que le métier doit deviner", () => {
    const casse = { ...DEFAULT_TEMPLATE, languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "DE"] };
    const p = checkTemplateCoherence(casse).problems.filter((x) =>
      x.message.includes("no language name next to it")
    );
    expect(p).toHaveLength(1);
    expect(p[0].severity).toBe("warning");
    expect(p[0].message).toContain('"DE"');
    // CONTRÔLE NÉGATIF, sur la même forme : la colonne nommée ne dit rien. Sans
    // lui, un contrôle qui crierait sur toute colonne ajoutée passerait.
    const nommee = {
      ...casse,
      languages: [...DEFAULT_TEMPLATE.languages, { code: "DE", name: "German" }],
    };
    expect(
      checkTemplateCoherence(nommee).problems.filter((x) =>
        x.message.includes("no language name next to it")
      )
    ).toEqual([]);
  });

  it("deux champs sous la même clé : ERREUR, et la clé fautive est nommée", () => {
    const [a, b] = DEFAULT_TEMPLATE.fields;
    const casse = {
      ...DEFAULT_TEMPLATE,
      fields: [a, { ...b, key: a.key }],
    };
    const erreurs = checkTemplateCoherence(casse).problems.filter((p) => p.severity === "error");
    expect(erreurs.some((e) => e.field === a.key && e.message.includes("share the key"))).toBe(true);
    // Contrôle négatif sur la MÊME forme : deux champs, clés distinctes, aucun
    // reproche de doublon. Sans lui, une règle qui crierait sur tout passerait.
    const sain = { ...DEFAULT_TEMPLATE, fields: [a, b] };
    expect(
      checkTemplateCoherence(sain).problems.filter((p) => p.message.includes("share the key"))
    ).toEqual([]);
  });

  it("deux champs sur la même ligne : ERREUR — l'adresse documentée serait la même", () => {
    const [a, b] = DEFAULT_TEMPLATE.fields;
    const casse = { ...DEFAULT_TEMPLATE, fields: [a, { ...b, rowOffset: a.rowOffset }] };
    const erreurs = checkTemplateCoherence(casse).problems.filter((p) => p.severity === "error");
    expect(erreurs.some((e) => e.message.includes(`Row offset ${a.rowOffset}`))).toBe(true);
  });

  // Le contrat le plus facile à casser sans s'en rendre compte : une clé se
  // renomme d'un geste dans un formulaire, et tous les rapports déjà rendus qui
  // la citent deviennent orphelins EN SILENCE. Rien ne lève, rien ne s'affiche.
  it("renommer une clé : ERREUR ; renommer le LIBELLÉ : silence", () => {
    const [premier, ...reste] = DEFAULT_TEMPLATE.fields;

    const renommeCle = {
      ...DEFAULT_TEMPLATE,
      fields: [{ ...premier, key: "cle-inventee" }, ...reste],
    };
    const erreurs = checkTemplateCoherence(renommeCle, DEFAULT_TEMPLATE).problems.filter(
      (p) => p.severity === "error"
    );
    expect(erreurs.some((e) => e.field === premier.key)).toBe(true);

    // LEURRE INVERSE : changer ce qui s'AFFICHE doit rester libre. C'est toute
    // la raison d'avoir séparé `key` de `label` — si ce second cas rougissait,
    // la distinction ne servirait à rien et personne ne pourrait corriger une
    // faute de frappe à l'écran.
    const renommeLibelle = {
      ...DEFAULT_TEMPLATE,
      fields: [{ ...premier, label: "Un libellé retouché" }, ...reste],
    };
    expect(
      checkTemplateCoherence(renommeLibelle, DEFAULT_TEMPLATE).problems.filter(
        (p) => p.severity === "error"
      )
    ).toEqual([]);
  });

  it("une colonne de contenu tombée DANS le bloc de langues : ERREUR", () => {
    const casse = { ...DEFAULT_TEMPLATE, valueCol: DEFAULT_TEMPLATE.firstLangCol + 1 };
    const erreurs = checkTemplateCoherence(casse).problems.filter((p) => p.severity === "error");
    expect(erreurs.some((e) => e.message.includes("falls inside the language block"))).toBe(true);
  });

  it("une édition qui change la déclaration DÉPLACE la révision", () => {
    // Le lien entre les deux moitiés du chantier : la validation dit qui peut
    // mesurer, la révision dit qui a mesuré. Une édition acceptée qui ne
    // bougerait pas la révision servirait des rapports en cache jugés par
    // l'ancien référentiel, sans qu'aucune erreur ne soit levée.
    const [premier, ...reste] = DEFAULT_TEMPLATE.fields;
    const edite: BriefTemplate = {
      ...DEFAULT_TEMPLATE,
      fields: [{ ...premier, required: !premier.required }, ...reste],
    };
    expect(checkTemplateCoherence(edite, DEFAULT_TEMPLATE).problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(templateRevision(edite)).not.toBe(templateRevision(DEFAULT_TEMPLATE));
  });
});

describe("buildStoredTemplate — ce que le serveur pose, jamais le client", () => {
  const write = {
    label: "Template de sonde",
    channel: DEFAULT_TEMPLATE.channel,
    headerRow: DEFAULT_TEMPLATE.headerRow,
    fieldCol: DEFAULT_TEMPLATE.fieldCol,
    descCol: DEFAULT_TEMPLATE.descCol,
    valueCol: DEFAULT_TEMPLATE.valueCol,
    firstLangCol: DEFAULT_TEMPLATE.firstLangCol,
    languageColumns: [...DEFAULT_TEMPLATE.languageColumns],
    languages: DEFAULT_TEMPLATE.languages.map((l) => ({
      code: l.code,
      name: l.name,
      ...(l.note ? { note: l.note } : {}),
    })),
    fields: DEFAULT_TEMPLATE.fields.map((f) => ({
      key: f.key,
      label: f.label,
      description: f.description,
      master: f.master,
      rowOffset: f.rowOffset,
      kind: f.kind,
      required: f.required,
      translatable: f.translatable,
      ...(f.aliases ? { aliases: [...f.aliases] } : {}),
      ...(f.note ? { note: f.note } : {}),
    })),
    // Le glossaire est envoyé EXPLICITEMENT, comme le fait l'écran. L'omettre
    // ferait passer ce test par le repli « l'appelant ne connaît pas ce champ »
    // de buildStoredTemplate, c'est-à-dire mesurer le repli au lieu de mesurer
    // l'aller-retour.
    ...(DEFAULT_TEMPLATE.glossary ? { glossary: DEFAULT_TEMPLATE.glossary } : {}),
  };

  it("réenregistrer le template livré SANS le modifier garde sa révision", () => {
    // Un aller-retour par l'éditeur ne doit pas invalider tous les rapports en
    // cache. Si la révision bougeait ici, elle mesurerait l'ACTIVITÉ d'édition
    // et non le référentiel — et le seul moyen de s'en apercevoir serait une
    // facture de réanalyse.
    const t = buildStoredTemplate("default", write, null);
    expect(templateRevision(t)).toBe(templateRevision(DEFAULT_TEMPLATE));
    // …alors que l'ordinal lisible, lui, avance : les deux ne mesurent pas la
    // même chose et ne doivent jamais fusionner.
    expect(t.version).toBe(DEFAULT_TEMPLATE.version + 1);
    expect(t.updatedAt).not.toBe(DEFAULT_TEMPLATE.updatedAt);
  });

  it("le préambule non éditable survit à une sauvegarde", () => {
    // Ce que le formulaire n'affiche pas, il ne doit pas le détruire. Une perte
    // ici serait invisible à l'écran et définitive au premier enregistrement.
    expect(DEFAULT_TEMPLATE.preamble.length).toBeGreaterThan(0); // contrôle positif
    expect(buildStoredTemplate("default", write, null).preamble).toEqual(DEFAULT_TEMPLATE.preamble);
  });
});
