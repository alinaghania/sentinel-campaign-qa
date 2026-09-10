// Boucle fermée du référentiel de template.
//
// Le test central : générer le .xlsx DEPUIS la déclaration, le reparser avec le
// parseur de production, et vérifier que ce qui ressort reproduit ce qui est
// déclaré. Sans lui, la page de doc, le fichier distribué aux marques et le
// parseur peuvent diverger en silence — chacun restant cohérent avec lui-même.
//
// Le second test compare les adresses CALCULÉES par layout() au classeur vierge
// RÉEL : c'est ce qui empêche la page de doc d'annoncer une cellule où l'humain
// ne trouvera rien.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import type ExcelJSTypes from "exceljs";
import { describe, expect, it } from "vitest";
import { parseBriefGridDetailed } from "../brief-grid";
import type { BriefGrid } from "../types";
import {
  BRIEF_SHEET,
  DEFAULT_TEMPLATE,
  buildTemplateWorkbook,
  cellRef,
  colLetter,
  layout,
  validateAgainstTemplate,
} from "../brief-template";
import type { BriefTemplate } from "../brief-template";
import { canonColumn } from "../lang-codes";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name));

const textFields = DEFAULT_TEMPLATE.fields.filter((f) => f.kind === "text");
const urlFields = DEFAULT_TEMPLATE.fields.filter((f) => f.kind === "url");

// L'extracteur n'est utile que s'il est REJOUÉ. `scripts/extract-placeholders.mjs`
// est la démonstration du contraire dans ce dépôt : marqué "One-shot", absent de
// package.json, sa sortie recopiée à la main — plus rien ne dit aujourd'hui si
// elle correspond encore au classeur. Une ligne npm ne suffit pas non plus :
// personne ne lance à la main un script dont il ignore l'existence. Le seul
// rejeu qui tienne est celui qu'on ne peut pas oublier de lancer.
describe("la déclaration extraite ne dérive pas du classeur vierge", () => {
  it("`npm run extract:template:check` ne signale aucune dérive", () => {
    const root = join(__dirname, "..", "..");
    // Échoue si brief-template.data.ts ne correspond plus à ce que l'extracteur
    // relit du .xlsm : quelqu'un a édité la déclaration à la main, ou le
    // classeur vierge a changé sans que l'extraction soit rejouée.
    expect(() =>
      execFileSync("node", ["scripts/extract-template.mjs", "--check"], {
        cwd: root,
        stdio: "pipe",
      })
    ).not.toThrow();
  });
});

describe("layout — adressage calculé, jamais écrit à la main", () => {
  it("colLetter couvre le passage à deux lettres", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(13)).toBe("N");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(cellRef(5, 0)).toBe("A6");
  });

  it("les adresses annoncées correspondent au classeur vierge RÉEL", async () => {
    // On relit le vrai fichier et on vérifie que la cellule annoncée par
    // layout() porte bien le libellé annoncé. Une doc juste sur elle-même mais
    // fausse sur le fichier serait invisible autrement.
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    // Même conversion que lib/brief-media.ts:154 : exceljs type ses buffers
    // avec son propre alias, qui n'est pas le Buffer Node.
    await wb.xlsx.load(fixture("blank-template.xlsm") as unknown as ExcelJSTypes.Buffer);
    const ws = wb.getWorksheet(BRIEF_SHEET);
    expect(ws).toBeDefined();

    const lay = layout(DEFAULT_TEMPLATE);
    expect(lay.headerCells.field).toBe("A6");
    expect(lay.headerCells.value).toBe("C6");
    expect(String(ws!.getCell(lay.headerCells.field).value)).toBe("FIELD");
    expect(String(ws!.getCell(lay.headerCells.value).value)).toBe("VALUE");

    for (const row of lay.rows) {
      const actual = String(ws!.getCell(row.fieldCell).value ?? "").trim();
      expect(actual, `${row.fieldCell} devrait porter "${row.label}"`).toBe(row.label);
    }

    // La première langue est en D6, et le premier champ en A7 : c'est ce que la
    // page de doc affichera au métier.
    expect(lay.langHeaderCells.EN).toBe("D6");
    expect(lay.rows[0].fieldCell).toBe("A7");
    expect(lay.rows[0].langCells.EN).toBe("D7");
  });
});

describe("boucle fermée : déclaration → .xlsx → parseur → déclaration", () => {
  it("le classeur généré est relu comme la déclaration le décrit", async () => {
    const buf = await buildTemplateWorkbook(DEFAULT_TEMPLATE);
    const { grid, telemetry } = await parseBriefGridDetailed(buf);

    expect(grid).not.toBeNull();
    // Le fichier généré doit être lu par le MÊME chemin que les briefs réels.
    expect(telemetry.family).toBe("field_value");
    expect(telemetry.sheetUsed).toBe(BRIEF_SHEET);

    // Un template vierge reste reconnu comme tel : la bannière qui prévient
    // « vous avez déposé le modèle, pas un brief » doit continuer de s'allumer.
    expect(grid!.isLikelyTemplate).toBe(true);

    // Blocs = champs `text`, dans l'ordre de la déclaration.
    expect(grid!.blocks.map((b) => b.name)).toEqual(textFields.map((f) => f.label));

    // Liens = champs `url`, libellé privé de " URL" par le parseur.
    expect(grid!.expectedLinks.map((l) => l.block)).toEqual(
      urlFields.map((f) => f.label.replace(/\s+URL\b/i, "").trim())
    );

    // Le préambule extrait est bien réécrit : sans lui, plus de nom Salesforce.
    expect(grid!.salesforceCampaignName).toBe("ADHOC_GLOBAL_OTM_EMAIL_20260521_WFP_26_Series");

    // Aucun champ porteur de contenu réel n'a été perdu en route.
    expect(telemetry.unmappedFields).toEqual([]);
  });

  it("le classeur généré et le vierge d'origine produisent la MÊME structure", async () => {
    const generated = await parseBriefGridDetailed(await buildTemplateWorkbook(DEFAULT_TEMPLATE));
    const original = await parseBriefGridDetailed(fixture("blank-template.xlsm"));

    expect(generated.grid).not.toBeNull();
    expect(original.grid).not.toBeNull();
    expect(generated.grid!.blocks.map((b) => b.name)).toEqual(original.grid!.blocks.map((b) => b.name));
    expect(generated.grid!.expectedLinks.map((l) => l.block)).toEqual(
      original.grid!.expectedLinks.map((l) => l.block)
    );
    expect(generated.grid!.salesforceCampaignName).toBe(original.grid!.salesforceCampaignName);
  });
});

// Le wizard « + New campaign » ne poste pas le tableau collé comme brief : il
// le fait composer en .xlsx, puis renvoie ce fichier au chemin d'import Excel
// habituel. Ces cas vérifient que le contenu saisi RESSORT du parseur — sans
// eux, le wizard reposerait sur la promesse que le format est bon.
describe("boucle fermée du wizard : tableau collé → .xlsx → parseur", () => {
  const FILL = {
    "subject-line": { EN: "Spring is here", FR: "Le printemps est là" },
    preheader: { EN: "Discover the collection", FR: "Découvrez la collection" },
    "cta-1-label": { EN: "Shop now", FR: "Acheter" },
    "hero-asset-url": { "": "https://balenciaga.com/hero" },
  };

  it("le contenu collé ressort du parseur, dans la bonne langue", async () => {
    const buf = await buildTemplateWorkbook(DEFAULT_TEMPLATE, FILL);
    const { grid, telemetry } = await parseBriefGridDetailed(buf);

    expect(grid).not.toBeNull();
    expect(telemetry.family).toBe("field_value");

    const subject = grid!.blocks.find((b) => b.name === "Subject Line");
    expect(subject?.valueByLang.EN).toBe("Spring is here");
    expect(subject?.valueByLang.FR).toBe("Le printemps est là");

    // La colonne VALUE (clé "") atteint bien le lien attendu, pas une langue.
    // Le parseur range une URL non déclinée par marché sous "WW" — mesuré, pas
    // supposé : `ExpectedLink` n'a pas de champ `url`.
    const hero = grid!.expectedLinks.find((l) => l.block === "Hero Asset");
    expect(hero?.ww).toBe("https://balenciaga.com/hero");
    expect(hero?.linksByMarket).toEqual({ WW: "https://balenciaga.com/hero" });

    // Rien de saisi n'a été perdu en route.
    expect(telemetry.unmappedFields).toEqual([]);
  });

  it("un brief composé n'est plus pris pour le modèle vierge", async () => {
    // CONTRÔLE POSITIF de la bannière « vous avez déposé le modèle » : elle
    // s'allume sur le vierge (test plus haut) et doit s'éteindre ici. Sans ce
    // cas, `isLikelyTemplate` pourrait être coincé à `true` et le wizard
    // afficherait un avertissement sur chaque brief qu'il produit.
    const filled = await parseBriefGridDetailed(await buildTemplateWorkbook(DEFAULT_TEMPLATE, FILL));
    expect(filled.grid!.isLikelyTemplate).toBe(false);
  });

  it("une cellule laissée vide reste VIDE, elle ne devient pas le placeholder", async () => {
    // Le vierge écrit un exemple en colonne VALUE. Le laisser sous un champ que
    // le métier a rempli en langues ferait relire l'exemple comme une valeur du
    // brief — un placeholder promu au rang de contenu.
    const buf = await buildTemplateWorkbook(DEFAULT_TEMPLATE, FILL);
    const { grid } = await parseBriefGridDetailed(buf);
    const subject = grid!.blocks.find((b) => b.name === "Subject Line");
    const master = DEFAULT_TEMPLATE.fields.find((f) => f.key === "subject-line")?.master ?? "";
    expect(master.length).toBeGreaterThan(0); // contrôle positif : il y a bien un exemple à ne pas garder
    expect(Object.values(subject?.valueByLang ?? {})).not.toContain(master);
    // Et une langue non saisie n'apparaît pas remplie.
    expect(subject?.valueByLang.IT ?? "").toBe("");
  });
});

describe("validateAgainstTemplate — trois états", () => {
  it("le template vierge lui-même est conforme à sa propre déclaration", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("blank-template.xlsm"));
    const res = validateAgainstTemplate(grid!, DEFAULT_TEMPLATE, { family: telemetry.family });
    // CONTRÔLE POSITIF : si le référentiel ne se reconnaît pas lui-même, il ne
    // reconnaîtra rien. Le vierge n'active que EN (feuille Common) et sa
    // colonne EN porte les valeurs master : il est donc conforme, pleinement.
    //
    // Cette assertion valait auparavant "deviation" avec 8 champs non traduits,
    // parce que la couverture se mesurait contre les 11 colonnes du template au
    // lieu des langues ACTIVÉES. Le contrôle positif passait quand même — c'est
    // précisément ce qui le rendait faible : il tolérait un dénominateur faux.
    expect(res.state).toBe("conformant");
    if (res.state !== "conformant") return;
    expect(res.matched).toBe(14);
  });

  it("une grille d'une autre famille n'est PAS jugée non conforme", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("amq-grid.xlsx"));
    expect(telemetry.family).toBe("grid");
    const res = validateAgainstTemplate(grid!, DEFAULT_TEMPLATE, { family: telemetry.family });
    // McQueen : le template ne gouverne pas ce fichier. Un inconnu présenté
    // comme un écart serait un faux qui a l'air d'une mesure.
    expect(res.state).toBe("not_applicable");
  });

  it("le brief MX est jugé SUR SA COLONNE, plus sur celle de sa jumelle", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("mx-guadalajara.xlsm"));
    const res = validateAgainstTemplate(grid!, DEFAULT_TEMPLATE, { family: telemetry.family });
    expect(res.state).toBe("deviation");
    if (res.state !== "deviation") return;

    // ── Ce que ce test disait jusqu'au 2026-09-04, et pourquoi il a changé ──
    // Il mesurait un ABANDON : le template déclare 11 colonnes, `canonLang` n'en
    // distinguait que 8, et ES/MX retombaient sur "ES". Sur CE brief-ci — un
    // brief mexicain — la colonne qui porte tout le contenu était justement l'une
    // des deux indistinguables. La plateforme nommait alors l'ambiguïté
    // (`ambiguousLanguages: ["ES","MX"]`) et se taisait sur la couverture : un
    // instrument muet le DIT, il ne tranche pas à la place. C'était la bonne
    // conduite pour un instrument cassé.
    //
    // L'instrument ne l'est plus (lib/lang-codes.ts, `canonColumn` : la clé est le
    // CODE DÉCLARÉ). La grille rend "MX", et "MX" seul est activé.
    expect(grid!.languages).toEqual(["MX"]);
    expect(res.ambiguousLanguages).toEqual([]);
    expect(res.unsupportedLanguages).toEqual([]);

    // La liste des non-traduits est vide comme avant — mais pour la raison
    // INVERSE, et c'est tout l'enjeu. Avant : « je ne sais pas lire cette
    // colonne ». Maintenant : « je l'ai lue, elle est remplie partout ». Deux
    // listes vides identiques à l'œil, deux verdicts opposés.
    expect(res.untranslated).toEqual([]);
    // Donc le contrôle positif est OBLIGATOIRE ici : sans lui, la réparation est
    // indistinguable de la panne qu'elle remplace. Même grille, une seule valeur
    // MX effacée → le trou est reproché, et il est reproché à MX.
    //
    // Le bloc vidé est "Preheader" et non le premier venu : "Subject Line (male
    // & others)" et "Subject Line (female)" retombent sur la MÊME clé une fois le
    // suffixe parenthésé retiré (`normLabel`, brief-template.ts:685), et la
    // seconde écrase la première — vider l'une des deux ne change donc rien. Ce
    // n'est pas le sujet de ce test, mais le contrôle positif l'aurait rendu
    // vert-et-vide sans un mot.
    const troue: BriefGrid = {
      ...grid!,
      blocks: grid!.blocks.map((b) => (b.name === "Preheader" ? { ...b, valueByLang: {} } : b)),
    };
    const res2 = validateAgainstTemplate(troue, DEFAULT_TEMPLATE, { family: telemetry.family });
    expect(res2.state).toBe("deviation");
    if (res2.state !== "deviation") return;
    expect(res2.untranslated.flatMap((u) => u.missingLanguages)).toEqual(["MX"]);
  });

  it("un brief field_value d'un AUTRE canal n'est pas 'non conforme', il est hors spec", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("bal-stj-fieldvalue.xlsm"));
    // Même FAMILLE que le template — le tri par famille ne suffit donc pas.
    expect(telemetry.family).toBe("field_value");
    // …mais la première section du classeur est le canal TASK, pas EMAIL : le
    // parseur s'arrête au CHANNEL_BREAK suivant (brief-grid.ts:321-331) et ne
    // rapporte que "Subject" et "Description".
    expect(grid!.blocks.map((b) => b.name)).toEqual(["Subject", "Description"]);
    const res = validateAgainstTemplate(grid!, DEFAULT_TEMPLATE, { family: telemetry.family });
    // Sans ce garde-fou, ce brief de PRODUCTION valide sortait 13 champs requis
    // « manquants » et 2 « en trop » : un faux à la forme d'une mesure réussie.
    expect(res.state).toBe("not_applicable");
  });
});


// --- La restriction aux langues ACTIVÉES ne fabrique pas de manquant --------

// Ce bloc est né d'une réserve : le filtre de brief-template.ts:723
// (`activated.has(canon)`) est du MÊME CÔTÉ que le critère qu'il juge. Il
// restreint les colonnes examinées à partir de `grid.languages`, alors que la
// collision, elle, vient de la canonicalisation. La crainte était qu'une
// ambiguïté cesse d'être NOMMÉE et redevienne un « manquant » ordinaire —
// c'est-à-dire exactement le défaut que le commentaire de brief-template.ts:725
// dit vouloir éviter, mais restreint aux cas où l'instrument regarde déjà.
//
// Elle ne peut pas se produire, et c'est mesurable plutôt qu'argumentable : deux
// codes en collision partagent leur clé de colonne PAR DÉFINITION. Activer cette
// clé les fait donc entrer TOUS LES DEUX, et ne pas l'activer les fait sortir
// tous les deux — auquel cas la langue n'est plus exigée du tout, donc rien ne
// devient manquant non plus. Le filtre ne peut pas séparer des jumeaux.
//
// OÙ SONT LES JUMEAUX, depuis le 2026-09-04. Ils n'étaient pas déclarés à la
// main : ES/MX et ZHS/ZHT collisionnaient sur le template LIVRÉ, parce que la
// clé de colonne était la LANGUE. Elle est maintenant le CODE DÉCLARÉ, et le
// livré n'a plus de paire du tout. Le raisonnement ci-dessus reste vrai et reste
// exposé — les templates sont ÉDITABLES, donc une paire se déclare désormais à
// la main ("JP" et "JA" côte à côte, "PT" et "BR"). Les faire porter par un
// template CONSTRUIT est le seul moyen de continuer à mesurer ce que le filtre
// fait aux jumeaux ; le laisser sur le livré rendrait ces cinq tests verts et
// vides. Le pendant — ES et MX qui ne sont PLUS jumeaux — est mesuré au dernier
// cas du bloc, et c'est lui qui date le changement.
//
// Ces tests épinglent ce raisonnement sur des valeurs. Grilles construites à la
// main : un fixture porte SES langues, et on a justement besoin de faire varier
// celles-là.
describe("ambiguïté de langue et langues activées", () => {
  /** Template édité portant deux paires en collision déclarées à la main. */
  const TPL_JUMEAUX: BriefTemplate = {
    ...DEFAULT_TEMPLATE,
    languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "JA", "BR"],
  };

  const gridWith = (languages: string[]): BriefGrid => ({
    languages,
    blocks: [{ name: "Subject line", valueByLang: { [languages[0] ?? "EN"]: "x" } }],
    expectedLinks: [],
  });

  /** Les codes ambigus rendus pour un jeu de langues activées. */
  const ambiguousFor = (languages: string[], tpl: BriefTemplate = TPL_JUMEAUX): readonly string[] => {
    const res = validateAgainstTemplate(gridWith(languages), tpl, {
      family: "field_value",
    });
    expect(res.state).toBe("deviation");
    if (res.state !== "deviation") throw new Error("unreachable");
    return res.ambiguousLanguages;
  };

  it("activer UNE clé nomme les DEUX codes qui la partagent", () => {
    // Le cas redouté, mesuré : la grille n'active que "JA", et pourtant les deux
    // codes qui y retombent sont nommés ambigus. Aucun ne peut retomber dans les
    // manquants — c'est ce qui rend la restriction sûre.
    expect(ambiguousFor(["JA"])).toEqual(["JP", "JA"]);
  });

  it("le mécanisme vaut pour l'AUTRE collision, pas seulement la première", () => {
    // Sans ce test, la règle pourrait être taillée pour une paire et personne ne
    // le verrait.
    expect(ambiguousFor(["PT"])).toEqual(["PT", "BR"]);
  });

  it("les deux collisions se cumulent sans se contaminer", () => {
    expect(ambiguousFor(["JA", "PT"])).toEqual(["PT", "JP", "JA", "BR"]);
  });

  it("CONTRÔLE NÉGATIF — une langue sans jumeau n'est jamais nommée ambiguë", () => {
    // Sans lui, un code qui nommerait TOUT ambigu ferait passer les trois tests
    // ci-dessus. EN n'entre en collision avec rien dans ce template.
    expect(ambiguousFor(["EN"])).toEqual([]);
  });

  it("ES et MX ne sont plus jumeaux : chacun est jugé pour lui-même", () => {
    // Le pendant des quatre cas ci-dessus, sur le template LIVRÉ. Ces deux
    // colonnes étaient LA paire de production, celle qui coûtait le plus cher :
    // qui demandait MX recevait le texte espagnol, non vide et plausible. Aucune
    // n'est plus ambiguë, et activer l'une n'en fait plus entrer deux.
    expect(ambiguousFor(["ES"], DEFAULT_TEMPLATE)).toEqual([]);
    expect(ambiguousFor(["MX"], DEFAULT_TEMPLATE)).toEqual([]);
    expect(ambiguousFor(["ES", "MX"], DEFAULT_TEMPLATE)).toEqual([]);
    // Et la séparation porte jusqu'au reproche, qui est ce qui se lit en aval :
    // une grille qui n'a que l'espagnol se voit reprocher MX, et MX seul.
    const res = validateAgainstTemplate(
      { languages: ["ES", "MX"], blocks: [{ name: "Subject line", valueByLang: { ES: "Hola" } }], expectedLinks: [] },
      DEFAULT_TEMPLATE,
      { family: "field_value" }
    );
    if (res.state !== "deviation") throw new Error("unreachable");
    expect(res.untranslated.filter((u) => u.key === "subject-line").map((u) => [...u.missingLanguages])).toEqual([["MX"]]);
  });

  it("une langue NON activée n'est ni ambiguë, ni comptée non traduite", () => {
    // La raison d'être du filtre : le template ÉNUMÈRE onze langues, il ne les
    // exige pas toutes. Le brief Guadalajara ne vise que le Mexique et se voyait
    // reprocher sept trous FABRIQUÉS par champ.
    const res = validateAgainstTemplate(
      { ...gridWith(["EN"]), blocks: [{ name: "Subject line", valueByLang: { EN: "Hello" } }] },
      DEFAULT_TEMPLATE,
      { family: "field_value" }
    );
    expect(res.state).toBe("deviation");
    if (res.state !== "deviation") return;
    const named = res.untranslated.flatMap((u) => u.missingLanguages);
    for (const code of ["IT", "FR", "ES", "MX", "PT", "JP", "KO", "ZHS", "ZHT", "TH"]) {
      expect(named, code).not.toContain(code);
    }
  });

  // TH n'était PAS un cas d'ambiguïté et n'avait rien à faire dans le bloc
  // ci-dessus : il ne se confondait avec aucune jumelle, il n'existait simplement
  // pas pour la plateforme. Distinguer les deux pertes n'était pas de la
  // taxinomie — elles se réparent à des endroits différents (arbitrer un
  // discriminant pour MX, ajouter une entrée pour TH), et les confondre aurait
  // fait chercher la seconde là où se trouvait la première. Les deux
  // réparations ont bien eu lieu à ces deux endroits-là.
  it("TH est PORTÉE : les 11 colonnes déclarées sont toutes lisibles", () => {
    const res = validateAgainstTemplate(gridWith(["EN"]), DEFAULT_TEMPLATE, { family: "field_value" });
    expect(res.state).toBe("deviation");
    if (res.state !== "deviation") return;
    // Avant le 2026-09-04 : `canonLang("TH")` rendait bien "TH", mais LANG_LABEL
    // ne connaissait que 12 codes et TH n'en faisait pas partie ; la colonne
    // était écartée sans trace (brief-grid.ts) et la plateforme l'avouait ici.
    // TH est au catalogue depuis, et l'aveu n'a plus personne à nommer.
    expect(res.unsupportedLanguages).toEqual([]);
    expect(DEFAULT_TEMPLATE.languageColumns).toHaveLength(11);
    expect(DEFAULT_TEMPLATE.languageColumns.map((c) => canonColumn(c)).filter(Boolean)).toHaveLength(11);
  });

  it("CONTRÔLE POSITIF — un code inconnu déclaré est TOUJOURS avoué", () => {
    // Sans lui, `unsupportedLanguages: []` serait indistinguable d'un mécanisme
    // débranché. Il ne l'est pas, et il compte plus qu'avant : les templates sont
    // éditables, donc c'est par cet aveu que quelqu'un qui déclare "SV" demain
    // l'apprendra — et non par une colonne qui s'évapore en silence.
    expect(canonColumn("SV")).toBeNull();
    const res = validateAgainstTemplate(gridWith(["EN"]), {
      ...DEFAULT_TEMPLATE,
      languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "SV"],
    }, { family: "field_value" });
    if (res.state !== "deviation") throw new Error("unreachable");
    expect(res.unsupportedLanguages).toEqual(["SV"]);
    // Et un inconnu n'est ni ambigu, ni reproché au brief : le reprocher serait
    // accuser le brief d'un défaut de l'instrument.
    expect(res.ambiguousLanguages).not.toContain("SV");
    expect(res.untranslated.flatMap((u) => u.missingLanguages)).not.toContain("SV");
  });
});
