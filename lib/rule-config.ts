// Configuration des règles éditable depuis /rules (page de config).
//
// Modèle "overlay" : on ne stocke que les ÉCARTS par rapport aux défauts du
// code (lib/rule-catalog.ts + lib/checks-code.ts). Conséquence directe : une
// règle qui évolue dans le code n'a pas besoin d'être re-saisie ici, et la
// config ne peut pas devenir périmée.
//
// SÉCURITÉ — trois interdits assumés, cf. audit :
//  1. AUCUNE regex saisie par l'utilisateur (ReDoS) : les listes de mots sont
//     échappées avant toute construction de motif ;
//  2. AUCUNE expression évaluée (pas de vm2 / expr-eval / eval) ;
//  3. les règles écrites en langage naturel sont des DONNÉES, jamais des
//     instructions : elles partent dans le message UTILISATEUR du worker,
//     encadrées par des délimiteurs (cf. lib/agents.ts).

import crypto from "crypto";
import { z } from "zod";
import {
  CUSTOM_CATEGORY_LABEL_MAX,
  CUSTOM_CATEGORY_MAX,
  CUSTOM_RULE_MAX,
  CUSTOM_RULE_MAX_CHARS,
  CUSTOM_RULE_TITLE_MAX,
  FAMILY_LABELS,
  RULE_DESCRIPTION_MAX,
  RULE_EXAMPLES_MAX,
  RULE_EXAMPLE_MAX_CHARS,
  RULE_LABEL_MAX,
  SEVERITY_LABELS,
  effectiveDescription,
  effectiveLabel,
} from "./rule-catalog";
import { ALL_RULE_BY_ID } from "./rule-registry";
// Sans dépendances : l'importer n'inverse rien et ne fait entrer aucun module
// serveur ici. Voir le commentaire de validateAgainstCatalog.
import { AGENT_KEYS, GUIDELINES_AGENT_KEY } from "./agent-catalog";
import type { AdjustableSeverity, RuleCatalogEntry } from "./rule-catalog";
import type { BrandRule, Severity } from "./types";

/** Valeurs qu'un paramètre peut prendre, une par `kind` de RuleParamSpec :
 *  int → number, terms → string[], int-list → number[], boolean → boolean. */
export type ParamValue = number | string[] | number[] | boolean;

/** Exemple concret attaché à une règle. "ko" = ce que la règle doit attraper,
 *  "ok" = ce qui est conforme. */
export interface RuleExample {
  kind: "ok" | "ko";
  text: string;
}

/** Catégorie créée à la main. Les familles du catalogue (FAMILY_LABELS)
 *  restent disponibles comme catégories implicites. */
export interface CustomCategory {
  id: string;    // slug ^[a-z0-9-]{1,40}$
  label: string; // ≤ CUSTOM_CATEGORY_LABEL_MAX
}

export interface RuleOverride {
  enabled?: boolean;
  severity?: AdjustableSeverity;
  params?: Record<string, ParamValue>;
  /** Catégorie choisie pour une règle du CATALOGUE. Absente = sa famille. */
  category?: string;
  /** Règle du catalogue retirée de la liste par "Delete" : éteinte ET masquée.
   *  Rien n'est supprimé du code — réversible via "Show all". */
  removed?: boolean;
  /** Exemples ajoutés à une règle du catalogue. */
  examples?: RuleExample[];
  /** Intitulé réécrit par le métier. Absent = le libellé du code.
   *  Ce qui reste au code, c'est la MÉCANIQUE de détection — jamais le texte
   *  qu'on lit à l'écran. */
  label?: string;
  /** Description réécrite. Absente = celle du code. */
  description?: string;
}

/** Règle écrite à la main par une personne fonctionnelle, en anglais, vérifiée
 *  par l'agent "Conformité guidelines". */
export interface CustomRule {
  id: string;
  /** L'ÉNONCÉ de la règle, écrit tel quel — c'est ce qui s'affiche en titre. */
  title: string;
  instruction: string;
  /** RuleFamily du catalogue OU id d'une CustomCategory. */
  category: string;
  /** Agent qui vérifiera la règle. Absent = agent guidelines (comportement
   *  historique, aucune migration nécessaire). Doit être une clé de WORKERS.
   *  Axe INDÉPENDANT de `category` : la catégorie range, l'agent route. */
  agent?: string;
  examples: RuleExample[];
  /** Conservée dans le modèle (le moteur en a besoin) mais PLUS EXPOSÉE dans
   *  l'UI : toute règle écrite à la main vaut "MAJEUR" par défaut. */
  severity: AdjustableSeverity;
  enabled: boolean;
}

export interface RuleConfigHistoryEntry {
  version: number;
  at: string;
  by?: string;
  summary: string;
  /** Motif saisi au moment de la sauvegarde. Optionnel — les entrées écrites
   *  avant l'existence du champ n'en ont pas, et l'exiger empêcherait de
   *  sauvegarder tant que les écarts déjà en place n'ont pas été justifiés
   *  rétroactivement. */
  reason?: string;
  overrides: Record<string, RuleOverride>;
  customRules: CustomRule[];
  customCategories: CustomCategory[];
}

export interface RuleConfig {
  id: "default";
  overrides: Record<string, RuleOverride>;
  customRules: CustomRule[];
  customCategories: CustomCategory[];
  /** Incrémentée à chaque écriture — sert au verrou anti-écrasement (409). */
  version: number;
  updatedAt: string;
  updatedBy?: string;
  history: RuleConfigHistoryEntry[];
}

export const HISTORY_MAX = 50;

export function emptyRuleConfig(): RuleConfig {
  return {
    id: "default",
    overrides: {},
    customRules: [],
    customCategories: [],
    version: 0,
    updatedAt: new Date(0).toISOString(),
    history: [],
  };
}

// --- Texte affiché : réécriture du métier, sinon code -----------------------

/** Libellé effectif à partir d'un id seul, pour les messages qui n'ont pas
 *  l'entrée sous la main. Retombe sur l'id quand la règle a quitté le code
 *  (override orphelin) — jamais sur une chaîne vide. */
function labelForId(ruleId: string, override?: RuleOverride): string {
  const entry = ALL_RULE_BY_ID[ruleId];
  if (!entry) return override?.label?.trim() || ruleId;
  return effectiveLabel(entry, override);
}

// --- Défauts issus du code -------------------------------------------------

/** Une règle "qualité générique" (extendedOnly) reste éteinte par défaut :
 *  QA_EXTENDED=1 conserve exactement son comportement actuel, et la config
 *  permet désormais de l'allumer sans redéploiement. */
function defaultEnabled(ruleId: string): boolean {
  const entry = ALL_RULE_BY_ID[ruleId];
  if (!entry) return false;
  if (entry.extendedOnly) return process.env.QA_EXTENDED === "1";
  return true;
}

function defaultParam(ruleId: string, key: string): ParamValue | undefined {
  const spec = ALL_RULE_BY_ID[ruleId]?.params?.find((p) => p.key === key);
  return spec?.default;
}

// --- Config résolue (ce que consomment les checks) -------------------------

export interface ResolvedRuleConfig {
  version: number;
  /** Empreinte : entre dans le hash de cache des rapports (une règle modifiée
   *  doit invalider les analyses en cache). */
  hash: string;
  enabled(ruleId: string): boolean;
  /** Sévérité effective : l'override n'est honoré que si la règle est réglable
   *  et non protégée — sinon la sévérité du code est conservée. */
  severity(ruleId: string, fallback: Severity): Severity;
  int(ruleId: string, key: string, fallback: number): number;
  terms(ruleId: string, key: string): string[];
  /** Liste d'entiers (codes HTTP, largeurs d'écran). `fallback` est renvoyé tel
   *  quel si l'override est absent ou vide — une liste vidée par mégarde ne doit
   *  pas supprimer un contrôle en silence. */
  intList(ruleId: string, key: string, fallback: number[]): number[];
  bool(ruleId: string, key: string, fallback: boolean): boolean;
  /** Exemples saisis pour une règle du CATALOGUE (vide par défaut). Le moteur
   *  les injecte dans le prompt de l'agent qui porte la règle — c'est le seul
   *  moyen de corriger un faux positif sans réécrire l'énoncé. */
  examples(ruleId: string): RuleExample[];
  /** Intitulé EFFECTIF d'une règle : celui réécrit dans /rules s'il existe,
   *  sinon celui du code. À utiliser partout où une règle est NOMMÉE hors de la
   *  page — prompt d'agent, rapport, journal. Sans cela, le métier renomme une
   *  règle à l'écran et le rapport continue d'afficher l'ancien nom, sans
   *  qu'aucun écran ne lui permette de comprendre pourquoi. */
  label(ruleId: string): string;
  customRules: CustomRule[];
}

/** Une règle DÉJÀ ENREGISTRÉE peut nommer un agent qui n'existe plus : la clé
 *  était proposable le jour de la saisie et a été retirée du catalogue depuis
 *  (c'est arrivé à "translation"). Le repli habituel `agent ?? guidelines` ne
 *  la rattrape pas — il ne joue que sur un champ ABSENT, jamais sur un champ qui
 *  désigne un agent inconnu.
 *
 *  Sans ce ré-aiguillage, plus personne ne lit la règle : aucun worker ne la
 *  réclame (lib/agents.ts filtre sur `r.agent === agentKey`) et le canal
 *  <editorial_rules> l'écarte (lib/analyze.ts ne prend que celles dont l'agent
 *  vaut guidelines). Elle resterait allumée à l'écran et vérifiée par personne
 *  — le mode de défaillance qu'on vient de fermer côté formulaire, qui rentre
 *  ici par la config stockée. Mesuré sur les deux canaux, pas déduit.
 *
 *  Troisième état plutôt que rejet silencieux : la règle est GARDÉE et rendue à
 *  l'agent guidelines, seul agent qui juge des règles éditoriales libres. Rien
 *  n'est masqué pour autant : /rules lit la config BRUTE et continue d'afficher
 *  la clé morte, et la route d'écriture refuse toujours de l'enregistrer.
 *
 *  `agent: undefined` et non la chaîne "guidelines" : c'est la valeur que le
 *  disque porte déjà (les configs enregistrées avant l'existence du champ), et
 *  la garder ici laisse UNE seule représentation de « pas d'agent » circuler
 *  dans le moteur au lieu de deux.
 *
 *  Ce n'est PLUS l'argument du cycle d'imports : GUIDELINES_AGENT_KEY a quitté
 *  lib/agents.ts pour lib/agent-catalog.ts, que ce fichier importe en tête. La
 *  contrainte technique a disparu, la raison ci-dessus tient toute seule — ne
 *  pas la re-justifier par un cycle qui n'existe plus. */
function rerouteOrphanAgent(r: CustomRule): CustomRule {
  if (r.agent === undefined || AGENT_KEYS.includes(r.agent)) return r;
  return { ...r, agent: undefined };
}

export function resolveRuleConfig(cfg: RuleConfig | null | undefined): ResolvedRuleConfig {
  // Fichier absent ou corrompu (FileStore renvoie null) = tous les défauts.
  const overrides = cfg?.overrides ?? {};
  const customRules = (cfg?.customRules ?? []).filter((r) => r.enabled).map(rerouteOrphanAgent);
  // `?? []` et pas un accès direct : une config enregistrée AVANT l'existence
  // des catégories n'a pas le champ, et le type ne dit rien de ce qui dort déjà
  // sur le disque.
  const customCategories = cfg?.customCategories ?? [];
  // Les catégories entrent dans l'empreinte : renommer une catégorie ne change
  // aucun verdict, mais la ranger dans le hash coûte une invalidation de cache
  // et évite d'avoir à trancher au cas par cas ce qui, dedans, est inerte.
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ overrides, customRules, customCategories }))
    .digest("hex")
    .slice(0, 12);

  return {
    version: cfg?.version ?? 0,
    hash,
    enabled(ruleId) {
      const o = overrides[ruleId];
      const entry = ALL_RULE_BY_ID[ruleId];
      // Une entrée protégée OU affichée en lecture seule n'est jamais éteinte
      // par la config, même si un override traîne (règle jadis éditable, ou
      // appel API direct qui aurait contourné la page).
      if (entry?.protected || entry?.readOnly) return true;
      // "Delete" dans la page = éteinte ET masquée. Le masquage est une affaire
      // d'affichage, mais le moteur doit lire la même chose que l'écran : une
      // règle retirée de la liste qui continuerait à produire des findings
      // serait un contrôle que personne ne peut plus retrouver pour l'éteindre.
      if (o?.removed) return false;
      return o?.enabled ?? defaultEnabled(ruleId);
    },
    severity(ruleId, fallback) {
      const entry = ALL_RULE_BY_ID[ruleId];
      if (!entry?.severityAdjustable || entry.protected || entry.readOnly) return fallback;
      return overrides[ruleId]?.severity ?? fallback;
    },
    int(ruleId, key, fallback) {
      const v = overrides[ruleId]?.params?.[key] ?? defaultParam(ruleId, key);
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    },
    terms(ruleId, key) {
      const v = overrides[ruleId]?.params?.[key] ?? defaultParam(ruleId, key);
      if (!Array.isArray(v)) return [];
      return v.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    },
    intList(ruleId, key, fallback) {
      const v = overrides[ruleId]?.params?.[key] ?? defaultParam(ruleId, key);
      if (!Array.isArray(v)) return fallback;
      const nums = v.filter((n): n is number => typeof n === "number" && Number.isInteger(n));
      return nums.length > 0 ? nums : fallback;
    },
    bool(ruleId, key, fallback) {
      const v = overrides[ruleId]?.params?.[key] ?? defaultParam(ruleId, key);
      return typeof v === "boolean" ? v : fallback;
    },
    examples(ruleId) {
      // Tableau vide plutôt qu'undefined : l'appelant ne doit pas avoir à
      // tester. Les textes vides sont retirés ICI — envoyés au modèle, ce
      // serait du bruit présenté comme un exemple.
      return (overrides[ruleId]?.examples ?? []).filter((e) => e.text.trim().length > 0);
    },
    label(ruleId) {
      // Même repli que labelForId : une règle disparue du code garde son
      // identifiant plutôt que de se nommer par une chaîne vide.
      return labelForId(ruleId, overrides[ruleId]);
    },
    customRules,
  };
}

/** Config par défaut (aucun écart) — utilisée par les tests et par tout
 *  appelant de runCodeChecks qui ne passe pas de config. */
export const DEFAULT_RULE_CONFIG: ResolvedRuleConfig = resolveRuleConfig(null);

// --- Règles custom → règles éditoriales injectées dans l'agent guidelines ---

/** Instruction + exemples, dans la forme lue par l'agent. Un exemple vaut mieux
 *  qu'une reformulation : c'est le seul moyen qu'a une personne fonctionnelle de
 *  corriger un faux positif sans réécrire l'énoncé. */
function describeWithExamples(instruction: string, examples: RuleExample[]): string {
  const pick = (kind: RuleExample["kind"]) =>
    examples
      .filter((e) => e.kind === kind)
      .map((e) => e.text.trim())
      .filter((t) => t.length > 0);
  const ko = pick("ko");
  const ok = pick("ok");
  const lines: string[] = [];
  // Une section vide dirait à l'agent "il n'existe aucun cas conforme" : on
  // n'écrit que celles qui ont au moins un exemple.
  if (ko.length > 0) lines.push("Examples that BREAK this rule:", ...ko.map((t) => `- ${t}`));
  if (ok.length > 0) lines.push("Examples that are FINE:", ...ok.map((t) => `- ${t}`));
  const block = lines.join("\n");
  // Une règle qui n'a QUE des exemples part avec les exemples seuls : sans ce
  // cas, la description commencerait par deux sauts de ligne.
  if (!instruction) return block;
  return block ? `${instruction}\n\n${block}` : instruction;
}

/** Cette règle part-elle à l'agent guidelines ? Le champ `agent` ABSENT vaut
 *  GUIDELINES_AGENT_KEY — c'est la convention des configs enregistrées avant que
 *  le champ existe, et elle doit rendre le même verdict que `agent: "guidelines"`
 *  écrit explicitement.
 *
 *  Existe pour n'avoir qu'UN énoncé de cette question. Elle était écrite en ligne
 *  dans lib/analyze.ts et recopiée à l'identique dans les tests ; c'est le même
 *  montage que les deux `AGENT_CHOICES` homonymes qui ont divergé ce matin sans
 *  que la relecture puisse le voir.
 *
 *  ⚠️ CE QU'ELLE NE FAIT PAS, et ce n'est pas un oubli : elle n'avale pas l'agent
 *  INCONNU. Une règle nommant un agent retiré du catalogue rend `false` ici, donc
 *  ne part pas en <editorial_rules> — elle n'est rattrapée qu'en amont, par
 *  rerouteOrphanAgent, qui remet son `agent` à `undefined` à la RÉSOLUTION. Le
 *  repli `??` ne joue que sur un champ absent, jamais sur un champ qui désigne un
 *  agent inconnu : c'est précisément le défaut qui laissait ces règles vérifiées
 *  par personne. Ne pas « améliorer » cette fonction en y testant AGENT_KEYS : la
 *  réparation appartient à la résolution, sinon /rules cesserait d'afficher la
 *  clé morte et l'utilisateur ne saurait jamais que son choix n'existe plus.
 *
 *  ⚠️ NE PAS SUBSTITUER CETTE FONCTION AU FILTRE DE lib/agents.ts, qui route les
 *  autres agents par `r.agent === agentKey`. Ce prédicat-ci ignore `agentKey` :
 *  mis à sa place, CHAQUE agent recevrait les règles de guidelines et perdrait
 *  les siennes. Ce n'est pas un doublon — c'est une PERMUTATION, et une
 *  permutation se lit comme un verdict ordinaire, là où un doublon se voit dans
 *  le rapport. L'égalité stricte y est correcte parce que la sortie précoce sur
 *  guidelines a déjà traité le cas juste au-dessus.
 *
 *  Mesuré le 03/09 à 14:15, sur les trois cas (agent absent / "guidelines" /
 *  "vision") : la substitution donne `vision: ["sans-agent","vers-guidelines"]`,
 *  soit l'inverse de la partition attendue. Y ajouter le repli `??` en revanche
 *  ne change RIEN (sortie identique sur les trois agents) : une version
 *  antérieure de ce commentaire mettait en garde contre ce repli inoffensif et
 *  laissait la substitution ouverte. La garde vise donc bien la ligne dangereuse
 *  — ne pas la réécrire sans refaire la mesure. */
export function isGuidelinesRule(r: CustomRule): boolean {
  return (r.agent ?? GUIDELINES_AGENT_KEY) === GUIDELINES_AGENT_KEY;
}

/** Convertit les règles écrites à la main en BrandRule "llm", format déjà
 *  compris par buildWorkerCtx. Le texte utilisateur est encadré par des
 *  délimiteurs et explicitement présenté comme une DONNÉE : c'est la barrière
 *  d'injection de prompt (le vecteur réel restant étant le contenu de l'email
 *  lui-même — risque documenté et accepté, son pire cas est un faux négatif). */
export function customRulesAsBrandRules(rules: CustomRule[]): BrandRule[] {
  return rules
    .filter((r) => r.enabled)
    .map((r) => {
      const title = r.title.trim();
      // Le formulaire "Add a rule" ne demande qu'un énoncé libre, qui atterrit
      // dans le titre : sans ce repli, une règle écrite ainsi partirait à
      // l'agent sans aucune consigne.
      const instruction = r.instruction.trim() || title;
      return {
        rule: r,
        title,
        // La troncature porte sur le TOUT : les exemples comptent dans le
        // budget, sinon la borne ne borne plus rien.
        description: describeWithExamples(instruction, r.examples ?? []).slice(
          0,
          CUSTOM_RULE_MAX_CHARS
        ),
      };
    })
    // Le filtre porte sur ce qui PART, pas sur la seule `instruction` : une
    // règle sans instruction mais avec un titre ou des exemples est allumée à
    // l'écran, la laisser tomber ici la rendrait vérifiée par personne. Ne sort
    // ici qu'une règle entièrement vide, que l'agent ne pourrait pas juger.
    .filter((x) => x.description.length > 0)
    .map(({ rule, title, description }) => ({
      id: `custom-${rule.id}`,
      title: title || "Custom rule",
      description,
      category: "tone" as const,
      engine: "llm" as const,
      severity: rule.severity === "MAJEUR" ? ("warning" as const) : ("suggestion" as const),
      enabled: true,
    }));
}

// --- Validation stricte de la route d'écriture -----------------------------

const TERM_RE = /^[^\u0000-\u001f<>]{1,80}$/;

/** Slug de catégorie : rangé dans une URL et comparé à une RuleFamily, donc
 *  limité aux caractères qui ne demandent aucun échappement. */
const CATEGORY_ID_RE = /^[a-z0-9-]{1,40}$/;

/** Texte affiché saisi par le métier (intitulé, description). Mêmes exclusions
 *  que TERM_RE : pas de caractères de contrôle, pas de `<`/`>`. Ces textes sont
 *  rendus dans la page ET recopiés dans des messages d'erreur — les priver des
 *  chevrons coupe la voie la plus courte vers une injection de balise. */
const SAFE_TEXT_RE = /^[^\u0000-\u001f<>]+$/;

const RuleExampleSchema = z.object({
  kind: z.enum(["ok", "ko"]),
  text: z.string().min(1).max(RULE_EXAMPLE_MAX_CHARS),
});

const CustomCategorySchema = z.object({
  id: z.string().regex(CATEGORY_ID_RE),
  label: z.string().min(1).max(CUSTOM_CATEGORY_LABEL_MAX),
});

// Tous les champs ajoutés ci-dessous sont optionnels ou ont un défaut : les
// configs déjà enregistrées en production n'ont ni `category`, ni `examples`,
// ni `customCategories`, et un schéma qui les exigerait rendrait la page
// insauvegardable jusqu'à ce que quelqu'un migre le fichier à la main.
const OverrideSchema = z.object({
  enabled: z.boolean().optional(),
  severity: z.enum(["CRITIQUE", "MAJEUR", "MINEUR"]).optional(),
  params: z
    .record(
      z.string(),
      z.union([
        z.number(),
        z.boolean(),
        z.array(z.string().regex(TERM_RE)),
        z.array(z.number()),
      ])
    )
    .optional(),
  category: z.string().min(1).max(40).optional(),
  removed: z.boolean().optional(),
  examples: z.array(RuleExampleSchema).max(RULE_EXAMPLES_MAX).optional(),
  label: z.string().min(1).max(RULE_LABEL_MAX).regex(SAFE_TEXT_RE).optional(),
  description: z.string().min(1).max(RULE_DESCRIPTION_MAX).regex(SAFE_TEXT_RE).optional(),
});

const CustomRuleSchema = z.object({
  id: z.string().min(1).max(40),
  /** `.trim()` AVANT les bornes, et c'est l'ordre qui compte : Zod applique la
   *  transformation puis valide, donc `min(1)` refuse un titre entièrement
   *  composé d'espaces, et `max()` compte les caractères UTILES. La valeur
   *  ENREGISTRÉE est la valeur trimée — c'est un changement de ce qui est
   *  stocké, pas seulement de ce qui est refusé.
   *
   *  Motif : l'écran borne la SAISIE (maxLength) et le serveur borne
   *  l'ENREGISTREMENT. La constante partagée supprime la divergence par
   *  recopie, pas celle par traitement — le moteur consommait déjà
   *  `r.title.trim()` (customRulesAsBrandRules) pendant que le schéma bornait
   *  la chaîne brute, si bien qu'un titre de 120 caractères dont 5 étaient des
   *  espaces finales était accepté puis rendu à 115. Les deux bouts trimment
   *  désormais au même endroit. */
  title: z.string().trim().min(1).max(CUSTOM_RULE_TITLE_MAX),
  /** Peut être VIDE : le formulaire "Add a rule" ne remplit que le titre, et
   *  customRulesAsBrandRules retombe alors dessus. */
  instruction: z.string().max(CUSTOM_RULE_MAX_CHARS).default(""),
  category: z.string().min(1).max(40).default("brand"),
  /** Absent = agent guidelines, comme avant. Aucune migration des configs
   *  existantes, qui n'ont pas le champ. */
  agent: z.string().min(1).max(40).optional(),
  examples: z.array(RuleExampleSchema).max(RULE_EXAMPLES_MAX).default([]),
  /** Plus envoyée par l'UI, qui n'expose plus la sévérité : toute règle écrite à
   *  la main vaut MAJEUR. CRITIQUE reste hors d'atteinte (cf.
   *  CUSTOM_RULE_SEVERITIES) — une règle jugée par un LLM ne bloque pas seule. */
  severity: z.enum(["MAJEUR", "MINEUR"]).default("MAJEUR"),
  enabled: z.boolean(),
});

export const RuleConfigWriteSchema = z.object({
  overrides: z.record(z.string().min(1).max(60), OverrideSchema),
  customRules: z.array(CustomRuleSchema).max(CUSTOM_RULE_MAX),
  customCategories: z.array(CustomCategorySchema).max(CUSTOM_CATEGORY_MAX).default([]),
  updatedBy: z.string().max(80).optional(),
  /** Motif libre de la sauvegarde, versé à l'historique. UN motif par
   *  enregistrement, pas un par règle : exiger une justification règle par règle
   *  bloquerait toute sauvegarde tant que les désactivations déjà en place
   *  n'auraient pas été justifiées a posteriori, et pousserait à taper "." dix
   *  fois. Optionnel, donc aucune migration des configs existantes. */
  changeReason: z.string().max(280).optional(),
  /** Version lue par le client : un décalage = quelqu'un a sauvegardé entre
   *  temps (409), on ne lui écrase pas son travail en silence. */
  version: z.number().int().nonnegative(),
});

export type RuleConfigWrite = z.infer<typeof RuleConfigWriteSchema>;

const isNumberList = (v: ParamValue): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number");
const isStringList = (v: ParamValue): v is string[] =>
  Array.isArray(v) && v.every((t) => typeof t === "string");

/** Contrôles que Zod ne peut pas faire seul : bornes des paramètres, types
 *  attendus par le catalogue, règles protégées. Renvoie la liste des erreurs
 *  (vide = valide).
 *
 *  `knownAgents` vaut par défaut AGENT_KEYS, la liste que la page AFFICHE : le
 *  serveur accepte donc exactement ce que le formulaire propose, et aucun choix
 *  visible ne peut être refusé en 400.
 *
 *  Le défaut est ici volontaire, et il a été discuté deux fois. L'objection —
 *  « une garde qu'on peut oublier d'alimenter ne garde rien » — ne vaut que si
 *  l'oubli produit une liste VIDE. Ici l'oubli produit la garde COMPLÈTE, donc
 *  le mode de défaillance est inversé : c'est passer une liste tronquée qui est
 *  risqué, pas omettre l'argument.
 *
 *  Importer AGENT_KEYS n'inverse aucune dépendance : lib/agent-catalog.ts ne
 *  dépend de RIEN, il est sous tout le monde dans le graphe. C'est lib/agents.ts
 *  (fs, clé Foundry) qu'il ne faut jamais importer d'ici. */
export function validateAgainstCatalog(
  body: RuleConfigWrite,
  knownAgents: readonly string[] = AGENT_KEYS
): string[] {
  const errors: string[] = [];
  const agents = new Set(knownAgents);

  // Catégories connues : les familles du catalogue + celles écrites à la main
  // DANS CETTE MÊME écriture. Une catégorie fantôme (id qui ne désigne rien)
  // rangerait des règles dans un onglet que la page ne sait pas afficher : elles
  // disparaîtraient de l'écran tout en continuant à tourner.
  const knownCategories = new Set<string>(Object.keys(FAMILY_LABELS));
  for (const c of body.customCategories) {
    if (knownCategories.has(c.id)) errors.push(`Duplicate category id "${c.id}".`);
    knownCategories.add(c.id);
  }

  for (const [ruleId, override] of Object.entries(body.overrides)) {
    const entry = ALL_RULE_BY_ID[ruleId];
    // Override orphelin (règle retirée du code) : TOLÉRÉ à l'écriture, signalé
    // dans l'UI et nettoyé par "Restore defaults" — jamais perdu en silence.
    if (!entry) continue;
    // Le libellé EFFECTIF, pas celui du code : si le métier a renommé la règle,
    // un message qui la nomme autrement désigne une règle qu'il ne reconnaît
    // pas — et il la chercherait en vain dans la page.
    const label = effectiveLabel(entry, override);
    if (override.category !== undefined && !knownCategories.has(override.category)) {
      errors.push(`Unknown category "${override.category}".`);
    }
    // Entrée affichée en lecture seule : visible dans la page pour répondre à
    // "toutes les règles", mais tout override est refusé ICI — c'est la seule
    // barrière qui tienne, la page peut être contournée par un appel direct.
    if (entry.readOnly) {
      const touched =
        override.enabled !== undefined ||
        override.severity !== undefined ||
        Object.keys(override.params ?? {}).length > 0 ||
        override.removed !== undefined ||
        override.category !== undefined ||
        (override.examples?.length ?? 0) > 0 ||
        override.label !== undefined ||
        override.description !== undefined;
      if (touched) errors.push(`"${label}" is managed internally and cannot be changed.`);
      continue;
    }
    if (entry.protected && override.enabled === false) {
      errors.push(`"${label}" cannot be disabled.`);
    }
    // "Delete" éteint la règle : sur une règle protégée, c'est exactement la
    // désactivation refusée ci-dessus, avec un autre bouton.
    if (entry.protected && override.removed === true) {
      errors.push(
        `"${label}" cannot be deleted — it catches problems that would reach the recipient.`
      );
    }
    if (entry.protected && override.severity) {
      errors.push(`The severity of "${label}" cannot be changed.`);
    }
    if (override.severity && !entry.severityAdjustable) {
      errors.push(`"${label}" chooses its own severity and cannot be overridden.`);
    }
    // Sévérité hors des valeurs proposables : le moteur la rabattrait, donc
    // l'enregistrer afficherait durablement un réglage qui n'est pas appliqué.
    if (
      override.severity &&
      entry.severityOptions &&
      !entry.severityOptions.includes(override.severity)
    ) {
      errors.push(
        `"${label}" only accepts ${entry.severityOptions
          .map((s) => SEVERITY_LABELS[s])
          .join(" or ")}.`
      );
    }
    for (const [key, value] of Object.entries(override.params ?? {})) {
      const spec = entry.params?.find((p) => p.key === key);
      if (!spec) {
        errors.push(`Unknown setting "${key}" on "${label}".`);
        continue;
      }
      if (spec.kind === "int") {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          errors.push(`"${spec.label}" must be a whole number.`);
        } else if (value < spec.min || value > spec.max) {
          errors.push(`"${spec.label}" must be between ${spec.min} and ${spec.max}.`);
        }
      } else if (spec.kind === "boolean") {
        if (typeof value !== "boolean") errors.push(`"${spec.label}" must be on or off.`);
      } else if (spec.kind === "int-list") {
        // isNumberList / isStringList sont des prédicats de type : sans eux TS
        // garde `(string | number)[]` et refuse les comparaisons numériques.
        if (!isNumberList(value)) {
          errors.push(`"${spec.label}" must be a list of numbers.`);
        } else if (value.length > spec.maxItems) {
          errors.push(`"${spec.label}" is limited to ${spec.maxItems} entries.`);
        } else if (value.some((n) => !Number.isInteger(n) || n < spec.min || n > spec.max)) {
          errors.push(`"${spec.label}" only accepts whole numbers between ${spec.min} and ${spec.max}.`);
        }
      } else if (!isStringList(value)) {
        errors.push(`"${spec.label}" must be a list of words.`);
      } else if (value.length > spec.maxItems) {
        errors.push(`"${spec.label}" is limited to ${spec.maxItems} entries.`);
      }
    }
  }
  const ids = new Set<string>();
  for (const r of body.customRules) {
    if (ids.has(r.id)) errors.push(`Duplicate custom rule id "${r.id}".`);
    ids.add(r.id);
    if (!knownCategories.has(r.category)) {
      errors.push(`Unknown category "${r.category}".`);
    }
    // Agent inconnu = règle routée vers un worker qui n'existe pas : elle ne
    // serait vérifiée par personne, en silence.
    if (r.agent !== undefined && !agents.has(r.agent)) {
      errors.push(`Unknown agent "${r.agent}" on rule "${r.title}".`);
    }
  }
  return errors;
}

/** Motifs PII évidents dans les règles écrites à la main. Vérifié CÔTÉ SERVEUR
 *  (un contrôle uniquement client se contourne par un appel API direct). */
const PII_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, what: "an email address" },
  { re: /(?:\+\d{1,3}[ .-]?)?(?:\d[ .-]?){9,13}\d/, what: "a phone number" },
];

/** Premier motif PII trouvé dans un des textes, ou undefined. */
function firstPii(texts: string[]): string | undefined {
  for (const p of PII_PATTERNS) {
    if (texts.some((t) => p.re.test(t))) return p.what;
  }
  return undefined;
}

/** `overrides` est optionnel pour ne pas casser les appels existants, mais la
 *  route le passe : un exemple accroché à une règle du CATALOGUE part dans le
 *  même prompt qu'une règle écrite à la main, il n'y a aucune raison de
 *  l'exempter du contrôle. */
export function findPii(
  rules: CustomRule[],
  overrides?: Record<string, RuleOverride>
): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const inInstruction = firstPii([r.instruction]);
    if (inInstruction) {
      out.push(`Rule "${r.title}" seems to contain ${inInstruction} — remove personal data from rules.`);
    }
    const inExamples = firstPii((r.examples ?? []).map((e) => e.text));
    if (inExamples) {
      out.push(`Rule "${r.title}" has an example that seems to contain ${inExamples} — remove personal data.`);
    }
  }
  for (const [ruleId, override] of Object.entries(overrides ?? {})) {
    const what = firstPii((override.examples ?? []).map((e) => e.text));
    if (!what) continue;
    // Le libellé EFFECTIF plutôt que l'id : c'est ce que la personne voit à
    // l'écran, un message qui cite un id l'oblige à chercher la ligne — et un
    // message qui cite le libellé du code après un renommage la ferait chercher
    // une règle qui n'existe plus sous ce nom.
    const label = labelForId(ruleId, override);
    out.push(`Rule "${label}" has an example that seems to contain ${what} — remove personal data.`);
  }
  return out;
}

/** Résumé lisible d'un changement, pour l'historique. */
export function diffSummary(prev: RuleConfig, next: RuleConfigWrite): string {
  const parts: string[] = [];
  const changed = new Set<string>();
  for (const id of new Set([...Object.keys(prev.overrides), ...Object.keys(next.overrides)])) {
    if (JSON.stringify(prev.overrides[id] ?? null) !== JSON.stringify(next.overrides[id] ?? null)) {
      changed.add(id);
    }
  }
  if (changed.size > 0) {
    parts.push(`${changed.size} built-in rule${changed.size > 1 ? "s" : ""} changed`);
  }
  const before = prev.customRules.length;
  const after = next.customRules.length;
  if (after > before) parts.push(`${after - before} custom rule${after - before > 1 ? "s" : ""} added`);
  else if (after < before) parts.push(`${before - after} custom rule${before - after > 1 ? "s" : ""} removed`);
  else if (JSON.stringify(prev.customRules) !== JSON.stringify(next.customRules)) {
    parts.push("custom rules edited");
  }
  // `?? []` : les configs enregistrées avant l'existence des catégories n'ont
  // pas le champ, et sans ce repli toute première sauvegarde annoncerait un
  // changement de catégories qui n'a pas eu lieu.
  const prevCats = prev.customCategories ?? [];
  const nextCats = next.customCategories ?? [];
  let catsChanged = 0;
  for (const id of new Set([...prevCats.map((c) => c.id), ...nextCats.map((c) => c.id)])) {
    const before = prevCats.find((c) => c.id === id);
    const after = nextCats.find((c) => c.id === id);
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) catsChanged++;
  }
  if (catsChanged > 0) {
    parts.push(`${catsChanged} ${catsChanged === 1 ? "category" : "categories"} changed`);
  }
  return parts.join(", ") || "no change";
}
