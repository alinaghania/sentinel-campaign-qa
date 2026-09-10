// LES 11 COLONNES LANGUE DU TEMPLATE ARRIVENT DANS LA GRILLE — et chacune
// porte SON contenu.
//
// Ce fichier a d'abord été un CHIFFRAGE DE PERTE : jusqu'au 2026-09-04, le
// template déclarait 11 colonnes et la grille en rendait 8. Il portait alors
// l'instruction « ce test doit devenir rouge le jour où on répare
// lib/lang-codes.ts ». Il est devenu rouge ; les valeurs ci-dessous sont les
// nouvelles, mesurées le 2026-09-04 sur le même harnais, et le fichier a changé
// de métier : il empêche maintenant le retour de ce qu'il mesurait.
//
// Ce qui se perdait, et par quels DEUX mécanismes distincts — il faut les
// garder nommés, parce qu'ils ne se réparent pas au même endroit :
//
//   1. COLLISION (MX, ZHT) — `canonLang("MX") === "ES"` et
//      `canonLang("ZHT") === "ZH"`. Deux colonnes recevaient le même code, et
//      `brief-grid.ts` n'en garde qu'une par code. La seconde n'était pas
//      écrasée : elle n'était JAMAIS LUE, sa cellule n'entrait dans aucune
//      boucle. Qui demandait MX recevait le texte d'ES — non vide, plausible,
//      faux. Réparé par `canonColumn` (lang-codes.ts) : la clé d'une colonne
//      est son code DÉCLARÉ, pas sa langue. `canonLang` garde son sens, qui est
//      juste : l'espagnol du Mexique est bien de l'espagnol.
//
//   2. ABSENCE DU CATALOGUE (TH) — `canonLang("TH")` rendait "TH", mais "TH"
//      n'était clé d'aucun catalogue et `canonHeader` est STRICT par conception
//      (sinon "FIELD"/"VALUE" passeraient pour des langues). La colonne thaïe
//      n'était pas reconnue du tout : ni clé, ni texte, ni trace. Réparé en
//      ajoutant TH à `LANG_LABEL` et à `ALIASES`.
//
// La différence comptait et compte encore comme garde : MX rendait un texte
// FAUX, TH ne rendait RIEN. Un écran vide se remarque ; un texte espagnol
// présenté comme mexicain, non.
//
// VÉRIFICATION PAR MUTATION (2026-09-04) : en rendant `canonColumn` équivalent
// à l'ancien code (`canonLang` + garde `in LANG_LABEL`), 5 cas de ce fichier
// repassent au rouge — « les 11 colonnes », « chacune porte son texte », « MX
// n'emprunte plus le texte d'ES », « TH a une clé », « le marché départage ».
// Les contrôles d'instrument restent verts, et c'est voulu : ils ne mesurent
// pas la réparation.

import { readFileSync } from "fs";
import { join } from "path";
import type ExcelJSTypes from "exceljs";
import { describe, expect, it } from "vitest";
import { parseBriefGridDetailed } from "../brief-grid";
import { BRIEF_SHEET, DEFAULT_TEMPLATE, buildTemplateWorkbook, layout } from "../brief-template";
import { runCodeChecks } from "../checks-code";
import { LANG_LABEL, canonLang } from "../lang-codes";
import { parseEmailFacts } from "../parse-email";
import type { BriefGrid } from "../types";

/** Les 11 colonnes langue déclarées par le template, dans l'ordre du fichier. */
const COLUMNS = ["EN", "IT", "FR", "ES", "MX", "PT", "JP", "KO", "ZHS", "ZHT", "TH"] as const;

/** Contenu écrit dans une cellule : porte le code de SA colonne et la clé de SA
 *  ligne. C'est ce qui rend la mesure attribuable — un texte retrouvé sous une
 *  autre clé dit de QUELLE colonne il vient. */
const texte = (code: string, rowKey: string) => `TEXTE-${code}-${rowKey}`;

/** Remplit les colonnes demandées du classeur généré depuis la déclaration.
 *  On part de `buildTemplateWorkbook` (export de production) et non d'une
 *  grille écrite à la main : un objet BriefGrid fabriqué prouverait seulement
 *  que mes propres clés se relisent. */
async function classeur(codes: readonly string[]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const vierge = (await buildTemplateWorkbook(DEFAULT_TEMPLATE)) as unknown as ExcelJSTypes.Buffer;
  await wb.xlsx.load(vierge);
  const ws = wb.getWorksheet(BRIEF_SHEET);
  if (!ws) throw new Error(`feuille "${BRIEF_SHEET}" absente du classeur généré`);
  for (const row of layout(DEFAULT_TEMPLATE).rows) {
    for (const [code, ref] of Object.entries(row.langCells)) {
      if (codes.includes(code)) ws.getCell(ref).value = texte(code, row.key);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const parse = async (codes: readonly string[]) => {
  const { grid, telemetry } = await parseBriefGridDetailed(await classeur(codes));
  if (!grid) throw new Error("le parseur n'a rendu aucune grille");
  return { grid, telemetry };
};

/** Un contenu est-il présent QUELQUE PART dans la grille rendue — sous n'importe
 *  quelle clé ? Chercher dans la sérialisation entière évite de conclure « MX
 *  est lu » alors qu'il serait rangé sous un code inattendu. */
const presentQuelquePart = (grid: BriefGrid, code: string) =>
  JSON.stringify(grid).includes(`TEXTE-${code}-`);

/** Compose un mail depuis UNE colonne de la grille et le fait juger. */
function juger(grid: BriefGrid, colonne: string, detecte: string, subject?: string) {
  const html = `<html><body>${grid.blocks
    .map((b) => b.valueByLang[colonne])
    .filter(Boolean)
    .map((t) => `<p>${t}</p>`)
    .join("")}</body></html>`;
  const { findings, passed, translationCases } = runCodeChecks({
    facts: parseEmailFacts(html),
    linkResults: [],
    briefGrid: grid,
    detectedLanguage: { lang: detecte, confidence: "high" },
    subject,
  });
  // La clé de colonne réellement retenue par `gridKeyForLang` s'observe par DEUX
  // canaux, et il faut les deux : le libellé du contrôle vert quand des blocs
  // ont matché, le `lang` des cas de traduction quand aucun n'a matché. N'en
  // lire qu'un rendrait `null` sur la moitié des cas — et un témoin muet ferait
  // passer « je n'ai pas su regarder » pour « aucune colonne n'a été choisie ».
  return {
    findingsBrief: findings.filter((f) => f.categorie === "brief").length,
    colonneRetenue:
      /\(([^)]+)\) found in the email/.exec(
        passed.find((p) => p.categorie === "brief")?.label ?? ""
      )?.[1] ??
      translationCases[0]?.lang ??
      null,
  };
}

describe("11 colonnes déclarées, 11 colonnes lues", () => {
  it("le harnais écrit bien 11 colonnes à contenus DISTINCTS", () => {
    // CONTRÔLE POSITIF DE L'INSTRUMENT. Sans lui, « MX est présent dans la
    // grille » pourrait être vert parce que je l'aurais écrit deux fois, ou
    // rouge parce que je ne l'aurais jamais écrit — je mesurerais mon propre
    // harnais et je l'appellerais un verdict sur la plateforme.
    expect(DEFAULT_TEMPLATE.languageColumns).toEqual([...COLUMNS]);
    expect(DEFAULT_TEMPLATE.languageColumns).toHaveLength(11);

    const row = layout(DEFAULT_TEMPLATE).rows[0];
    expect(row.key).toBe("subject-line");
    expect(Object.keys(row.langCells)).toEqual([...COLUMNS]);
    expect(new Set(Object.values(row.langCells)).size).toBe(11);
    expect(new Set(COLUMNS.map((c) => texte(c, row.key))).size).toBe(11);
  });

  it("la grille rendue porte les 11 langues", async () => {
    const { grid } = await parse(COLUMNS);
    // Une seule différence subsiste entre le code déclaré et la clé rendue :
    // JP → JA. Elle est SANS PERTE (aucune colonne "JA" concurrente dans le
    // template) et n'est donc pas promue : ne promouvoir que les codes dont le
    // défaut est mesuré évite de changer des clés en production pour rien.
    expect(grid.languages).toEqual(["EN", "IT", "FR", "ES", "MX", "PT", "JA", "KO", "ZHS", "ZHT", "TH"]);
    expect(grid.languages).toHaveLength(DEFAULT_TEMPLATE.languageColumns.length);
    expect(grid.langLabels).toEqual({ JA: "JP" });
  });

  it("chaque colonne remplie porte SON texte, aucune n'emprunte celui du voisin", async () => {
    const { grid } = await parse(COLUMNS);
    // Le compte ne suffit pas : 11 clés pourraient porter 9 contenus recopiés.
    // On vérifie l'ATTRIBUTION, colonne par colonne.
    for (const c of COLUMNS) expect(presentQuelquePart(grid, c), c).toBe(true);

    const sujet = grid.blocks.find((b) => b.name === "Subject Line");
    expect(sujet, "le bloc Subject Line a disparu — ce test ne mesure plus rien").toBeDefined();
    expect(sujet!.valueByLang).toEqual({
      EN: "TEXTE-EN-subject-line",
      IT: "TEXTE-IT-subject-line",
      FR: "TEXTE-FR-subject-line",
      ES: "TEXTE-ES-subject-line",
      // Les deux qui recevaient le texte du voisin. C'est ici que la
      // réparation se voit : MX ne dit plus TEXTE-ES, ZHT ne dit plus TEXTE-ZHS.
      MX: "TEXTE-MX-subject-line",
      PT: "TEXTE-PT-subject-line",
      JA: "TEXTE-JP-subject-line",
      KO: "TEXTE-KO-subject-line",
      ZHS: "TEXTE-ZHS-subject-line",
      ZHT: "TEXTE-ZHT-subject-line",
      // Celle qui ne rendait rien du tout.
      TH: "TEXTE-TH-subject-line",
    });
    // Et 11 contenus DIFFÉRENTS, pas 11 clés sur 9 valeurs.
    expect(new Set(Object.values(sujet!.valueByLang)).size).toBe(11);
  });

  it("TH est au catalogue — le second mécanisme, sur une valeur", async () => {
    // TH ne se canonicalisait pas de travers : il se canonicalisait en
    // lui-même. Ce qui manquait était le CATALOGUE, et c'est un autre défaut
    // que la collision — d'où un cas séparé.
    expect(canonLang("TH")).toBe("TH");
    expect("TH" in LANG_LABEL).toBe(true);
    const { grid } = await parse(COLUMNS);
    expect(grid.languages).toContain("TH");
    expect(grid.blocks.find((b) => b.name === "Subject Line")!.valueByLang.TH).toBe(
      "TEXTE-TH-subject-line"
    );
  });

  it("quatre colonnes remplies, la grille en annonce quatre", async () => {
    // Le cas le plus proche du métier : un chef de projet remplit EN + trois
    // marchés. Avant réparation la grille annonçait `["EN"]` — pas un blanc,
    // une AFFIRMATION : « campagne anglaise », enregistrée comme un fait
    // positif quelques secondes après qu'on lui a donné quatre langues, et tout
    // l'aval jugeait contre ce fait-là.
    //
    // EN est rempli DANS LE MÊME CLASSEUR que les trois autres : il est son
    // propre témoin. S'il tombait avec eux, la mesure ne dirait rien de la
    // plateforme et tout de mon harnais.
    const { grid } = await parse(["EN", "MX", "ZHT", "TH"]);
    expect(grid.languages).toEqual(["EN", "MX", "ZHT", "TH"]);
    expect([
      presentQuelquePart(grid, "EN"),
      presentQuelquePart(grid, "MX"),
      presentQuelquePart(grid, "ZHT"),
      presentQuelquePart(grid, "TH"),
    ]).toEqual([true, true, true, true]);
  });

  it("un brief dont la SEULE colonne traduite est MX est lu comme mexicain", async () => {
    // Le cas extrême d'avant : la colonne ES existe dans l'en-tête mais est
    // VIDE, donc aucune collision de CONTENU ne pouvait être invoquée — MX était
    // simplement hors de portée du parseur. La grille repliait alors sur EN et
    // affichait les PLACEHOLDERS du template vierge comme s'ils étaient le brief.
    const { grid } = await parse(["MX"]);
    expect(grid.languages).toEqual(["MX"]);
    expect(grid.blocks.find((b) => b.name === "Subject Line")!.valueByLang).toEqual({
      MX: "TEXTE-MX-subject-line",
    });
  });

  it("l'import reste silencieux — et c'est maintenant la bonne nouvelle", async () => {
    const { telemetry } = await parse(COLUMNS);
    // Ce cas était une OBSERVATION expliquant pourquoi la perte avait pu vivre :
    // rien ne l'annonçait. Il est conservé comme contrôle du canal. Il rapporte
    // "Mock Up" — un champ META porteur de contenu langue — donc le canal
    // FONCTIONNE ; s'il devenait muet, on ne saurait plus distinguer « rien à
    // signaler » de « l'instrument ne parle plus ».
    expect(telemetry.unmappedFields).toEqual(["Mock Up"]);
    expect(telemetry.family).toBe("field_value");
    expect(JSON.stringify(telemetry)).not.toContain("TEXTE-");
  });
});

describe("deux colonnes de la MÊME langue : c'est le marché qui départage", () => {
  // La partie que la clé de colonne ne suffit PAS à régler, et qu'il faut donc
  // mesurer à part. Une fois ES et MX tous deux présents dans la grille, un
  // mail espagnol correspond aux deux : la détection de langue ne peut pas
  // choisir, et elle a raison de ne pas pouvoir — l'espagnol du Mexique EST de
  // l'espagnol. La seule information qui tranche est le MARCHÉ, que SFMC pose
  // dans le nom de test.

  it("sans marché au sujet, le mail tombe sur ES — mais la colonne MX est NOMMÉE", async () => {
    // La limite qui SUBSISTE, énoncée sur une valeur plutôt qu'en commentaire :
    // sans marché, `gridKeyForLang` retient la PREMIÈRE colonne espagnole.
    //
    // Ce que je croyais devoir écrire ici : « le mail est jugé contre ES et les
    // écarts sont rapportés comme des traductions absentes ». Mesuré, c'est
    // faux et c'est mieux — la détection de langue croisée (le passage qui
    // cherche le texte sous les AUTRES clés) retrouve le contenu sous "MX" et
    // le DIT. Le lecteur reçoit « présent mais dans une autre langue (MX) au
    // lieu de ES », c'est-à-dire le nom exact de ce qu'il doit corriger.
    //
    // Cette phrase ne pouvait pas exister avant la réparation : la colonne MX
    // n'entrait dans aucune structure, donc rien ne pouvait la nommer.
    const { grid } = await parse(COLUMNS);
    const html = `<html><body>${grid.blocks
      .map((b) => b.valueByLang.MX)
      .filter(Boolean)
      .map((t) => `<p>${t}</p>`)
      .join("")}</body></html>`;
    const { findings } = runCodeChecks({
      facts: parseEmailFacts(html),
      linkResults: [],
      briefGrid: grid,
      detectedLanguage: { lang: "ES", confidence: "high" },
    });
    const brief = findings.filter((f) => f.categorie === "brief");
    expect(brief.length).toBeGreaterThan(0);
    // Chaque finding nomme la colonne TROUVÉE et celle ATTENDUE. Un message qui
    // dirait seulement « traduction absente » enverrait chercher un texte qui
    // est là, dans la colonne d'à côté.
    for (const f of brief) {
      expect(f.message, f.message).toContain("in another language (MX) instead of ES");
    }
  });

  it("avec « - MX - » au sujet, le mail est jugé contre SA colonne", async () => {
    const { grid } = await parse(COLUMNS);
    const r = juger(grid, "MX", "ES", "[1294653 - Store Closure - MX - F] x");
    expect(r.colonneRetenue).toBe("MX");
    expect(r.findingsBrief).toBe(0);
  });

  it("le marché ne peut pas CONTREDIRE la langue mesurée", async () => {
    // La garde qui empêche le remède d'être pire que le mal. Le marché vient
    // d'un libellé SAISI à la main ; la langue vient d'une mesure sur le
    // contenu. Un sujet qui annonce MX sur un mail japonais ne doit pas faire
    // juger ce mail contre le mexicain — sinon une faute de frappe dans un nom
    // de test produirait un rapport entièrement faux, et d'apparence normale.
    const { grid } = await parse(COLUMNS);
    const r = juger(grid, "JA", "JA", "[1294653 - Store Closure - MX - F] x");
    expect(r.colonneRetenue).toBe("JA");
    expect(r.findingsBrief).toBe(0);
  });

  it("CONTRÔLE POSITIF — chaque colonne réparée est atteignable par sa langue", async () => {
    // Sans ce cas, « MX est atteignable » pourrait tenir à un hasard de l'ordre
    // des colonnes. On vérifie les trois réparées et deux témoins.
    const { grid } = await parse(COLUMNS);
    // ZHT et ZHS partagent la langue ZH : même situation qu'ES/MX, même remède.
    expect(juger(grid, "ZHT", "ZH", "[1 - x - ZHT - ALL] y").colonneRetenue).toBe("ZHT");
    expect(juger(grid, "ZHS", "ZH").colonneRetenue).toBe("ZHS"); // première du groupe
    // TH n'a pas de jumelle : sa langue suffit, aucun marché nécessaire.
    expect(juger(grid, "TH", "TH").colonneRetenue).toBe("TH");
    // Témoins sans collision.
    expect(juger(grid, "FR", "FR").colonneRetenue).toBe("FR");
    expect(juger(grid, "JA", "JA").colonneRetenue).toBe("JA");
  });
});

describe("fichiers clients réels", () => {
  it("un brief à une seule colonne espagnole libellée MX garde son contenu", async () => {
    // Ce fichier ne porte qu'UNE colonne de la famille espagnole, libellée
    // "MX". Avant réparation elle prenait le code ES sans concurrente et son
    // contenu arrivait intact — c'était la BORNE qui empêchait de lire « le
    // mexicain est perdu » (faux) au lieu de « le mexicain est perdu QUAND une
    // colonne ES existe » (mesuré). Elle porte maintenant sa propre clé, et le
    // contenu arrive toujours : la réparation n'a rien coûté à ce cas-là.
    const buf = readFileSync(join(__dirname, "fixtures", "mx-guadalajara.xlsm"));
    const { grid, telemetry } = await parseBriefGridDetailed(buf);
    expect(telemetry.family).toBe("field_value");
    expect(grid!.languages).toEqual(["MX"]);
    // Le libellé du fichier EST la clé : plus besoin de le ranger à côté.
    expect(grid!.langLabels).toBeUndefined();
    // Contenu réellement porté (le texte n'est pas recopié ici : données client).
    expect(grid!.blocks.length).toBeGreaterThan(0);
    expect(grid!.blocks.some((b) => (b.valueByLang.MX ?? "").length > 0)).toBe(true);
  });
});
