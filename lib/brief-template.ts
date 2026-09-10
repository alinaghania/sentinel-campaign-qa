// Référentiel du BRIEF TEMPLATE — source de vérité unique.
//
// Un seul objet décrit la structure attendue d'un brief, et SIX consommateurs
// en dérivent : la page de doc (adresses de cellules affichées), les colonnes
// du wizard, le .xlsx vierge téléchargeable, la validation à l'import, les
// règles de conformité, et le contexte injecté aux agents. Trois copies de la
// même vérité divergeraient en trois mois.
//
// Deux règles de construction, l'une et l'autre défensives :
//  1. AUCUN numéro de ligne n'est écrit à la main. Les adresses A1 sont
//     CALCULÉES par layout() depuis une déclaration ordonnée.
//  2. La déclaration elle-même n'est pas tapée : elle est EXTRAITE du classeur
//     vierge officiel (scripts/extract-template.mjs → brief-template.data.ts).
//     Un référentiel recopié serait conforme à ce qu'on croit avoir lu, pas au
//     fichier — faux d'une manière indétectable avant la production.
//
// Le template est un référentiel de MESURE, pas un filtre d'ADMISSION : un
// brief qui ne le suit pas reste analysé (cf. TemplateConformance, 3 états).

import { createHash } from "node:crypto";
import type ExcelJS from "exceljs";
import { canonColumn } from "./lang-codes";
import type { BriefGrid } from "./types";
import { EXTRACTED_TEMPLATE } from "./brief-template.data";

// ── Modèle ───────────────────────────────────────────────────────────────────

/** Nature d'un champ, dérivée du libellé par une règle énoncée (cf. extracteur).
 *  - `text` : contenu rédigé, traduisible ;
 *  - `url`  : lien attendu — devient un expectedLink, pas un bloc ;
 *  - `meta` : métadonnée du brief (Mock Up, Target…) — jamais un bloc. */
export type BriefTemplateFieldKind = "text" | "url" | "meta";

export interface BriefTemplateField {
  /** Clé stable. C'est un CONTRAT : elle voyage dans les rapports et les
   *  réglages, elle ne se renomme JAMAIS même si le libellé affiché change. */
  readonly key: string;
  /** Libellé tel qu'il figure en colonne FIELD du classeur. */
  readonly label: string;
  readonly description: string;
  /** Exemple de la colonne VALUE (placeholder du template). */
  readonly master: string;
  /** Décalage de ligne depuis l'en-tête, tel qu'OBSERVÉ dans le classeur — pas
   *  un rang. Le vierge laisse une ligne vide avant "Mock Up" (A21 vide, A22 =
   *  Mock Up) : supposer des lignes consécutives ferait annoncer par la doc une
   *  cellule où le métier ne trouverait rien. */
  readonly rowOffset: number;
  readonly kind: BriefTemplateFieldKind;
  readonly required: boolean;
  readonly translatable: boolean;
  /** Libellés alternatifs acceptés par l'appariement (`fieldLookupKeys`).
   *
   *  Ne vient PAS de l'extracteur : le classeur vierge ne déclare aucun
   *  synonyme. C'est de la POLITIQUE, au même titre que `required` et
   *  `translatable`, et elle est posée par `FIELD_ALIASES` plus bas — le
   *  fichier de données est généré et toute valeur écrite dedans à la main
   *  serait effacée à la prochaine régénération, sans bruit. */
  readonly aliases?: readonly string[];
  /** GLOSSAIRE — ce que cette ligne veut dire pour ce client, écrit par le
   *  métier et lu par les agents.
   *
   *  Distinct de `description`, qui est la colonne DESC du classeur : celle-là
   *  est un FAIT extrait, réécrite à chaque régénération du fichier de données.
   *  Celle-ci est de la POLITIQUE, au même titre que `aliases` — elle survit,
   *  et elle est la seule des deux qu'on peut modifier depuis l'écran.
   *
   *  Elle entre dans la révision : un agent à qui l'on dit « ce champ accepte
   *  un titre sans ponctuation finale » ne rend pas le même verdict qu'un agent
   *  à qui on ne le dit pas. Une note qui bouge sans bouger la révision ferait
   *  resservir un rapport en cache jugé sans elle. */
  readonly note?: string;
}

export interface BriefTemplateLanguage {
  /** Code tel qu'écrit en en-tête de colonne (EN, MX, ZHS…). */
  readonly code: string;
  /** Libellé humain de la feuille Common ("Spanish (Mexico)"). */
  readonly name: string;
  /** GLOSSAIRE de la colonne : le marché, l'usage, ce qui distingue ce code
   *  d'un autre qui lui ressemble (MX vs ES, ZHS vs ZHT). Même statut que
   *  `BriefTemplateField.note` — politique, éditable, dans la révision. */
  readonly note?: string;
}

export interface BriefTemplatePreambleCell {
  readonly col: number;
  readonly value: string;
}

export interface BriefTemplatePreambleRow {
  readonly row: number;
  readonly cells: readonly BriefTemplatePreambleCell[];
}

/** Ce que l'extracteur lit du classeur — la partie FACTUELLE du template. */
export interface BriefTemplateData {
  readonly source: string;
  readonly channel: string;
  readonly headerRow: number;
  readonly fieldCol: number;
  readonly descCol: number;
  readonly valueCol: number;
  readonly firstLangCol: number;
  readonly languageColumns: readonly string[];
  readonly languages: readonly BriefTemplateLanguage[];
  readonly preamble: readonly BriefTemplatePreambleRow[];
  readonly fields: readonly BriefTemplateField[];
  /** GLOSSAIRE GÉNÉRAL du référentiel : ce que les agents doivent savoir du
   *  brief avant d'en juger le contenu, et qui ne tient dans aucune ligne en
   *  particulier (conventions de la marque, ce qui compte comme « rempli »,
   *  qui écrit quoi).
   *
   *  Optionnel, et l'absence n'est PAS le vide : un template sans glossaire ne
   *  fait injecter aucun bloc, plutôt qu'un bloc vide qui dirait au modèle
   *  « voici tout ce qu'il faut savoir » sur rien du tout. */
  readonly glossary?: string;
}

/** Le template EFFECTIF : les faits extraits + la version et sa traçabilité.
 *  Structure stable par CONVENTION, pas par impossibilité technique — mais
 *  toute modification est datée, versionnée et visible. */
export interface BriefTemplate extends BriefTemplateData {
  /** ORDINAL LISIBLE, et rien d'autre. « v3 » se dit à l'écran, se cite dans un
   *  mail, se compare à l'œil. Il est posé à la main et rien ne garantit qu'il
   *  change quand la déclaration change : c'est un LIBELLÉ.
   *
   *  Ne jamais l'utiliser comme clé technique — ni en sel de cache, ni pour
   *  décider si un rapport doit être rejoué. Pour ça, `templateRevision()`. */
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy?: string;
  readonly label: string;
}

/** Clé TECHNIQUE du référentiel : empreinte de la DÉCLARATION.
 *
 *  Pourquoi elle existe, et pourquoi maintenant plutôt qu'après l'éditabilité.
 *  Le sel de cache d'analyze.ts a longtemps porté `DEFAULT_TEMPLATE.version`,
 *  un littéral incrémenté à la main. Tant que le template n'était modifiable
 *  que par un développeur éditant ce fichier, l'oubli se voyait à la relecture.
 *  Le jour où l'édition passe par l'UI, plus personne n'incrémente : le
 *  référentiel bouge, la clé ne bouge pas, et les rapports en cache sont servis
 *  comme s'ils avaient été jugés par le nouveau template. Ça ne lève AUCUNE
 *  erreur — c'est un faux parfaitement silencieux, et c'est pour ça qu'il ne
 *  peut pas être posé « plus tard ».
 *
 *  Dérivée, donc : un référentiel qui bouge change sa révision par
 *  construction, et une édition qui ne change rien n'invalide rien.
 *
 *  Ce qui entre : tout ce qui peut changer un VERDICT — la géométrie de la
 *  feuille, les colonnes de langue, et pour chaque champ sa clé, son libellé,
 *  son type, ses alias, ses deux politiques (`required`, `translatable`) et son
 *  `rowOffset`.
 *
 *  🔑 `rowOffset` et non le RANG du champ dans la liste. Une première version
 *  de ce commentaire affirmait « l'ORDRE des champs fixe la ligne de chaque
 *  champ » : c'est faux, et le fichier le dit dix lignes plus haut — le vierge
 *  laisse une ligne vide avant "Mock Up" (A21 vide, A22 = Mock Up), et c'est
 *  précisément pourquoi `rowOffset` est un décalage OBSERVÉ et pas un rang.
 *  Hacher l'ordre sans hacher `rowOffset` aurait laissé déplacer une adresse de
 *  cellule sans changer la révision — le défaut exact que cette fonction existe
 *  pour empêcher, réintroduit par l'énoncé écrit à côté d'elle.
 *
 *  Ce qui n'entre PAS : `label`, `version`, `updatedAt`, `updatedBy`, `source`.
 *  Corriger une faute de frappe dans le libellé affiché ne doit pas invalider
 *  tous les rapports en cache — sinon la révision mesurerait l'activité d'édition
 *  au lieu de mesurer le référentiel.
 *
 *  La liste est ÉNUMÉRÉE et non `JSON.stringify(tpl)` : sérialiser l'objet
 *  entier ferait entrer n'importe quel champ ajouté plus tard sans que personne
 *  ne se pose la question. Le revers est qu'un champ de déclaration ajouté
 *  demain serait oublié ici en silence — c'est exactement ce que la garde
 *  « la révision couvre TOUTE la déclaration » de
 *  lib/__tests__/brief-template-conformance.test.ts interdit : elle épingle les
 *  clés de `BriefTemplateData` et rougit tant que le champ nouvellement ajouté
 *  n'a pas été explicitement classé dedans ou dehors. */
export function templateRevision(tpl: BriefTemplateData): string {
  const cached = REVISION_CACHE.get(tpl);
  if (cached) return cached;
  const declaration = {
    channel: tpl.channel,
    headerRow: tpl.headerRow,
    fieldCol: tpl.fieldCol,
    descCol: tpl.descCol,
    valueCol: tpl.valueCol,
    firstLangCol: tpl.firstLangCol,
    languageColumns: [...tpl.languageColumns],
    // `languages` (code → libellé humain) entre dans l'empreinte pour une
    // raison qui n'est PAS « ça change un verdict » — mesuré le 04/09/2026, ça
    // n'en change aucun aujourd'hui : deux templates ne différant que par leur
    // liste de langues composent deux classeurs qui se parsent en grilles
    // identiques (`grid.languages` vient des EN-TÊTES de colonnes, donc de
    // `languageColumns`), et rendent le même `state`, le même `missing`, le
    // même `untranslated`. Réordonner la liste pour changer `masterLang` n'y
    // change rien non plus. L'inférence contraire, lue dans le code de
    // `buildTemplateWorkbook` (feuille Common → `includedLanguages`), était
    // fausse : `activatedLangs` ne sert qu'à choisir la langue master, et ce
    // choix n'a pas atteint la sortie sur les montages essayés.
    //
    // La raison est l'ARCHIVE. `Templates.archive` prend l'empreinte pour CLÉ
    // D'IDENTITÉ et ne réécrit jamais (store.ts). Hors empreinte, deux listes
    // de langues différentes partagent une clé : la seconde n'est jamais
    // archivée, et `Templates.revision(rev)` — qui répond à « que contenait le
    // référentiel qui a rendu CE verdict ? » — rend la première. Une archive
    // qui atteste une langue qui n'était pas déclarée est pire qu'une archive
    // absente, parce qu'elle se cite.
    //
    // Et c'est vrai par avance : dès que `lang-codes.ts` cesse de replier MX
    // sur ES et ZHT sur ZH, `includedLanguages` retiendra des langues qu'il
    // écarte aujourd'hui, et cette liste commencera à peser sur les verdicts.
    //
    // Coût assumé : renommer « Thailand » en « Thai » invalide les rapports en
    // cache. Un renommage est rare ; une archive falsifiée est définitive.
    languages: tpl.languages.map((l) => ({ code: l.code, name: l.name, note: l.note ?? "" })),
    fields: tpl.fields.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      required: f.required,
      translatable: f.translatable,
      rowOffset: f.rowOffset,
      aliases: [...(f.aliases ?? [])],
      note: f.note ?? "",
    })),
    // Le GLOSSAIRE est haché comme le reste, et pour la raison la plus directe
    // qui soit : il part dans le prompt des agents. Une phrase ajoutée au
    // glossaire change ce qui est demandé au modèle, donc peut changer un
    // verdict — le laisser hors empreinte ferait resservir en cache des
    // rapports jugés SANS elle, avec l'écran affichant la nouvelle.
    //
    // `?? ""` et non l'omission : sans lui, un template qui passe de « pas de
    // glossaire » à « glossaire vide » (une case ouverte puis refermée)
    // changerait d'empreinte pour rien, et invaliderait tous ses rapports.
    glossary: tpl.glossary ?? "",
  };
  const rev = createHash("sha256").update(JSON.stringify(declaration)).digest("hex").slice(0, 12);
  REVISION_CACHE.set(tpl, rev);
  return rev;
}

/** Mémoïsation par IDENTITÉ d'objet, pas par contenu : les templates sont
 *  immuables (`readonly` partout) et `templateRevision` est appelé sur le
 *  chemin d'analyse. Une WeakMap n'empêche pas la collecte d'un template édité
 *  puis abandonné. */
const REVISION_CACHE = new WeakMap<BriefTemplateData, string>();

/** Synonymes acceptés, par clé de champ. Couche de POLITIQUE appliquée aux
 *  champs extraits — le classeur vierge n'en déclare aucun.
 *
 *  UN SEUL cas, et c'est un arbitrage assumé, pas un synonyme trouvé au
 *  hasard. Le seul brief EMAIL réel du dépôt (mx-guadalajara.xlsm) écrit une
 *  ligne unique "Hero Asset / CTA URL" là où le vierge déclare DEUX champs
 *  requis séparés, "Hero Asset URL" et "CTA 1 URL". Sans alias, ce brief
 *  parfaitement valide récoltait TROIS reproches faux : deux « champ requis
 *  manquant » et un « champ non déclaré » — sur une URL qui EST dans le brief,
 *  avec une remédiation pointant un levier qu'aucune donnée n'exerçait.
 *
 *  Pourquoi un alias déclaré et pas un découpage du libellé sur "/" : mesuré,
 *  "CTA URL" se normalise en "cta", qui n'égale pas "cta 1" mais s'apparie par
 *  préfixe à "cta 2 - women" et "cta 2 - men" — deux champs RÉELLEMENT absents
 *  de ce brief. Un découpeur générique masquerait donc de vrais défauts pour
 *  en supprimer un faux : le remède serait pire, et invisible. L'alias capture
 *  le libellé OBSERVÉ, exactement lui, et rien d'autre.
 *
 *  La fusion n'est pas pour autant absorbée en silence : les deux champs
 *  s'apparient à LA MÊME cellule, `sharedCells` le constate et le rapport le
 *  dit. Si Alina tranche que les deux liens doivent être distincts, retirer les
 *  deux lignes ci-dessous suffit à rétablir l'écart — la question reste posée,
 *  elle cesse seulement d'être posée sous la forme d'un faux reproche. */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "hero-asset-url": ["Hero Asset / CTA URL"],
  "cta-1-url": ["Hero Asset / CTA URL"],
};

/** Le glossaire livré avec le template de base.
 *
 *  Il ne décrit QUE des choses vraies par construction : comment Sentinel lit
 *  le classeur, ce que « obligatoire » et « traduit » veulent dire ICI, et
 *  comment les colonnes de langue sont appariées. Aucune règle métier du client
 *  n'y figure — une politique de marque écrite ici serait une constante sans
 *  auteur, recopiée dans le prompt de chaque agent et impossible à contester
 *  puisque personne ne se souviendrait de l'avoir posée. Ces lignes-là, c'est
 *  au métier de les écrire dans les notes, et l'écran lui laisse la place. */
const DEFAULT_GLOSSARY = `Ce tableau est le référentiel du brief : une ligne par champ attendu, une colonne par langue.
- Colonne VALUE (« master ») : la version de référence, écrite dans la langue source. C'est elle qui fait foi quand une langue manque.
- Colonnes de langue : le code en en-tête est celui du classeur (EN, FR, MX…) ; c'est lui, et pas le libellé humain, qui décide de l'appariement avec le marché de l'email.
- « Obligatoire » : le champ doit être renseigné dans le brief. Un champ obligatoire vide est un manque du BRIEF, pas une faute de l'email.
- « Traduit » : le champ est attendu dans chaque langue déclarée. Un champ non traduit (URL, métadonnée) qui porte le même texte partout est normal.
- Une cellule vide dans une langue déclarée signifie « non fourni », jamais « identique au master ».`;

export const DEFAULT_TEMPLATE: BriefTemplate = {
  ...EXTRACTED_TEMPLATE,
  glossary: DEFAULT_GLOSSARY,
  fields: EXTRACTED_TEMPLATE.fields.map((f) =>
    FIELD_ALIASES[f.key] ? { ...f, aliases: FIELD_ALIASES[f.key] } : f
  ),
  version: 1,
  // Date de l'extraction initiale depuis le classeur vierge, pas une date
  // d'exécution : un template doit avoir la même version partout, toujours.
  updatedAt: "2026-09-03T00:00:00.000Z",
  label: "Kering EMAIL brief — v1",
};

/** Identifiant du template livré avec le code. Une entrée stockée sous cet id
 *  est une ÉDITION de `DEFAULT_TEMPLATE`, pas un template distinct : c'est ce
 *  qui permet de modifier le référentiel de base sans perdre le fait qu'il est
 *  le référentiel de base. La supprimer restaure le code. */
export const DEFAULT_TEMPLATE_ID = "default";

/** Un template tel qu'il vit dans le stockage. `id` n'entre pas dans la
 *  révision : deux templates identiques sous deux ids ont la même empreinte, ce
 *  qui est correct — l'empreinte mesure ce qui JUGE, pas où c'est rangé. */
export interface StoredBriefTemplate extends BriefTemplate {
  readonly id: string;
  /** Date de CRÉATION, distincte de `updatedAt`. Les deux répondent à deux
   *  questions et une seule sert ici : « quel est le dernier template créé ? »
   *  est la règle de défaut d'une nouvelle campagne, et trier sur `updatedAt`
   *  y répondrait par « le dernier ÉDITÉ » — c'est-à-dire qu'ouvrir un vieux
   *  template pour corriger une faute de frappe le ferait devenir le défaut de
   *  toutes les campagnes suivantes, sans que personne n'ait rien créé.
   *
   *  OPTIONNEL, et c'est un TROISIÈME ÉTAT à ne pas replier : les templates
   *  enregistrés avant ce champ n'ont pas de date de création, et « je ne sais
   *  pas quand il est né » n'est pas « il est né maintenant ». `latestTemplateId`
   *  les classe donc comme les plus ANCIENS plutôt que de leur inventer une
   *  date — se tromper vers l'ancien laisse le défaut où il est, se tromper
   *  vers le récent déplacerait le référentiel de toutes les campagnes à venir. */
  readonly createdAt?: string;
}

/** Une révision ARCHIVÉE, rangée sous sa propre empreinte comme clé.
 *
 *  Pourquoi ça existe. L'empreinte posée sur un rapport le rend DISTINGUABLE
 *  d'un rapport jugé par un autre référentiel — c'est la contrainte demandée, et
 *  elle est tenue. Mais distinguable n'est pas lisible : sans archive, la
 *  première édition rend `e4e478ecd8a8` définitivement inintelligible, et la
 *  question « ce "conforme" de juillet, il portait sur quoi ? » n'a plus de
 *  réponse nulle part. La perte est SILENCIEUSE et IRRÉVERSIBLE — elle se
 *  produit à la première sauvegarde et rien ne la signale.
 *
 *  L'archive est APPEND-ONLY et clé par l'empreinte : réécrire une entrée
 *  existante y écrirait forcément le même contenu, puisque la clé est le hash de
 *  ce contenu. Une révision archivée ne peut donc pas être falsifiée par une
 *  édition ultérieure — c'est la propriété qui la rend citable. */
export interface ArchivedTemplateRevision {
  /** = `templateRevision(template)`. Clé de stockage ET empreinte : les deux
   *  doivent coïncider, et `Templates.archive` le VÉRIFIE au lieu de le croire. */
  readonly id: string;
  readonly templateId: string;
  /** Premier moment où cette révision a été VUE, pas date d'édition : une
   *  révision restaurée à l'identique garde l'horodatage de sa première
   *  apparition, parce que c'est la même révision. */
  readonly firstSeenAt: string;
  readonly template: BriefTemplate;
}

// ── Adresses de cellules (aucune écrite à la main) ────────────────────────────

/** Indice de colonne 0-based → lettre Excel (0 → A, 25 → Z, 26 → AA). */
export function colLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Adresse A1 depuis des indices 0-based. */
export function cellRef(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

export interface TemplateLayoutRow {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly kind: BriefTemplateFieldKind;
  readonly required: boolean;
  readonly translatable: boolean;
  /** Cellule du libellé, colonne FIELD. */
  readonly fieldCell: string;
  readonly descCell: string;
  readonly valueCell: string;
  /** Cellule à remplir pour chaque langue, par code de colonne. */
  readonly langCells: Readonly<Record<string, string>>;
}

export interface TemplateLayout {
  readonly sheet: string;
  readonly channel: string;
  readonly headerCells: { readonly field: string; readonly description: string; readonly value: string };
  readonly langHeaderCells: Readonly<Record<string, string>>;
  readonly rows: readonly TemplateLayoutRow[];
}

/** Nom de la feuille qui porte le brief multi-langue dans le classeur Kering. */
export const BRIEF_SHEET = "Campaign Brief";

/** Ce que `layout` lit RÉELLEMENT d'un template : sa géométrie, ses colonnes et
 *  ses champs. Ni `source`, ni `preamble`, ni `version`.
 *
 *  Nommé pour que l'écran d'édition puisse calculer les adresses d'un BROUILLON
 *  — un template en cours de composition n'a pas encore de provenance ni de
 *  version, et la seule autre issue serait de lui en inventer. Une valeur
 *  inventée pour satisfaire un type finit toujours par être lue comme un fait.
 *  `BriefTemplateData` reste assignable ici : aucun appelant existant ne bouge. */
export type TemplateGeometry = Pick<
  BriefTemplateData,
  | "channel"
  | "headerRow"
  | "fieldCol"
  | "descCol"
  | "valueCol"
  | "firstLangCol"
  | "languageColumns"
  | "fields"
>;

/** Calcule toutes les adresses A1 du template. C'est la SEULE fonction qui a le
 *  droit de produire un numéro de ligne ; la page de doc, le wizard et le
 *  générateur consomment sa sortie. */
export function layout(tpl: TemplateGeometry): TemplateLayout {
  const langHeaderCells: Record<string, string> = {};
  tpl.languageColumns.forEach((code, i) => {
    langHeaderCells[code] = cellRef(tpl.headerRow, tpl.firstLangCol + i);
  });

  const rows = tpl.fields.map((f) => {
    // Position OBSERVÉE, jamais un rang : les champs ne sont pas consécutifs
    // dans le classeur réel (ligne vide avant "Mock Up").
    const row = tpl.headerRow + f.rowOffset;
    const langCells: Record<string, string> = {};
    tpl.languageColumns.forEach((code, c) => {
      langCells[code] = cellRef(row, tpl.firstLangCol + c);
    });
    return {
      key: f.key,
      label: f.label,
      description: f.description,
      kind: f.kind,
      required: f.required,
      translatable: f.translatable,
      fieldCell: cellRef(row, tpl.fieldCol),
      descCell: cellRef(row, tpl.descCol),
      valueCell: cellRef(row, tpl.valueCol),
      langCells,
    };
  });

  return {
    sheet: BRIEF_SHEET,
    channel: tpl.channel,
    headerCells: {
      field: cellRef(tpl.headerRow, tpl.fieldCol),
      description: cellRef(tpl.headerRow, tpl.descCol),
      value: cellRef(tpl.headerRow, tpl.valueCol),
    },
    langHeaderCells,
    rows,
  };
}

// ── Génération du .xlsx vierge ────────────────────────────────────────────────

/** Contenu saisi par le métier, par clé de champ puis par code de colonne de
 *  langue tel qu'écrit au template ("MX", "ZHT"…) — jamais par code canonique :
 *  c'est précisément la distinction que canonLang détruit, et le wizard doit
 *  écrire dans la COLONNE que l'utilisateur a remplie. */
export type TemplateFill = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Construit le classeur téléchargeable DEPUIS la déclaration.
 *
 *  Sans `fill`, c'est le vierge distribué aux marques, et l'autre moitié de la
 *  boucle fermée : ce que le test regénère puis reparse doit reproduire la
 *  déclaration. Si les deux divergent, la doc affichée et le fichier distribué
 *  ne décrivent plus le même objet.
 *
 *  Avec `fill`, c'est le classeur composé par le wizard « + New campaign » à
 *  partir d'un tableau collé. Le wizard n'invente donc PAS un second format
 *  d'entrée : il produit un fichier que le parseur de production lit comme
 *  n'importe quel brief Kering, avec la même télémétrie et la même famille.
 *  Un chemin d'import parallèle aurait sa propre façon d'échouer. */
export async function buildTemplateWorkbook(tpl: BriefTemplate, fill?: TemplateFill): Promise<Buffer> {
  // Import dynamique : exceljs est lourd et purement serveur — il ne doit pas
  // entrer dans le bundle des pages qui n'affichent que le référentiel.
  const { default: ExcelJSMod } = (await import("exceljs")) as unknown as { default: typeof ExcelJS };
  const wb = new ExcelJSMod.Workbook();

  // Feuille Common : c'est d'elle que le parseur tire les langues ACTIVÉES
  // (includedLanguages), donc la langue master. L'omettre produirait un fichier
  // que le parseur lit différemment de l'original.
  const common = wb.addWorksheet("Common");
  common.getCell("B1").value = `${tpl.label} — CAMPAIGN DETAILS`;
  common.getCell("B2").value = "FIELD";
  common.getCell("C2").value = "DESCRIPTION";
  common.getCell("D2").value = "VALUE";
  common.getCell("B4").value = "Channel";
  common.getCell("C4").value = tpl.channel;
  common.getCell("D4").value = "Activate";
  common.getCell("B24").value = "INCLUDED LANGUAGES";
  tpl.languages.forEach((lang, i) => {
    common.getCell(`B${25 + i}`).value = `${lang.name} → ${lang.code}`;
    common.getCell(`C${25 + i}`).value = "Activate";
  });

  const ws = wb.addWorksheet(BRIEF_SHEET);

  // Préambule extrait, réécrit tel quel (indices 0-based → 1-based exceljs).
  for (const prow of tpl.preamble) {
    for (const cell of prow.cells) {
      ws.getCell(cellRef(prow.row, cell.col)).value = cell.value;
    }
  }

  const lay = layout(tpl);
  ws.getCell(lay.headerCells.field).value = "FIELD";
  ws.getCell(lay.headerCells.description).value = "DESCRIPTION";
  ws.getCell(lay.headerCells.value).value = "VALUE";
  for (const [code, ref] of Object.entries(lay.langHeaderCells)) {
    ws.getCell(ref).value = code;
  }

  for (const row of lay.rows) {
    const field = tpl.fields.find((f) => f.key === row.key);
    ws.getCell(row.fieldCell).value = row.label;
    if (row.description) ws.getCell(row.descCell).value = row.description;
    // La colonne VALUE porte l'exemple du vierge, mais JAMAIS quand le champ a
    // été rempli : laisser un placeholder à côté d'un contenu réel le ferait
    // relire comme une valeur du brief.
    const filled = fill?.[row.key];
    const master = filled?.[""]?.trim();
    if (master) ws.getCell(row.valueCell).value = master;
    else if (!filled && field?.master) ws.getCell(row.valueCell).value = field.master;
    if (filled) {
      for (const [code, ref] of Object.entries(row.langCells)) {
        const text = filled[code]?.trim();
        // Une cellule vide reste VIDE. Y écrire "" ou un tiret fabriquerait une
        // traduction absente qui a l'air d'une traduction fournie.
        if (text) ws.getCell(ref).value = text;
      }
    }
  }

  // Largeurs : le fichier est destiné à être rempli à la main par le métier.
  ws.getColumn(tpl.fieldCol + 1).width = 32;
  ws.getColumn(tpl.descCol + 1).width = 44;
  ws.getColumn(tpl.valueCol + 1).width = 40;
  for (let i = 0; i < tpl.languageColumns.length; i++) {
    ws.getColumn(tpl.firstLangCol + 1 + i).width = 36;
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

// ── Conformité — TROIS états ─────────────────────────────────────────────────

/** Normalisation d'un libellé pour l'appariement : casse, espaces, et suffixe
 *  parenthésé retiré. Le suffixe est ce que les marchés ajoutent librement
 *  ("Subject Line (male & others)") — c'est une DÉCLINAISON du champ, pas un
 *  champ inconnu. Même convention que le regroupement de lib/checks-code.ts. */
function normLabel(s: string): string {
  return s
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Clés sous lesquelles un champ du template peut être RECONNU dans la grille.
 *  Pour une URL, on reproduit ce que fait le parseur — il retire " URL" du
 *  libellé, où qu'il soit ("CTA 2 URL - WOMEN" → "CTA 2 - WOMEN") — au lieu
 *  d'essayer d'inverser l'opération. Inverser en recollant " URL" à la fin
 *  fabriquait "cta 2 - women url", qui ne correspondait à rien. */
export function fieldLookupKeys(f: BriefTemplateField): string[] {
  const labels = [f.label, ...(f.aliases ?? [])];
  if (f.kind !== "url") return labels.map(normLabel);
  return labels.map((l) => normLabel(l.replace(/\s+URL\b/i, " ").trim()));
}

export interface TemplateFieldGap {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
}

export interface TemplateUntranslated {
  readonly key: string;
  readonly label: string;
  /** Codes de colonne du template sans contenu (MX, ZHS…). */
  readonly missingLanguages: readonly string[];
}

/** Une cellule du brief qui satisfait PLUSIEURS champs déclarés séparément par
 *  le template (cf. `FIELD_ALIASES`). Ce n'est ni un manque ni un ajout : les
 *  deux champs sont bien là, mais la valeur est UNE — donc on ne peut pas dire
 *  qu'ils portent des contenus différents, et personne ne le saura tant que la
 *  fusion n'est pas nommée. Émis avec les DEUX états mesurés, `conformant`
 *  comme `deviation` : un brief peut n'avoir aucun écart et fusionner quand
 *  même deux champs. */
export interface TemplateSharedCell {
  /** Libellé tel qu'écrit dans le brief ("Hero Asset / CTA URL"). */
  readonly label: string;
  /** Clés des champs du template qui s'y apparient, ≥ 2. */
  readonly keys: readonly string[];
  /** Le cas MIROIR : plusieurs LIGNES du brief se sont réduites à cette même
   *  clé, parce que `normLabel` retire le qualificatif final — « Subject Line
   *  (female) » et « Subject Line (male & others) » donnent tous deux « subject
   *  line ». Renseigné avec les libellés d'origine, ≥ 2, et absent sinon.
   *
   *  Les deux cas se rejoignent sur ce qu'ils empêchent : une valeur unique
   *  n'atteste pas deux contenus distincts. Ils diffèrent par le SENS de la
   *  réduction — ici c'est le brief qui distingue et la lecture qui confond,
   *  là c'est le template qui distingue et le brief qui confond. */
  readonly sources?: readonly string[];
}

export type TemplateConformance =
  /** Le brief suit le template : tous les champs requis sont présents. */
  | {
      readonly state: "conformant";
      readonly templateVersion: number;
      /** Empreinte de la DÉCLARATION qui a rendu ce verdict. Sans elle, un
       *  « conformant » de juillet et un « conformant » de septembre sont
       *  indiscernables alors que ce n'est pas la même chose qui a été
       *  vérifiée — et personne ne peut dire lequel des deux relire.
       *  `templateVersion` ne peut pas jouer ce rôle : c'est un ordinal posé à
       *  la main, qui ne bouge pas forcément quand le référentiel bouge. */
      readonly templateRevision: string;
      readonly matched: number;
      readonly sharedCells: readonly TemplateSharedCell[];
    }
  /** Écart NOMMÉ : le brief relève bien du template, il s'en écarte, et on dit
   *  précisément où. C'est ce qui déclenche l'escalade vers l'agent Translation. */
  | {
      readonly state: "deviation";
      readonly templateVersion: number;
      /** Empreinte de la DÉCLARATION qui a rendu ce verdict. Sans elle, un
       *  « conformant » de juillet et un « conformant » de septembre sont
       *  indiscernables alors que ce n'est pas la même chose qui a été
       *  vérifiée — et personne ne peut dire lequel des deux relire.
       *  `templateVersion` ne peut pas jouer ce rôle : c'est un ordinal posé à
       *  la main, qui ne bouge pas forcément quand le référentiel bouge. */
      readonly templateRevision: string;
      readonly matched: number;
      readonly missing: readonly TemplateFieldGap[];
      readonly extra: readonly string[];
      readonly untranslated: readonly TemplateUntranslated[];
      readonly sharedCells: readonly TemplateSharedCell[];
      /** Langues du template que canonLang CONFOND avec une jumelle (MX→ES,
       *  ZHS/ZHT→ZH) : leur couverture n'est pas mesurable, elle n'est donc pas
       *  comptée manquante. Restreint aux langues activées par la campagne. */
      readonly ambiguousLanguages: readonly string[];
      /** Langues que la plateforme ne sait pas porter DU TOUT — canonLang ne
       *  les résout pas, ou le code obtenu est absent de LANG_LABEL, et le
       *  parseur les écarte alors sans trace (brief-grid.ts:237). Nommées
       *  indépendamment de l'activation : elles ne pourront jamais être
       *  vérifiées, pour AUCUNE campagne. Un silence permanent doit être dit
       *  une fois, pas se confondre chaque fois avec un brief complet. */
      readonly unsupportedLanguages: readonly string[];
    }
  /** Le template ne GOUVERNE pas ce brief. Le brief reste analysé ; aucun
   *  verdict de conformité n'est rendu contre une spec qui ne s'y applique pas.
   *  N'escalade PAS : un inconnu n'est pas un écart. */
  | {
      readonly state: "not_applicable";
      readonly templateVersion: number;
      /** Empreinte de la DÉCLARATION qui a rendu ce verdict. Sans elle, un
       *  « conformant » de juillet et un « conformant » de septembre sont
       *  indiscernables alors que ce n'est pas la même chose qui a été
       *  vérifiée — et personne ne peut dire lequel des deux relire.
       *  `templateVersion` ne peut pas jouer ce rôle : c'est un ordinal posé à
       *  la main, qui ne bouge pas forcément quand le référentiel bouge. */
      readonly templateRevision: string;
      /** POURQUOI, sous forme de valeur et non de phrase. Quatre causes qui se
       *  replient toutes sur « pas de verdict » mais ne disent pas la même
       *  chose, et qu'un lecteur en aval doit pouvoir distinguer sans relire un
       *  `reason` rédigé en anglais :
       *  - `other_family`      : le fichier a une autre mise en page (CONSTAT) ;
       *  - `no_field_matched`  : bonne famille, autre section (CONSTAT) ;
       *  - `family_unknown`    : la famille n'a pas été mesurée (AVEU) ;
       *  - `layout_unreadable` : le parseur n'a reconnu AUCUNE mise en page (AVEU).
       *  Distinguer par la phrase seule laisserait la distinction mourir au
       *  premier reformulage.
       *
       *  Les deux aveux n'admettent pas la même chose et doivent se compter
       *  séparément : `family_unknown` dit « j'ignore si ces règles
       *  s'appliquaient » (la campagne est simplement antérieure à la mesure de
       *  famille), `layout_unreadable` dit « je n'ai rien su lire de ce
       *  fichier ». Le second est plus grave : il ne se résorbe pas tout seul
       *  avec le temps, il désigne un classeur que la QA n'ouvre pas.
       *
       *  `layout_unreadable` a été séparé de `other_family` le 03/09/2026 :
       *  `none` n'est pas une famille reconnue, c'est le repli du parseur quand
       *  il n'a rien lu (`emptyTelemetry`, brief-grid.ts:255, valeur initiale
       *  de la télémétrie à :463). Le ranger sous « autre mise en page » faisait
       *  écrire un CONSTAT là où la mesure ne portait qu'un AVEU — et les deux
       *  ne se lisent pas pareil : un constat clôt la question, un aveu la
       *  garde ouverte. Personne ne rouvre un fichier dont on lui a dit qu'il
       *  avait simplement une autre mise en page. */
      readonly cause:
        | "other_family"
        | "family_unknown"
        | "no_field_matched"
        | "layout_unreadable";
      readonly reason: string;
    };

export interface ValidateOptions {
  /** Famille détectée par le parseur (BriefParseTelemetry.family). Sans elle on
   *  ne peut pas distinguer « écart » de « hors périmètre » — et un inconnu
   *  présenté comme un écart est un faux qui a l'air d'une mesure. */
  readonly family?: "field_value" | "grid" | "none";
}

/** Compare une grille au template. Ne juge RIEN sur le contenu rédigé : la
 *  présence, l'ordre et la couverture sont des comparaisons de structures,
 *  reproductibles et gratuites. Le jugement (fidélité d'une traduction, registre
 *  de marque) est le travail d'un agent, en escalade sur le résultat d'ici. */
export function validateAgainstTemplate(
  grid: BriefGrid,
  tpl: BriefTemplate,
  opts: ValidateOptions = {}
): TemplateConformance {
  // Famille NON MESURÉE : ce sera l'état de toute campagne importée avant que
  // `briefFamily` n'existe. Mesurer quand même produirait, sur un ancien brief
  // de famille `grid`, les 10 écarts fabriqués mesurés sur bal-newsletter-grid.
  // Se replier sur « autre famille » donnerait la même VALEUR d'arrivée avec un
  // sens faux : ce serait fabriquer un constat à partir d'une date d'import.
  if (!opts.family) {
    return {
      state: "not_applicable",
      templateVersion: tpl.version,
      templateRevision: templateRevision(tpl),
      cause: "family_unknown",
      reason: `Brief layout was not measured for this campaign — no conformance verdict is issued against ${tpl.label}.`,
    };
  }
  // `none` AVANT le test générique : ce n'est pas une famille, c'est le repli du
  // parseur quand il n'a reconnu aucune mise en page. Le laisser tomber dans la
  // branche ci-dessous rendrait `other_family` — donc une phrase qui affirme que
  // le fichier a une AUTRE mise en page, là où la seule chose mesurée est qu'on
  // n'en a lu aucune. L'ordre des deux `if` porte ici tout le sens.
  if (opts.family === "none") {
    return {
      state: "not_applicable",
      templateVersion: tpl.version,
      templateRevision: templateRevision(tpl),
      cause: "layout_unreadable",
      reason: `No brief layout could be read from this file — it was not compared against ${tpl.label}. The file may be empty, on an unexpected sheet, or in a format the parser does not recognise.`,
    };
  }
  if (opts.family !== "field_value") {
    return {
      state: "not_applicable",
      templateVersion: tpl.version,
      templateRevision: templateRevision(tpl),
      cause: "other_family",
      reason: `Brief layout "${opts.family}" is outside the canonical template (${tpl.label}).`,
    };
  }

  // Index des libellés observés : les blocs, plus les liens attendus ramenés à
  // leur libellé de champ (le parseur leur a retiré le suffixe " URL").
  const seen = new Map<
    string,
    { label: string; valueByLang: Record<string, string>; sources: string[] }
  >();
  for (const b of grid.blocks) {
    const key = normLabel(b.name);
    const deja = seen.get(key);
    if (!deja) {
      seen.set(key, { label: b.name, valueByLang: { ...b.valueByLang }, sources: [b.name] });
      continue;
    }
    // FUSION, et non écrasement. `normLabel` retire le qualificatif final, si
    // bien que « Subject Line (female) » et « Subject Line (male & others) »
    // tombent sur la même clé. Un `set` rendait alors la DERNIÈRE ligne lue, et
    // le verdict basculait avec l'ordre des lignes du classeur : mesuré sur
    // mx-guadalajara.xlsm, 7 blocs se réduisaient à 5 clés, et déplacer les deux
    // lignes de sujet suffisait à faire apparaître ou disparaître un manque.
    // Une mesure qui dépend de l'ordre des lignes n'est pas une mesure.
    //
    // On garde la valeur NON VIDE, d'où qu'elle vienne : la question posée ici
    // est « ce champ est-il renseigné pour cette langue ? », et une ligne
    // remplie y répond oui quel que soit son rang. Ce que la fusion ne peut pas
    // faire, c'est trancher entre deux valeurs non vides différentes — elle ne
    // le prétend pas non plus, `sources` le dit en sortie.
    deja.sources.push(b.name);
    for (const [lang, v] of Object.entries(b.valueByLang)) {
      if (!deja.valueByLang[lang]?.trim() && v?.trim()) deja.valueByLang[lang] = v;
    }
  }
  for (const l of grid.expectedLinks) {
    if (!l.block) continue;
    const key = normLabel(l.block);
    if (!seen.has(key)) {
      seen.set(key, { label: `${l.block} URL`, valueByLang: {}, sources: [`${l.block} URL`] });
    }
  }

  // Langues visées : codes du template ramenés à leur forme canonique, parce
  // que c'est sous cette forme que la grille les stocke.
  // RESTREINTES aux langues réellement ACTIVÉES pour la campagne (grid.languages,
  // lu de la feuille Common par includedLanguages, brief-grid.ts:219-240).
  //
  // Sans cette restriction, la liste du template sert de dénominateur à une
  // absence qui ne la concerne pas : le brief Guadalajara ne vise que le
  // Mexique, et se voyait reprocher EN, IT, FR, PT, JP, KO et TH — sept trous
  // FABRIQUÉS par champ, sur un brief complet. Le template ÉNUMÈRE les langues
  // possibles, il ne les exige pas toutes. La population à laquelle on compare
  // une absence est celle que la campagne a activée, pas celle du catalogue.
  const activated = new Set(grid.languages);
  const canonByCode = new Map<string, string>();
  // Colonnes que la plateforme ne peut PAS porter : un code déclaré au template
  // qu'aucun catalogue ne connaît. `canonColumn` rend `null`, la colonne
  // n'arrive alors jamais dans la grille, et sans cet aveu son absence
  // ressemblerait à une campagne qui ne vise pas ce marché.
  //
  // Sur le template LIVRÉ, cette liste est vide depuis le 2026-09-04 : TH en
  // était le seul cas réel, et il a été réparé (ajouté à LANG_LABEL) plutôt que
  // seulement nommé. Le mécanisme reste, parce que les templates sont
  // maintenant ÉDITABLES : quelqu'un peut déclarer "SV" demain, et il doit
  // l'apprendre par cet aveu et non par une colonne qui s'évapore.
  const unsupportedLanguages: string[] = [];
  for (const code of tpl.languageColumns) {
    const canon = canonColumn(code);
    if (!canon) {
      unsupportedLanguages.push(code);
      continue;
    }
    if (activated.has(canon)) canonByCode.set(code, canon);
  }
  // Deux codes déclarés qui retombent sur la MÊME clé de colonne. « X
  // manquant » serait alors indistinguable de « X écrasé par son jumeau », et
  // on NOMME l'ambiguïté au lieu de rendre un manque qu'on ne sait pas mesurer :
  // un instrument muet ne prouve pas une absence.
  //
  // Ce template en portait deux (ZHS+ZHT → ZH, ES+MX → ES) parce que la clé
  // était la LANGUE. Depuis que la clé est le code DÉCLARÉ, elles ont disparu
  // et la liste est vide sur le livré. Le mécanisme reste utile aux templates
  // édités : "JP" et "JA" déclarés côte à côte retombent toujours sur "JA".
  const canonCounts = new Map<string, number>();
  for (const canon of canonByCode.values()) canonCounts.set(canon, (canonCounts.get(canon) ?? 0) + 1);
  const ambiguousLanguages = [...canonByCode.entries()]
    .filter(([, canon]) => (canonCounts.get(canon) ?? 0) > 1)
    .map(([code]) => code);
  const ambiguousSet = new Set(ambiguousLanguages);

  const missing: TemplateFieldGap[] = [];
  const untranslated: TemplateUntranslated[] = [];
  const matchedKeys = new Set<string>();
  // Clé observée → clés de champs du template qui s'y apparient. Un alias
  // partagé (FIELD_ALIASES) fait légitimement tomber deux champs sur la même
  // entrée ; on l'ENREGISTRE au lieu de le laisser passer, sans quoi la fusion
  // disparaîtrait exactement comme le faisait le faux reproche qu'elle remplace.
  const fieldsByCell = new Map<string, string[]>();
  let matched = 0;

  for (const f of tpl.fields) {
    if (f.kind === "meta") continue;
    const hitKey = fieldLookupKeys(f).find((c) => seen.has(c));
    if (!hitKey) {
      if (f.required) missing.push({ key: f.key, label: f.label, required: true });
      continue;
    }
    matched++;
    matchedKeys.add(hitKey);
    fieldsByCell.set(hitKey, [...(fieldsByCell.get(hitKey) ?? []), f.key]);
    if (!f.translatable) continue;

    const values = seen.get(hitKey)?.valueByLang ?? {};
    const missingLanguages = [...canonByCode.entries()]
      .filter(([code, canon]) => !ambiguousSet.has(code) && !values[canon]?.trim())
      .map(([code]) => code);
    if (missingLanguages.length > 0) {
      untranslated.push({ key: f.key, label: f.label, missingLanguages });
    }
  }

  // Champs présents dans le brief et absents du template : signalés, JAMAIS
  // retirés — un marché qui ajoute une ligne n'est pas en faute, mais l'écart
  // doit être visible plutôt que silencieusement absorbé.
  const extra = [...seen.entries()]
    .filter(([key]) => !matchedKeys.has(key))
    .map(([, v]) => v.label);

  // AUCUN champ du template reconnu ⟹ le template ne gouverne pas ce brief.
  //
  // Ce n'est pas une commodité, c'est un contrôle positif : sans un seul point
  // d'ancrage, « ce brief est faux sur toute la ligne » et « ce n'est pas le
  // sujet » sont indistinguables — et l'un des deux est une mesure fabriquée.
  // Cas réel : bal-stj-fieldvalue.xlsm est bien de famille field_value, mais sa
  // première section est le canal TASK (le parseur s'arrête au CHANNEL_BREAK
  // suivant, brief-grid.ts:321-331). Il rendait 13 champs requis « manquants »
  // et 2 « en trop » sur un brief de production parfaitement valide — un faux
  // qui a exactement la forme d'une mesure réussie, donc racontable, donc
  // escaladé pour rien vers un agent qui le rejugerait contre la mauvaise spec.
  if (matched === 0) {
    return {
      state: "not_applicable",
      templateVersion: tpl.version,
      templateRevision: templateRevision(tpl),
      cause: "no_field_matched",
      reason: `No field of ${tpl.label} was recognised in this brief — it does not describe the ${tpl.channel} channel.`,
    };
  }

  // Cellules qui portent plusieurs champs. NON comptées comme un écart : les
  // champs sont présents. C'est une réserve sur la MESURE — une valeur unique
  // ne peut pas attester deux contenus distincts — pas un reproche au brief.
  // Deux réductions distinctes, une seule réserve. `keys.length > 1` : le
  // template distingue deux champs que le brief tient dans une cellule.
  // `sources.length > 1` : le brief distingue deux lignes que la lecture
  // confond. La seconde n'apparaissait nulle part — elle se réglait en silence
  // en gardant la dernière ligne lue.
  const sharedCells: TemplateSharedCell[] = [...fieldsByCell.entries()]
    .map(([cellKey, keys]) => {
      const sources = seen.get(cellKey)?.sources ?? [];
      return {
        label: seen.get(cellKey)?.label ?? cellKey,
        keys,
        ...(sources.length > 1 ? { sources } : {}),
      };
    })
    .filter((s) => s.keys.length > 1 || (s.sources?.length ?? 0) > 1);

  if (missing.length === 0 && untranslated.length === 0 && extra.length === 0) {
    return {
      state: "conformant",
      templateVersion: tpl.version,
      templateRevision: templateRevision(tpl),
      matched,
      sharedCells,
    };
  }
  return {
    state: "deviation",
    templateVersion: tpl.version,
    templateRevision: templateRevision(tpl),
    matched,
    missing,
    extra,
    untranslated,
    sharedCells,
    ambiguousLanguages,
    unsupportedLanguages,
  };
}
