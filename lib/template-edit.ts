// Édition et création de templates de brief : ce qui est ACCEPTÉ, ce qui est
// REFUSÉ, et ce qui est accepté en le DISANT.
//
// Pourquoi ce fichier existe séparément de brief-template.ts : ce dernier
// décrit un référentiel et le fait juger. Ici on décide qui a le droit de
// devenir un référentiel. Les deux se relisent mal ensemble — et surtout, un
// template invalide n'est pas une erreur de saisie parmi d'autres : c'est un
// instrument de mesure faussé qui rendra des verdicts d'apparence normale sur
// toutes les campagnes suivantes. Le coût d'un refus est une minute pour le
// métier ; le coût d'une acceptation est une série de faux qu'aucun test ne
// verra passer.
//
// AUCUNE dépendance au stockage ni à Node : ce module est importé PAR L'ÉCRAN
// d'édition autant que par le serveur, pour que la page refuse exactement ce que
// l'API refuse. Deux validations parallèles divergent, et la divergence se
// manifeste de la pire façon : un formulaire qui se remplit et ne se sauve pas,
// ou pire, l'inverse. Ce qui a besoin du store vit dans lib/template-resolve.ts.
//
// Doctrine des trois états, appliquée à la validation :
//   - ERREUR  : le template ne peut pas mesurer, on refuse d'enregistrer.
//   - AVERTISSEMENT : il peut mesurer, mais un lecteur doit savoir quoi.
//   - silence : rien à signaler — et ce silence n'est jamais celui d'un
//     contrôle qui n'a pas tourné (cf. `checkedCount`).

import { z } from "zod";
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_ID, fieldLookupKeys, templateRevision } from "./brief-template";
import type { BriefTemplate, BriefTemplateField, StoredBriefTemplate } from "./brief-template";
import { canonColumn } from "./lang-codes";
import { GLOSSARY_MAX_CHARS, GLOSSARY_NOTE_MAX_CHARS } from "./glossary";

/** Bornes de saisie. Elles vivent ici et sont exportées pour que l'écran borne
 *  la SAISIE avec les mêmes nombres que le serveur borne l'ENREGISTREMENT — une
 *  recopie divergente rendrait un formulaire qui se remplit et ne se sauve pas. */
export const TEMPLATE_LABEL_MAX = 80;
export const TEMPLATE_FIELD_MAX = 120;
export const TEMPLATE_LANG_MAX = 40;
export const TEMPLATE_ALIAS_MAX = 8;
/** Même famille que SAFE_TEXT_RE de rule-config : ni caractères de contrôle, ni
 *  chevrons. Ces libellés sont rendus dans la page ET écrits dans un classeur
 *  distribué aux marques. */
const SAFE_TEXT_RE = /^[^\u0000-\u001f<>]+$/;
/** Une clé de champ est un CONTRAT : elle voyage dans les rapports. On la borne
 *  à un identifiant, pas à du texte libre, pour qu'elle reste citable telle
 *  quelle dans un message d'erreur ou une URL. */
const FIELD_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Un code de colonne de langue tel qu'écrit en en-tête ("EN", "ZHT", "MX"). */
const LANG_CODE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,9}$/;

/** Texte de GLOSSAIRE : de la prose, donc les retours à la ligne sont admis —
 *  et rien d'autre des caractères de contrôle. Les chevrons restent interdits
 *  comme partout ailleurs, et ici la raison est précise : ce texte part dans le
 *  prompt des agents entre `<brief_glossary>` et `</brief_glossary>`. Laisser
 *  passer `<` permettrait d'écrire soi-même la balise fermante, donc de sortir
 *  du bloc de données et de faire lire la suite comme une consigne.
 *
 *  Les `\r` sont normalisés AVANT le contrôle : un presse-papiers Windows en
 *  livre, et refuser un collage pour un caractère invisible serait un refus
 *  juste dont le message ne dirait rien de la cause. */
// Tout le contrôle SAUF U+000A (le saut de ligne), plus les chevrons.
const CONTROL_OR_ANGLE_RE = /[\u0000-\u0009\u000b-\u001f<>]/;
const glossaryText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(/\r\n?/g, "\n"))
    .refine(
      (s) => !CONTROL_OR_ANGLE_RE.test(s),
      "A glossary cannot contain < or > (they would break out of the block sent to the agents)."
    );

const FieldSchema = z.object({
  key: z.string().regex(FIELD_KEY_RE),
  label: z.string().trim().min(1).max(TEMPLATE_LABEL_MAX).regex(SAFE_TEXT_RE),
  description: z.string().max(400).regex(SAFE_TEXT_RE).or(z.literal("")).default(""),
  master: z.string().max(400).default(""),
  rowOffset: z.number().int().min(1).max(500),
  kind: z.enum(["text", "url", "meta"]),
  required: z.boolean(),
  translatable: z.boolean(),
  aliases: z
    .array(z.string().trim().min(1).max(TEMPLATE_LABEL_MAX).regex(SAFE_TEXT_RE))
    .max(TEMPLATE_ALIAS_MAX)
    .optional(),
  /** Note de glossaire de la LIGNE : ce que ce champ veut dire chez ce client.
   *  Optionnelle, et l'absence n'est pas le vide — cf. lib/glossary.ts, qui
   *  n'annonce aux agents que les notes réellement écrites. */
  note: glossaryText(GLOSSARY_NOTE_MAX_CHARS).optional(),
});

const LanguageSchema = z.object({
  code: z.string().regex(LANG_CODE_RE),
  name: z.string().trim().min(1).max(TEMPLATE_LABEL_MAX).regex(SAFE_TEXT_RE),
  /** Note de glossaire de la COLONNE : le marché, le registre, ce qui distingue
   *  ce code d'un voisin qui lui ressemble (MX vs ES). */
  note: glossaryText(GLOSSARY_NOTE_MAX_CHARS).optional(),
});

/** Ce qu'une requête d'écriture a le droit de contenir.
 *
 *  `version`, `updatedAt` et la révision ne sont PAS acceptés du client : ce
 *  sont des faits d'enregistrement, posés par le serveur. Une révision fournie
 *  par l'appelant serait une déclaration, plus une preuve — exactement ce qui la
 *  viderait de sa fonction. */
export const TemplateWriteSchema = z.object({
  label: z.string().trim().min(1).max(TEMPLATE_LABEL_MAX).regex(SAFE_TEXT_RE),
  channel: z.string().trim().min(1).max(40).regex(SAFE_TEXT_RE),
  headerRow: z.number().int().min(1).max(500),
  fieldCol: z.number().int().min(0).max(200),
  descCol: z.number().int().min(0).max(200),
  valueCol: z.number().int().min(0).max(200),
  firstLangCol: z.number().int().min(0).max(200),
  languageColumns: z.array(z.string().regex(LANG_CODE_RE)).min(1).max(TEMPLATE_LANG_MAX),
  languages: z.array(LanguageSchema).max(TEMPLATE_LANG_MAX).default([]),
  fields: z.array(FieldSchema).min(1).max(TEMPLATE_FIELD_MAX),
  /** Glossaire GÉNÉRAL du référentiel, injecté dans le prompt de chaque agent. */
  glossary: glossaryText(GLOSSARY_MAX_CHARS).optional(),
  updatedBy: z.string().max(80).optional(),
  /** Clés de champ dont la DISPARITION est assumée.
   *
   *  Le contrôle 9 refuse qu'une clé s'évapore, et il a raison : les rapports
   *  rendus la citent. Mais son message dit « supprimez le champ explicitement
   *  si c'est l'intention » — une phrase qui décrivait, jusqu'ici, un geste qui
   *  n'existait pas. Quiconque cliquait sur la corbeille se retrouvait devant un
   *  enregistrement bloqué et une consigne inapplicable ; l'issue pratique était
   *  de remettre le champ, c'est-à-dire de renoncer.
   *
   *  Ce champ EST ce geste. Il ne désarme pas le contrôle : il le déplace d'un
   *  cran, du « une clé a disparu » au « CETTE clé-ci, nommément, doit
   *  disparaître ». Une suppression accidentelle bloque toujours, puisqu'elle
   *  n'est nommée nulle part. */
  removedFieldKeys: z
    .array(z.string().regex(FIELD_KEY_RE))
    .max(TEMPLATE_FIELD_MAX)
    .optional(),
  /** Version LUE par le client. Décalage = quelqu'un a enregistré entre temps :
   *  409, on ne lui écrase pas son travail en silence. Même verrou que /api/rules.
   *  Absente pour une CRÉATION — il n'y a alors rien à écraser. */
  baseVersion: z.number().int().nonnegative().optional(),
});

export type TemplateWrite = z.infer<typeof TemplateWriteSchema>;

export interface TemplateProblem {
  readonly severity: "error" | "warning";
  /** Ce qui ne va pas, en une phrase qui NOMME la valeur fautive. Un message qui
   *  dit « champ invalide » sans dire lequel oblige à deviner, et on devine mal. */
  readonly message: string;
  /** Clé de champ concernée, quand il y en a une. */
  readonly field?: string;
}

export interface TemplateCheck {
  readonly problems: readonly TemplateProblem[];
  /** Nombre de contrôles RÉELLEMENT exécutés. Sans lui, « aucun problème » et
   *  « aucun contrôle n'a tourné » se lisent pareil — un instrument muet ne
   *  disqualifie pas, mais il ne certifie pas non plus. */
  readonly checkedCount: number;
}

const has = (p: readonly TemplateProblem[]) => p.some((x) => x.severity === "error");
export const isBlocking = (c: TemplateCheck) => has(c.problems);

/** L'état antérieur À OPPOSER au contrôle 9, une fois retirées les clés dont la
 *  suppression est assumée (cf. `removedFieldKeys`).
 *
 *  Existe pour que l'ÉCRAN et le SERVEUR retirent exactement les mêmes clés. Les
 *  deux appellent `checkTemplateCoherence`, ce qui les tient déjà d'accord sur
 *  les contrôles ; sans cette fonction, ils auraient chacun leur façon de
 *  préparer l'argument, et un formulaire qui se remplit sans erreur mais refuse
 *  de s'enregistrer est le plus long à diagnostiquer de tous les défauts. */
export function withAcknowledgedRemovals<T extends Pick<BriefTemplate, "fields">>(
  prev: T | null | undefined,
  acknowledged: readonly string[] | undefined
): Pick<BriefTemplate, "fields"> | null {
  if (!prev) return null;
  if (!acknowledged || acknowledged.length === 0) return prev;
  const ack = new Set(acknowledged);
  return { fields: prev.fields.filter((f) => !ack.has(f.key)) };
}

/** Contrôles que Zod ne peut pas faire, parce qu'ils portent sur les RELATIONS
 *  entre champs et non sur chaque champ pris isolément.
 *
 *  `prev` sert au seul contrôle qui a besoin d'une histoire : le renommage de
 *  clé. Absent pour une création.
 */
export function checkTemplateCoherence(
  tpl: Pick<
    BriefTemplate,
    | "fields"
    | "languageColumns"
    | "languages"
    | "headerRow"
    | "fieldCol"
    | "descCol"
    | "valueCol"
    | "firstLangCol"
  >,
  prev?: Pick<BriefTemplate, "fields"> | null
): TemplateCheck {
  const problems: TemplateProblem[] = [];
  let checkedCount = 0;

  // 1. Clés en double. ERREUR : `fields` est consommé par clé partout (rapports,
  // réglages, remplissage du wizard). Deux champs sous la même clé, et le second
  // écrase le premier SANS RIEN LEVER — le champ disparaît de l'écran de saisie
  // tout en restant « requis » dans les verdicts.
  checkedCount++;
  const byKey = new Map<string, number>();
  for (const f of tpl.fields) byKey.set(f.key, (byKey.get(f.key) ?? 0) + 1);
  for (const [key, n] of byKey) {
    if (n > 1) {
      problems.push({
        severity: "error",
        field: key,
        message: `Two or more fields share the key "${key}" (${n} occurrences). Field keys travel into reports and settings — they must be unique.`,
      });
    }
  }

  // 2. Deux champs sur la MÊME LIGNE. ERREUR : `layout()` calcule l'adresse par
  // `headerRow + rowOffset`, donc la doc dirait au métier d'écrire deux choses
  // différentes dans la même cellule. Le classeur généré, lui, n'en écrirait
  // qu'une — et laquelle dépend de l'ordre du tableau, pas d'une décision.
  checkedCount++;
  const byRow = new Map<number, string[]>();
  for (const f of tpl.fields) byRow.set(f.rowOffset, [...(byRow.get(f.rowOffset) ?? []), f.label]);
  for (const [offset, labels] of byRow) {
    if (labels.length > 1) {
      problems.push({
        severity: "error",
        message: `Row offset ${offset} is used by ${labels.length} fields (${labels.join(", ")}). Each field needs its own row — otherwise the documented cell address would be the same for both.`,
      });
    }
  }

  // 3. Deux champs qui s'apparient au MÊME libellé de brief. AVERTISSEMENT et
  // non erreur, et c'est un arbitrage : la fusion "Hero Asset / CTA URL" du
  // template livré est EXACTEMENT ce cas, elle est délibérée, et le moteur la
  // constate déjà (`sharedCells`). En faire une erreur rendrait le template
  // livré insauvegardable dès sa première ouverture dans l'éditeur.
  checkedCount++;
  const byLookup = new Map<string, string[]>();
  for (const f of tpl.fields) {
    for (const k of fieldLookupKeys(f)) {
      byLookup.set(k, [...(byLookup.get(k) ?? []), f.key]);
    }
  }
  for (const [lookup, keys] of byLookup) {
    if (keys.length > 1) {
      problems.push({
        severity: "warning",
        message: `Fields ${keys.join(" and ")} both match the brief label "${lookup}". They will read the SAME cell, and the report will flag it as a shared cell rather than as two answers.`,
      });
    }
  }

  // 4. Colonnes qui se marchent dessus. ERREUR : une colonne FIELD égale à la
  // colonne VALUE ferait lire le libellé comme s'il était la réponse — un brief
  // vide se mesurerait « rempli ».
  checkedCount++;
  const cols: Array<[string, number]> = [
    ["FIELD", tpl.fieldCol],
    ["DESCRIPTION", tpl.descCol],
    ["VALUE", tpl.valueCol],
  ];
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      if (cols[i][1] === cols[j][1]) {
        problems.push({
          severity: "error",
          message: `Columns ${cols[i][0]} and ${cols[j][0]} are both at index ${cols[i][1]}. Each must have its own column.`,
        });
      }
    }
  }

  // 5. Les colonnes de langue ne doivent pas recouvrir les trois précédentes.
  // Elles occupent `firstLangCol … firstLangCol + languageColumns.length - 1`.
  checkedCount++;
  const lastLangCol = tpl.firstLangCol + tpl.languageColumns.length - 1;
  for (const [name, idx] of cols) {
    if (idx >= tpl.firstLangCol && idx <= lastLangCol) {
      problems.push({
        severity: "error",
        message: `Column ${name} (index ${idx}) falls inside the language block (${tpl.firstLangCol}–${lastLangCol}). The language columns would overwrite it.`,
      });
    }
  }

  // 6. Codes de langue en double. ERREUR : `layout()` construit
  // `langCells[code]` — un code répété n'a qu'une adresse, la dernière, et la
  // colonne précédente devient inatteignable à la saisie comme à la lecture.
  checkedCount++;
  const seenLang = new Set<string>();
  for (const code of tpl.languageColumns) {
    if (seenLang.has(code)) {
      problems.push({
        severity: "error",
        message: `Language column "${code}" appears more than once. Each column code addresses one cell per row, so the duplicate would be unreachable.`,
      });
    }
    seenLang.add(code);
  }

  // 7. Une langue nommée dans `languages` sans colonne. AVERTISSEMENT : le
  // classeur Kering réel déclare des libellés humains sur une feuille séparée
  // (Common), et rien n'oblige les deux listes à coïncider. Mais l'écart mérite
  // d'être dit, parce qu'il se lit à l'écran comme une langue gérée.
  checkedCount++;
  for (const l of tpl.languages) {
    if (!seenLang.has(l.code)) {
      problems.push({
        severity: "warning",
        message: `Language "${l.name}" (${l.code}) is named but has no column in the brief — it will not be checked.`,
      });
    }
  }

  // 8. Aucun champ traduisible : le template ne mesurerait AUCUNE traduction.
  // Avertissement, pas erreur — un template de canal non traduit est légitime.
  checkedCount++;
  if (!tpl.fields.some((f) => f.translatable)) {
    problems.push({
      severity: "warning",
      message: `No field is marked translatable, so no translation will ever be checked against this template.`,
    });
  }

  // 9. Renommage de clé. ERREUR : les rapports déjà rendus citent l'ancienne
  // clé, et les réglages de règles s'y accrochent. Renommer ne « corrige » pas
  // ces rapports, ça les rend orphelins en silence. Le libellé AFFICHÉ, lui, se
  // change librement — c'est toute la raison d'avoir séparé les deux.
  checkedCount++;
  if (prev) {
    const now = new Set(tpl.fields.map((f) => f.key));
    for (const f of prev.fields) {
      if (!now.has(f.key)) {
        problems.push({
          severity: "error",
          field: f.key,
          message: `Field key "${f.key}" (${f.label}) has disappeared. Keys are a contract: existing reports and rule settings reference them. Delete the field explicitly if that is the intent, but do not rename its key — change the label instead.`,
        });
      }
    }
  }

  // 10. Une colonne déclarée que la plateforme ne sait pas résoudre.
  //
  // C'EST LE CONTRÔLE QUI MANQUAIT, et il a un coût mesuré. Le template livré
  // déclarait "TH" ; aucun catalogue ne le connaissait ; `canonColumn` rendait
  // `null` ; la colonne n'arrivait donc jamais dans la grille. Un brief thaï
  // parfaitement rempli était lu VIDE — sans erreur, sans avertissement, sans
  // trace. La plateforme finissait par l'avouer (`unsupportedLanguages`), mais
  // seulement à l'analyse, campagne par campagne, longtemps après la saisie.
  //
  // Depuis que les templates sont éditables, ce défaut se crée d'un clic :
  // taper "SV" dans la colonne des langues suffit. Le dire ICI, au moment où
  // quelqu'un l'écrit, est la seule occasion où la correction est gratuite.
  //
  // AVERTISSEMENT et non erreur, délibérément. `validateAgainstTemplate` refuse
  // de bloquer sur ce cas et continue de mesurer tout le reste ; en faire une
  // erreur bloquante ici contredirait le juge et interdirait de déclarer une
  // colonne qu'on remplit à la main en attendant que la langue soit ajoutée.
  checkedCount++;
  for (const code of tpl.languageColumns) {
    if (canonColumn(code) === null) {
      problems.push({
        severity: "warning",
        message: `Language column "${code}" is not a language the platform knows. The column will be dropped when a brief is read, so nothing in it can ever be checked — fill it in by hand, or ask for the language to be added.`,
      });
    }
  }

  // 11. Deux codes différents qui désignent la MÊME colonne interne.
  //
  // Le contrôle 6 attrape "EN" écrit deux fois — la même chaîne. Il ne voit rien
  // quand les deux orthographes diffèrent : "JP" et "JA" sont deux colonnes du
  // classeur, deux adresses de cellule, et une seule colonne à la lecture. Le
  // classeur se remplit normalement ; c'est le JUGEMENT qui se tait, parce que
  // « la colonne manque » et « la colonne a été écrasée par sa jumelle »
  // deviennent indistinguables (`ambiguousLanguages`) et que le contrôle de
  // traduction s'éteint alors pour LES DEUX.
  //
  // Avertissement, pour la même raison qu'au point 10 : c'est exactement ce que
  // le juge en fait, et une erreur bloquante ici dirait le contraire de lui.
  checkedCount++;
  const parCle = new Map<string, string[]>();
  for (const code of tpl.languageColumns) {
    const cle = canonColumn(code);
    if (cle) parCle.set(cle, [...(parCle.get(cle) ?? []), code]);
  }
  for (const [cle, codes] of parCle) {
    // `> 1` sur les codes DISTINCTS : un doublon littéral est déjà une erreur au
    // point 6, et le compter ici une seconde fois ferait passer un problème pour
    // deux.
    if (new Set(codes).size > 1) {
      problems.push({
        severity: "warning",
        message: `Language columns ${codes.join(" and ")} both mean ${cle} to the platform. Only one of them can be checked, and neither will be reported as missing — check both by hand, or drop one.`,
      });
    }
  }

  // 12. Une colonne sans nom. Le pendant du contrôle 7, qui ne regarde que
  // l'autre sens. Une colonne dont personne n'a écrit le nom s'affiche comme un
  // code nu dans le tableau des langues — « MX » sans « Español (México) » à
  // côté — et le métier doit alors deviner quel marché il remplit.
  checkedCount++;
  const nommees = new Set(tpl.languages.map((l) => l.code));
  for (const code of tpl.languageColumns) {
    if (!nommees.has(code)) {
      problems.push({
        severity: "warning",
        message: `Language column "${code}" has no language name next to it. It will still be checked, but whoever fills the brief has to guess which market it is.`,
      });
    }
  }

  return { problems, checkedCount };
}

/** Construit le template à ENREGISTRER depuis une requête validée.
 *
 *  `version` s'incrémente depuis le précédent : c'est un ordinal lisible, il ne
 *  décide de rien (cf. le commentaire de `BriefTemplate.version`). Il ne doit
 *  surtout pas être DÉRIVÉ de la révision ni l'inverse — le jour où l'un se
 *  calcule depuis l'autre, la révision cesse d'être une preuve et redevient une
 *  déclaration. */
/** Le repli à TROIS ÉTATS d'un texte de glossaire.
 *
 *  `undefined` = l'appelant ne connaît pas ce champ → on garde l'antérieur.
 *  `""`        = l'appelant l'a vidé → on efface.
 *  du texte    = on écrit.
 *
 *  Sans le premier état, un écran écrit avant l'existence du glossaire
 *  effacerait à son premier enregistrement un texte saisi, lu par les agents,
 *  et personne ne verrait passer la disparition. `??` ne suffirait pas : il
 *  replierait aussi la chaîne vide, donc il rendrait le vidage IMPOSSIBLE.
 *
 *  Rend un objet à étaler (`{}` ou `{ [key]: texte }`) : la clé absente plutôt
 *  qu'une chaîne vide stockée. */
function glossaryPatch<K extends string>(
  key: K,
  written: string | undefined,
  previous: string | undefined
): Partial<Record<K, string>> {
  const chosen = written === undefined ? previous : written;
  const t = (chosen ?? "").trim();
  return t ? ({ [key]: t } as Partial<Record<K, string>>) : {};
}

export function buildStoredTemplate(
  id: string,
  write: TemplateWrite,
  prev: StoredBriefTemplate | null,
  /** Template DUPLIQUÉ pour créer celui-ci, s'il y en a un.
   *
   *  Une copie est une CRÉATION : elle prend `version: 1` et une date de
   *  naissance à elle. Reprendre `prev` à la place ferait hériter le
   *  `createdAt` de l'original, et « le dernier template créé » — la règle qui
   *  décide du référentiel de toute campagne suivante — désignerait alors un
   *  template plus vieux que sa propre copie.
   *
   *  Mais deux choses ne sont pas des faits d'enregistrement et doivent
   *  traverser : le PRÉAMBULE (les lignes décoratives du classeur, non
   *  éditables, donc irrécupérables une fois perdues) et la PROVENANCE des
   *  faits. Sans elles, un référentiel copié se présenterait comme né de rien,
   *  et le classeur qu'il génère perdrait l'en-tête que la marque reconnaît. */
  copiedFrom?: Pick<BriefTemplate, "source" | "preamble"> | null
): StoredBriefTemplate {
  const base = prev ?? (id === DEFAULT_TEMPLATE_ID ? DEFAULT_TEMPLATE : null);
  // Les notes antérieures, indexées par leur IDENTIFIANT (clé de champ, code de
  // colonne) et non par leur rang : une ligne déplacée ou insérée reclasserait
  // tout le monde, et chaque note se retrouverait posée sur le champ voisin —
  // une erreur qui se lit comme une saisie du métier, jamais comme un défaut.
  const prevFieldNote = new Map((base?.fields ?? []).map((f) => [f.key, f.note]));
  const prevLangNote = new Map((base?.languages ?? []).map((l) => [l.code, l.note]));
  return {
    id,
    // `source` décrit d'où viennent les FAITS, pas qui a cliqué : il reste celui
    // du classeur d'origine quand on édite le template livré.
    source: base?.source ?? copiedFrom?.source ?? `Created in Sentinel (${id})`,
    channel: write.channel,
    headerRow: write.headerRow,
    fieldCol: write.fieldCol,
    descCol: write.descCol,
    valueCol: write.valueCol,
    firstLangCol: write.firstLangCol,
    languageColumns: [...write.languageColumns],
    languages: write.languages.map((l) => ({
      code: l.code,
      name: l.name,
      // Même repli à trois états que le glossaire général, apparié sur le CODE
      // de la langue : un écran qui ne gère pas les notes n'efface pas celles
      // qui existent, et un écran qui les gère peut les vider.
      ...glossaryPatch("note", l.note, prevLangNote.get(l.code)),
    })),
    // Le préambule (les lignes d'en-tête décoratives du classeur) n'est pas
    // éditable à l'écran : personne ne l'a demandé et il ne change aucun
    // verdict. Conservé tel quel plutôt que perdu à la première sauvegarde.
    preamble: base?.preamble ?? copiedFrom?.preamble ?? [],
    fields: write.fields.map(
      (f): BriefTemplateField => ({
        key: f.key,
        label: f.label,
        description: f.description,
        master: f.master,
        rowOffset: f.rowOffset,
        kind: f.kind,
        required: f.required,
        translatable: f.translatable,
        ...(f.aliases && f.aliases.length > 0 ? { aliases: [...f.aliases] } : {}),
        ...glossaryPatch("note", f.note, prevFieldNote.get(f.key)),
      })
    ),
    // Le glossaire général suit la même règle : écrit s'il dit quelque chose,
    // absent sinon. `glossaryBlock` n'injecte alors AUCUN bloc, plutôt qu'un
    // bloc vide qui annoncerait au modèle « voici tout ce qu'il faut savoir »
    // avant de ne rien lui dire.
    //
    // TROIS ÉTATS, et le repli ne vaut que pour le premier :
    //   - `undefined` : l'appelant ne connaît PAS ce champ. On garde celui de
    //     l'état antérieur. Sans ça, un écran écrit avant l'existence du
    //     glossaire l'effacerait à son premier enregistrement — un texte
    //     saisi, lu par les agents, disparu sans qu'aucun message ne le dise.
    //   - `""` : l'appelant l'a VIDÉ. On l'efface, c'est une décision.
    //   - du texte : on l'écrit.
    ...glossaryPatch("glossary", write.glossary, base?.glossary),
    version: (base?.version ?? 0) + 1,
    // La date de création se REPREND du précédent quand il y en a un : une
    // édition n'est pas une naissance. Ne la reprendre que de `prev` et non de
    // `base` est délibéré — `base` peut être `DEFAULT_TEMPLATE`, le template du
    // CODE, qui n'a jamais été créé par personne et n'a pas de date.
    //
    // Et l'id `default` n'en reçoit JAMAIS : c'est l'ÉDITION du template livré,
    // pas un template créé. Lui en donner une le ferait remporter le « dernier
    // créé » à la première correction de libellé, et le référentiel par défaut
    // de toutes les campagnes suivantes basculerait sur un geste qui ne visait
    // que le sien. Il reste le repli, ce qu'il est déjà.
    ...(id === DEFAULT_TEMPLATE_ID
      ? {}
      : { createdAt: prev?.createdAt ?? new Date().toISOString() }),
    updatedAt: new Date().toISOString(),
    ...(write.updatedBy ? { updatedBy: write.updatedBy } : {}),
    label: write.label,
  };
}
