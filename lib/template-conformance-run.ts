// Quelle LIGNE de rapport écrire quand le contrôle de conformité au template
// REFUSE de juger — et lesquelles de ses raisons sont des AVEUX.
//
// Pas « ses trois raisons » : elles étaient trois, elles sont quatre depuis le
// 03/09 à 14:55, et c'est précisément ce comptage écrit en dur qui a laissé la
// quatrième se ranger du mauvais côté. Un nombre recopié dans un commentaire
// vieillit sans prévenir ; la liste qui fait foi est celle de brief-template.ts.
//
// Extrait de lib/analyze.ts parce qu'aucune suite n'EXÉCUTE analyze.ts : les
// fichiers de test qui le nomment le lisent en TEXTE et lui passent une regex,
// ce qui prouve qu'une ligne a été ÉCRITE et jamais qu'elle rend juste.
//
// ⚠️ La raison qu'on en donnait était FAUSSE, et je l'avais recopiée ici :
// « importer analyze.ts tire Azure, Playwright et les clients LLM au
// chargement ». Mesuré le 03/09 à 14:49 (sonde hors dépôt, avec témoin négatif
// sur un chemin inexistant) : `./store`, `./agents` et `./render-real`
// s'importent tous les trois SANS ERREUR, et `import(analyze.ts)` rend ses
// exports. Ce qui coûte, c'est d'APPELER `analyze()` — store, réseau, rendus —
// pas de le charger. L'extraction reste la bonne décision, mais pour la vraie
// raison : ici la décision s'appelle avec deux arguments et zéro montage.
//
// Ce que cette fonction décide n'est pas cosmétique : elle choisit entre un
// AVEU (des règles actives sont restées sans juge, on les NOMME) et un CONSTAT
// (le template ne gouverne pas ce brief, ces règles sont hors sujet). Se
// tromper de branche produit soit une alarme « règles non vérifiées » sur un
// brief hors périmètre — le bruit qui apprend au métier à ignorer l'encadré —
// soit un silence sur des règles réellement non lues.
//
// Elle ne fait QUE décider. Le journal et l'événement SSE restent chez
// l'appelant : une fonction qui écrirait aussi redeviendrait intestable.

import { RULE_CATALOG } from "./rule-catalog";
import type { TemplateConformance } from "./brief-template";
import type { ResolvedRuleConfig } from "./rule-config";
import type { AgentRun } from "./types";

/** DÉRIVÉE du type de brief-template.ts, jamais recopiée : une liste de causes
 *  écrite à la main ici resterait à trois membres pendant que l'autre en aurait
 *  quatre, et le `switch` ci-dessous croirait couvrir ce qu'il ne couvre plus. */
type NotApplicableCause = Extract<TemplateConformance, { state: "not_applicable" }>["cause"];

/** `undefined` plutôt qu'un tableau vide dans AgentRun.unverifiedRuleIds : une
 *  liste vide écrite dans le rapport se lit « on a regardé, il n'y a rien »,
 *  alors qu'ici les deux cas se confondent — aucun agent concerné, ou aucune
 *  règle active. Le champ absent laisse l'écran muet au lieu de le faire parler. */
export const nonEmpty = (ids: string[]): string[] | undefined =>
  ids.length > 0 ? ids : undefined;

/** Le couplage RÉEL entre ces règles et le contrôle : elles tirent leur verdict
 *  de `validateAgainstTemplate`, et le catalogue le déclare. Sélectionner par
 *  cette `source` plutôt que par un préfixe d'identifiant ou une liste recopiée
 *  fait qu'une cinquième règle branchée là demain sera prise sans que personne
 *  n'y pense — et qu'une règle qui quitte le contrôle en sortira toute seule. */
const TEMPLATE_RULE_SOURCE = "lib/brief-template.ts:validateAgainstTemplate";

/** Clé HORS `agent-catalog`, et ce n'est pas une valeur inventée pour faire
 *  passer un test : `translation` fait déjà exactement ça — lib/analyze.ts
 *  pousse une ligne `skipped` portant `key: "translation"`, et
 *  unverified-rules.test.ts épingle que `AGENT_KEYS` ne le contient PAS. Le
 *  champ IDENTIFIE la ligne, il ne l'inscrit pas au catalogue : les gardes
 *  `AGENT_KEYS` portent toutes sur le ROUTAGE des règles (rule-config.ts:225
 *  et :533, agents.ts:423), jamais sur `AgentRun.key`.
 *
 *  Ne PAS « réparer » en ajoutant cette clé à `AGENT_CHOICES` : elle
 *  deviendrait une cible de routage dans /rules, et une règle écrite à la main
 *  qu'on lui confierait serait enregistrée, affichée « On », et n'entrerait
 *  dans aucun prompt — la raison mot pour mot de l'exclusion de `translation`,
 *  documentée en tête d'agent-catalog.ts. Ne pas « réparer » non plus en
 *  réutilisant `key: "brief"` : `brief` est un vrai worker, et cette ligne
 *  `skipped` affirmerait qu'il a été sauté alors qu'il a tourné dans la même
 *  analyse. */
export const TEMPLATE_RUN_KEY = "template";

/** AVEU ou CONSTAT, et la phrase qui va avec — décidés au même endroit pour
 *  qu'ils ne puissent pas diverger. Un `switch` et non un ternaire sur
 *  `family_unknown` : le ternaire était TOTAL sur l'union, donc l'ajout de
 *  `layout_unreadable` (03/09, 14:55) s'est rangé en SILENCE dans la branche
 *  constat. Mesuré le 03/09 à 14:58, avec témoin positif et témoin négatif :
 *  `layout_unreadable` rendait « template hors périmètre pour ce brief » et
 *  0 règle non vérifiée — soit l'aveu que brief-template.ts déclare le PLUS
 *  GRAVE des deux, publié comme une question close. `tsc --noEmit` était vert :
 *  aucun outil ne pouvait le voir, c'est pour ça que la garde est ici.
 *
 *  Les deux aveux ne se confondent pas non plus entre eux : `family_unknown`
 *  se résorbe seul (la campagne est antérieure à la mesure de famille),
 *  `layout_unreadable` désigne un classeur que la QA n'ouvre pas et ne se
 *  résorbera jamais tout seul. La phrase doit donc les distinguer à l'écran. */
function decideCause(cause: NotApplicableCause): { aveu: boolean; prefixe: string } {
  switch (cause) {
    case "family_unknown":
      return { aveu: true, prefixe: "conformité au template NON mesurée" };
    case "layout_unreadable":
      // « par l'analyse déterministe » n'est pas une précaution de style : dans
      // le seul chemin qui produit cette cause aujourd'hui, une grille EST
      // affichée à côté de ce message — le scout LLM l'a écrite
      // (brief-scout-job.ts, `if (!fresh.briefGrid) fresh.briefGrid = res.grid`)
      // sans jamais retoucher `briefFamily`. « Aucune disposition lue » tout
      // court se lirait alors comme une contradiction avec l'écran, et c'est
      // l'écran qui gagnerait l'arbitrage : le lecteur conclurait que l'avertis-
      // sement se trompe. Nommer l'INSTRUMENT qui s'est tu rend les deux
      // lisibles ensemble — la grille existe, aucune lecture ne l'a produite.
      //
      // Le qualificatif reste vrai si ce chemin disparaît : `briefFamily` n'est
      // écrit qu'à un seul endroit, `app/api/campaigns/[id]/brief/route.ts:149`,
      // depuis la télémétrie du parseur déterministe. `none` signifie donc
      // toujours « le parseur déterministe n'a rien reconnu », quel que soit ce
      // qui a rempli la grille ensuite. On borne l'instrument, on n'affirme pas
      // une absence dans le monde.
      return {
        aveu: true,
        prefixe:
          "aucune disposition de brief lue par l'analyse déterministe — conformité au template NON mesurée",
      };
    case "other_family":
    case "no_field_matched":
      return { aveu: false, prefixe: "template hors périmètre pour ce brief" };
    default: {
      // À la COMPILATION : une cinquième cause casse le build sur cette ligne,
      // au lieu de se ranger sans bruit dans le constat comme la quatrième l'a
      // fait. À l'EXÉCUTION : un rapport ancien peut porter une cause que ce
      // code ne connaît pas — l'inconnu est GARDÉ du côté de l'aveu et NOMMÉ,
      // jamais absous. Se replier sur « hors périmètre » referait exactement le
      // défaut que cette fonction vient de corriger.
      const inconnue: never = cause;
      return {
        aveu: true,
        prefixe: `conformité au template NON mesurée (cause non reconnue : ${String(inconnue)})`,
      };
    }
  }
}

/** La ligne à pousser dans `report.agents`, ou `null` s'il n'y a rien à dire.
 *
 *  `null` couvre DEUX situations qui doivent rester muettes et ne se
 *  confondent pas avec un troisième cas : le contrôle n'a pas tourné
 *  (`tc === null`, pas de grille de brief), ou il a jugé — `conformant` et
 *  `deviation` produisent des findings ailleurs, et une ligne d'agent en plus
 *  ferait raconter deux fois la même mesure. */
export function templateConformanceRun(
  tc: TemplateConformance | null,
  ruleConfig: ResolvedRuleConfig
): AgentRun | null {
  if (!tc || tc.state !== "not_applicable") return null;

  const sourced = RULE_CATALOG.filter((r) => r.source === TEMPLATE_RULE_SOURCE);
  // TROIS états, pas deux. Une liste vide peut vouloir dire « ces règles sont
  // éteintes dans /rules » (hors périmètre CHOISI, à ne pas compter comme non
  // vérifié) ou « mon sélecteur ne trouve plus rien » (instrument cassé). Les
  // confondre rendrait un silence d'instrument pour une mesure.
  const selectorBroken = sourced.length === 0;
  const active = sourced.filter((r) => ruleConfig.enabled(r.id)).map((r) => r.id);

  // Un AVEU laisse des règles sans juge, et on les NOMME. Un CONSTAT dit que le
  // template ne gouverne pas ce brief : ces règles sont hors sujet et non « non
  // vérifiées » — les lister serait la même faute que compter une règle
  // volontairement éteinte. La classe est décidée par `decideCause`, pas ici,
  // pour qu'une cause ajoutée demain ne puisse pas être aveu dans la phrase et
  // constat dans le décompte.
  const { aveu, prefixe } = decideCause(tc.cause);
  const unverified = aveu && !selectorBroken ? active : [];

  const detail = aveu
    ? `${prefixe} — ${tc.reason}${
        selectorBroken ? " (règles concernées non identifiables : sélecteur de catalogue muet)" : ""
      }`
    : `${prefixe} — ${tc.reason}`;

  return {
    agent: "Conformité au template",
    key: TEMPLATE_RUN_KEY,
    status: "skipped",
    detail,
    // `nonEmpty` et non un ternaire : tout ce qui entre dans ce champ passe par
    // lui, sans exception, pour qu'une liste VIDE ne puisse jamais être écrite
    // — `[]` se lirait « on a regardé, rien à signaler ».
    unverifiedRuleIds: nonEmpty(unverified),
  };
}
