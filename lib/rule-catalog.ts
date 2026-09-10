// Catalogue des règles déterministes exposées dans la page /rules.
//
// Le CODE reste la source de vérité : ce fichier ne fait que NOMMER les règles
// de lib/checks-code.ts pour qu'une personne fonctionnelle puisse les piloter
// (activer/désactiver, sévérité, quelques paramètres) sans toucher au code.
// La config stockée ne contient que des ÉCARTS par rapport à ces défauts —
// elle ne peut donc jamais devenir périmée quand une règle évolue.
//
// ⚠️ Un `id` est un CONTRAT : ne JAMAIS le renommer (la config persistée y fait
// référence). Une règle supprimée laisse un override orphelin, signalé dans
// l'UI puis nettoyé par "Restore defaults" — jamais ignoré en silence.
//
// Ce module ne dépend d'AUCUNE API Node : il est importé par la page client.
//
// ⚠️ FRONTIÈRE SERVEUR / CLIENT — tout ce que la page cliente doit importer en
// VALEUR (constantes, fonctions) vit ICI. lib/rule-config.ts et lib/agents.ts
// sont réservés aux `import type` : ils tirent `crypto`, `fs` et la clé
// Foundry. Un `import type` est effacé à la compilation, un import de valeur
// non — et un ré-export (`export … from`) compte comme un import de valeur : il
// exécute le module source. Le typecheck ne voit rien de tout ça, seul
// `next build` casse.
//
// Une exception, et une seule : la liste des agents proposables vit dans
// lib/agent-catalog.ts, qui ne dépend de RIEN et franchit donc la même
// frontière. Elle n'est PAS dérivée de WORKERS — lib/agents.ts la VÉRIFIE au
// chargement au lieu d'en construire une seconde. Ne la recopie ni ici ni
// ailleurs : deux listes homonymes ont déjà divergé sans que la relecture
// puisse le voir.

// `import type` : effacé à la compilation, donc rien de lib/rule-config.ts
// n'entre dans le graphe de modules (ni ici, ni dans le bundle client).
import type { RuleOverride } from "./rule-config";

export type AdjustableSeverity = "CRITIQUE" | "MAJEUR" | "MINEUR";

export type RuleFamily =
  | "content"
  | "links"
  | "tracking"
  | "brief"
  // Conformité de la TRADUCTION au brief template. Famille à part et non un
  // sous-ensemble de "brief" parce que DEUX natures de contrôle y cohabitent :
  // la structure et la couverture des langues se vérifient en code, de façon
  // déterministe ; la FIDÉLITÉ d'une traduction se juge par un agent LLM,
  // déclenché en escalade sur les écarts que le déterministe a signalés.
  | "translation"
  | "deliverability"
  | "technical"
  | "brand"
  // Familles ajoutées avec l'ouverture de TOUTES les règles à la configuration :
  | "ai-checks" // ce que les agents LLM vérifient (lib/llm-rule-catalog.ts)
  | "link-verification" // comment les liens sont ouverts (lib/peripheral-rule-catalog.ts)
  | "matching"; // rattachement d'un email reçu à sa campagne

export const FAMILY_LABELS: Record<RuleFamily, string> = {
  brief: "Brief compliance",
  translation: "Translation",
  content: "Content",
  links: "Links",
  tracking: "Tracking & UTM",
  deliverability: "Deliverability",
  technical: "Technical",
  brand: "Brand rules",
  "ai-checks": "AI checks",
  "link-verification": "Link verification",
  matching: "Email matching",
};

/** Ordre d'affichage des familles dans la page (du plus métier au plus technique). */
export const FAMILY_ORDER: RuleFamily[] = [
  "brief",
  // Juste après "brief" : c'est une conformité au brief, elle se lit là.
  // AUCUNE règle dedans pour l'instant — une famille vide est sautée par la
  // page, une famille remplie au jugé produirait des verdicts faux.
  "translation",
  "content",
  "links",
  "tracking",
  "deliverability",
  "technical",
  "brand",
  "ai-checks",
  "link-verification",
  "matching",
];

/** Paramètre exposé à l'édition. Volontairement limité à des formes SÛRES :
 *  - "int"      : entier borné (aucun risque) ;
 *  - "terms"    : liste de mots LITTÉRAUX (échappés avant toute construction de
 *                 regex côté code — jamais de motif saisi par l'utilisateur, ReDoS) ;
 *  - "int-list" : liste d'entiers bornés (codes HTTP, largeurs de viewport) ;
 *  - "boolean"  : interrupteur.
 *  Aucune expression, aucun code, AUCUNE regex utilisateur : c'est délibéré et
 *  ne doit pas être assoupli (une regex saisie = ReDoS trivial côté serveur). */
export type RuleParamSpec =
  | {
      key: string;
      kind: "int";
      label: string;
      help?: string;
      min: number;
      max: number;
      default: number;
      unit?: string;
    }
  | {
      key: string;
      kind: "terms";
      label: string;
      help?: string;
      default: string[];
      maxItems: number;
    }
  | {
      key: string;
      kind: "int-list";
      label: string;
      help?: string;
      min: number;
      max: number;
      default: number[];
      maxItems: number;
      unit?: string;
    }
  | {
      key: string;
      kind: "boolean";
      label: string;
      help?: string;
      default: boolean;
    };

export interface RuleCatalogEntry {
  id: string;
  /** Libellé métier (anglais, comme tout ce qui est visible dans Sentinel). */
  label: string;
  description: string;
  family: RuleFamily;
  /** Sévérité par défaut, ou "auto" quand la règle en choisit une selon le cas
   *  (ex : taille HTML = CRITIQUE au-dessus de la coupure Gmail, MINEUR juste
   *  en-dessous). Une sévérité "auto" n'est pas réglable : la remplacer
   *  produirait des verdicts absurdes. */
  /** "auto" = la sévérité dépend du cas rencontré (heuristique, confiance de la
   *  détection de langue…) — elle n'est alors pas redéfinissable. */
  defaultSeverity: AdjustableSeverity | "auto";
  severityAdjustable: boolean;
  /** Sévérités réellement proposables, quand elles ne sont pas les trois.
   *  Sert aux règles dont le moteur plafonne le résultat : la vision est une
   *  heuristique sur capture d'écran, elle ne monte jamais en CRITIQUE
   *  (cf. l'invariant en tête de lib/render-vision.ts). Proposer un choix que
   *  le moteur rabat ensuite serait un écran qui ment. */
  severityOptions?: AdjustableSeverity[];
  /** Règle non désactivable ET sévérité verrouillée : sa désactivation
   *  laisserait partir un email cassé (lien mort, contenu de test visible,
   *  authentification en échec). Baisser sa sévérité serait le même
   *  contournement déguisé — les deux sont donc bloqués. */
  protected?: boolean;
  /** Règle de qualité générique hors périmètre strict du brief : ÉTEINTE par
   *  défaut aujourd'hui (variable d'environnement QA_EXTENDED). La config peut
   *  désormais l'allumer sans redéploiement. */
  extendedOnly?: boolean;
  params?: RuleParamSpec[];

  // --- champs communs aux catalogues LLM et périphérique -------------------

  /** Règles LLM uniquement : `key` du worker qui la vérifie (cf. WORKERS dans
   *  lib/agents.ts). Sert à grouper l'affichage et à tracer l'origine. */
  agent?: string;

  /** Réglage AFFICHÉ mais non éditable. La demande était « toutes les règles » :
   *  un réglage qu'on ne peut pas ouvrir sans risque (garde SSRF, en-têtes
   *  anti-bot, détection du lien de désinscription) est montré avec sa valeur et
   *  la raison de son verrouillage, plutôt que caché. Un override sur une entrée
   *  readOnly est REFUSÉ côté serveur. */
  readOnly?: boolean;
  /** Pourquoi c'est verrouillé, en clair, pour la personne qui lit la page. */
  lockedReason?: string;
  /** Valeur courante à afficher (déjà formatée) quand readOnly. */
  lockedValue?: string;

  /** Traçabilité : fichier:ligne d'où la règle est extraite. Garantit qu'aucune
   *  entrée du catalogue n'est inventée — une règle affichée mais jamais
   *  exécutée ferait croire à un contrôle inexistant. */
  source?: string;
}

export const RULE_CATALOG: RuleCatalogEntry[] = [
  // ---------------------------------------------------------------- brief
  {
    id: "brief-block-content",
    label: "Brief content is used, in the right language",
    description:
      "Every content block of the brief (subject line, copy, CTA…) must be found in the email, in the language of the tested variant. Reports missing blocks, wording that drifts from the brief, text left in another language, and the wrong gender variant.",
    family: "brief",
    defaultSeverity: "auto",
    severityAdjustable: false,
    params: [
      {
        key: "similarityPercent",
        kind: "int",
        label: "Similarity threshold",
        help: 'Above this, a block is reported as "wording differs" (with a highlighted diff). Below, it is reported as missing. Lower it if too many blocks are flagged as missing.',
        min: 30,
        max: 90,
        default: 55,
        unit: "%",
      },
    ],
  },
  {
    id: "brief-promo-code",
    label: "Promo code from the brief is present",
    description: "The promo code written in the brief must appear somewhere in the email.",
    family: "brief",
    defaultSeverity: "CRITIQUE",
    severityAdjustable: true,
  },
  {
    id: "brief-utm-campaign",
    label: "utm_campaign matches the brief tracking plan",
    description: "The utm_campaign of the links must match the value planned in the brief.",
    family: "brief",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
  },
  {
    id: "expected-links-market",
    label: "CTAs point to the URL planned in the brief",
    description:
      "Each CTA is matched to its block in the brief and its destination compared to the URL planned for the market of the tested email.",
    family: "brief",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
  },

  // ------------------------------------------------------------ translation
  //
  // Conformité d'un brief au TEMPLATE (lib/brief-template.ts). Le template est
  // un référentiel de MESURE, pas un filtre d'ADMISSION : un brief qui ne le
  // suit pas reste analysé, il n'est simplement pas jugé contre une spec qui ne
  // le gouverne pas.
  //
  // ⚠️ CINQ règles à `id` FIXE, paramétrées par le template — et surtout PAS une
  // règle par champ. Une dérivation par champ produirait des ids qui naissent et
  // meurent à chaque édition du template, alors que `id` est un CONTRAT auquel
  // la config persistée fait référence : renommer un champ laisserait un
  // override orphelin, et en ajouter un ferait apparaître une règle jamais
  // configurée. Ici la config survit à toute évolution du template.
  //
  // Partage des rôles, qui est aussi la raison de la famille à part :
  //   /rules pilote les CONTRÔLES (actifs ? à quelle sévérité ?)
  //   le template pilote la SPEC   (quels champs ? quelles langues ?)
  {
    id: "template-structure",
    label: "Brief follows the campaign template",
    description:
      "Every field declared by the campaign template must be present in the brief, and fields the template does not know are reported. A brief written for another channel or another layout is reported as out of scope, never as non-compliant.",
    family: "translation",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
    source: "lib/brief-template.ts:validateAgainstTemplate",
  },
  {
    id: "template-language-coverage",
    label: "Every activated language is filled in",
    description:
      "Each translatable field must carry content in every language the campaign activated in the Common sheet. Languages the campaign did not activate are never required: the template lists the possible languages, it does not demand them all.",
    family: "translation",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
    source: "lib/brief-template.ts:validateAgainstTemplate",
  },
  {
    id: "template-language-ambiguous",
    label: "Report languages the platform cannot tell apart",
    description:
      "Some template columns share one internal code: Spain and Mexico both become ES, simplified and traditional Chinese both become ZH. Their coverage cannot be measured, so it is reported as unmeasured rather than counted as filled or as missing. Turning this rule off silences the per-campaign notice, not the limitation: it is stated permanently on the Template page.",
    family: "translation",
    // Non réglable en SÉVÉRITÉ : ce signalement dit que l'INSTRUMENT ne sait
    // pas mesurer, pas que le brief a un défaut, et la gravité d'un aveu n'est
    // pas affaire de goût.
    //
    // Une version antérieure de ce commentaire ajoutait « c'est exactement le
    // cas qu'on veut ne jamais pouvoir éteindre par confort ». C'était FAUX, et
    // mesuré faux par A : `severityAdjustable: false` n'agit que sur le repli de
    // sévérité (rule-config.ts:260), il ne touche PAS `enabled` — la règle peut
    // être simplement éteinte depuis /rules. Le champ qui ferme les deux portes
    // est `protected`, et je ne le prends pas : il sert aujourd'hui à « ne pas
    // laisser partir un email cassé », et un cadenas qui protège deux choses
    // différentes finit par n'en protéger aucune parce qu'on apprend à le
    // forcer. Le commentaire décrivait donc une intention, pas le code.
    //
    // Ce qui rend l'extinction acceptable, et c'est la CONDITION : l'aveu
    // permanent est déjà porté une fois, hors de portée de tout interrupteur,
    // par l'encadré de la page /brief-template. Le signalement par campagne est
    // une commodité. Si cet encadré disparaît, cette règle et la suivante
    // doivent devenir `protected` — mesuré : 32 campagnes MX contre 24 ES dans
    // l'inbox, la colonne écrasée est la plus utilisée des deux.
    defaultSeverity: "MINEUR",
    severityAdjustable: false,
    source: "lib/brief-template.ts:validateAgainstTemplate",
  },
  {
    id: "template-language-unsupported",
    label: "Report template languages the platform cannot carry at all",
    description:
      "A language column declared by the template but unknown to the platform is dropped when the brief is read, leaving no trace. Thai is the current case. Reported once so that a permanently unchecked language never looks like a campaign that simply does not target it. Turning this rule off silences the per-campaign notice, not the limitation: it is stated permanently on the Template page.",
    family: "translation",
    defaultSeverity: "MINEUR",
    severityAdjustable: false,
    source: "lib/brief-template.ts:validateAgainstTemplate",
  },
  {
    // Id DISTINCT de `template-structure`, et ce n'est pas du rangement.
    // Mesuré par A : l'override de sévérité est par ID, le défaut est par
    // APPEL. Émettre ce signalement en MINEUR sous `template-structure`, dont
    // les champs manquants sortent en MAJEUR, faisait tenir la distinction
    // uniquement tant que personne ne touchait au curseur que /rules affiche.
    // Un cran vers CRITIQUE promouvait une cellule fusionnée au rang d'un champ
    // absent ; un cran vers MINEUR rétrogradait en silence les vrais défauts de
    // structure. Les deux fabriquent un faux, et le second est muet.
    //
    // Les deux signalements n'ont pas la même NATURE : « champ requis absent »
    // est un reproche au brief, « une cellule porte deux champs » est une
    // réserve sur ce que la mesure peut établir. Un réglage qui les aplatit
    // d'un clic efface précisément la distinction entre un constat et un aveu.
    id: "template-field-shared-cell",
    label: "Report brief cells that carry several template fields",
    description:
      "One row of the brief can answer several fields the template declares separately — the Kering brief writes a single \"Hero Asset / CTA URL\" where the template declares a hero link and a CTA link. The fields are present, so this is not a missing-field report: it says the two cannot be checked against one another, because they hold one value.",
    family: "translation",
    // Actionnable et propre à un brief (« séparer en une ligne par champ »),
    // contrairement aux deux règles ci-dessus qui disent une cécité permanente
    // de la plateforme. Extinguible sans rien effacer d'irremplaçable.
    defaultSeverity: "MINEUR",
    severityAdjustable: false,
    source: "lib/brief-template.ts:validateAgainstTemplate",
  },
  // ABSENTE et ce n'est pas un oubli : `template-version-drift` (signaler une
  // campagne analysée contre une version antérieure du template). Son contrôle
  // vit dans lib/analyze.ts, pas dans lib/checks-code.ts, et rien ne l'exécute
  // encore — la campagne ne porte pas de `briefTemplateVersion`. L'inscrire ici
  // dès maintenant afficherait dans /rules un interrupteur qui n'allume rien.
  // La garde de lib/__tests__/checks-code-config.test.ts le refuse, à raison.

  // -------------------------------------------------------------- content
  {
    id: "placeholders",
    label: "No placeholder left in the copy",
    description:
      'Detects unreplaced filler visible to the recipient: "lorem ipsum", TBD, TODO, xxx, "placeholder"…',
    family: "content",
    defaultSeverity: "CRITIQUE",
    severityAdjustable: false,
    protected: true,
    params: [
      {
        key: "extraTerms",
        kind: "terms",
        label: "Additional placeholder words",
        help: "Plain words only — they are matched literally, never as a pattern.",
        default: [],
        maxItems: 30,
      },
    ],
  },
  {
    id: "personalization-tokens",
    label: "Personalization tokens are spelled correctly",
    description:
      "An unknown %%token%% is almost always a typo: it will be displayed as-is to the recipient instead of their name.",
    family: "content",
    defaultSeverity: "MAJEUR",
    severityAdjustable: false,
    protected: true,
    params: [
      {
        key: "extraKnownTokens",
        kind: "terms",
        label: "Additional known tokens",
        help: 'Token names your SFMC instance uses, without the %% (e.g. "civilite"). Matched on the start of the token.',
        default: [],
        maxItems: 40,
      },
    ],
  },
  {
    id: "test-name-nomenclature",
    label: "Test name follows the naming convention",
    description:
      'The subject of a test send must read "[test number - campaign name - market - audience] Subject line".',
    family: "content",
    defaultSeverity: "MINEUR",
    severityAdjustable: true,
  },
  {
    id: "copyright-year",
    label: "Copyright year in the footer is current",
    description: "Flags a footer still showing a past year.",
    family: "content",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
    extendedOnly: true,
  },

  // ---------------------------------------------------------------- links
  {
    id: "broken-links",
    label: "No broken link",
    description:
      "Every link is opened for real (HTTP). A link that answers an error or leads nowhere blocks the send.",
    family: "links",
    defaultSeverity: "CRITIQUE",
    severityAdjustable: false,
    protected: true,
  },
  {
    id: "suspicious-links",
    label: "No suspicious link",
    description:
      "Link that responds oddly (soft 404, unexpected redirect chain) without being clearly broken.",
    family: "links",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
  },
  {
    id: "staging-links",
    label: "No link to a test environment",
    description:
      "A staging/preprod/localhost URL left in the email exposes an internal environment to customers.",
    family: "links",
    defaultSeverity: "CRITIQUE",
    severityAdjustable: false,
    protected: true,
    params: [
      {
        key: "extraTerms",
        kind: "terms",
        label: "Additional test-environment markers",
        help: 'Plain fragments matched literally in the URL (e.g. "uat.", "recette.").',
        default: [],
        maxItems: 30,
      },
    ],
  },
  {
    id: "empty-anchor-cta",
    label: "No CTA without a destination",
    description: 'A button or link whose href is empty or "#" does nothing when clicked.',
    family: "links",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
  },
  {
    id: "ampscript-redirect",
    label: "AMPscript links are properly built",
    description:
      "A Salesforce variable used in an href without RedirectTo() produces a link that leads nowhere once sent.",
    family: "links",
    defaultSeverity: "CRITIQUE",
    severityAdjustable: false,
    protected: true,
  },
  {
    id: "cn-domain-mix",
    label: "No Chinese domain in a non-Chinese email",
    description:
      "A .cn destination in an email targeting another market means the wrong link was used.",
    family: "links",
    defaultSeverity: "auto",
    severityAdjustable: false,
  },
  {
    id: "brand-allowed-domains",
    label: "Links stay on the maison's domains",
    description:
      "Any destination outside the domains declared for the brand is reported, except the social networks listed below.",
    family: "links",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
    params: [
      {
        key: "socialExemptions",
        kind: "terms",
        label: "Always-allowed social domains",
        help: "Domain fragments never reported as outside the brand.",
        default: [
          "facebook",
          "instagram",
          "linkedin",
          "twitter",
          "x.com",
          "youtube",
          "tiktok",
        ],
        maxItems: 40,
      },
    ],
  },
  {
    id: "malformed-url",
    label: "No malformed URL",
    description: 'Unencoded space or double "?" in a static link.',
    family: "links",
    defaultSeverity: "MINEUR",
    severityAdjustable: true,
    extendedOnly: true,
  },

  // ------------------------------------------------------------- tracking
  {
    id: "utm-campaign-consistency",
    label: "Same utm_campaign across all links",
    description: "Two different utm_campaign values in one email split the campaign reporting.",
    family: "tracking",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
  },
  {
    id: "utm-missing",
    label: "No link left untagged",
    description:
      "Reports links with no UTM at all while others have them (functional links — unsubscribe, online version, privacy — are excluded).",
    family: "tracking",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
  },
  {
    id: "utm-source-salesforce",
    label: "utm_source carries the Salesforce campaign name",
    description:
      "Checked on the hrefs AND on the final URLs after redirection, against the campaign name from the brief.",
    family: "tracking",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
  },
  {
    id: "utm-campaign-market",
    label: "utm_campaign matches the market of the variant",
    description:
      'The market read in the test name ("[… - MX - F]") must be the utm_campaign value. Falls back to the detected language when the subject has no test prefix.',
    family: "tracking",
    defaultSeverity: "auto",
    severityAdjustable: false,
  },

  // ------------------------------------------------------- deliverability
  {
    id: "auth-dmarc",
    label: "DMARC — the email is recognised as coming from the brand",
    description:
      "The check mailbox providers use to confirm the sender identity. A failure means Gmail and Outlook would reject the email or file it as spam.",
    family: "deliverability",
    defaultSeverity: "auto",
    severityAdjustable: false,
    protected: true,
  },
  {
    id: "auth-dkim",
    label: "DKIM — the email is signed by the brand",
    description:
      "Digital signature proving the email was not altered in transit and really comes from the maison's domain.",
    family: "deliverability",
    defaultSeverity: "auto",
    severityAdjustable: false,
    protected: true,
  },
  {
    id: "auth-spf",
    label: "SPF — the sending server is authorised",
    description:
      "Informational when DMARC passes (normal for SFMC sends), blocking when nothing else compensates.",
    family: "deliverability",
    defaultSeverity: "auto",
    severityAdjustable: false,
    protected: true,
  },
  {
    id: "auth-missing",
    label: "An authentication verdict is available",
    description:
      "Reports emails the mailbox provider never authenticated (internal routing, direct insertion) — deliverability cannot be confirmed on those.",
    family: "deliverability",
    defaultSeverity: "MINEUR",
    severityAdjustable: true,
  },
  {
    id: "unsubscribe-link",
    label: "A working unsubscribe link is present",
    description:
      "Legal obligation (CAN-SPAM/GDPR) and a Gmail/Yahoo requirement. Off by default because Kering footers are handled at the SFMC template level, outside the brief scope.",
    family: "deliverability",
    defaultSeverity: "CRITIQUE",
    severityAdjustable: true,
    extendedOnly: true,
  },
  {
    id: "one-click-unsubscribe",
    label: "One-click unsubscribe is enabled",
    description:
      "The List-Unsubscribe-Post header required by Gmail and Yahoo for bulk senders since 2024.",
    family: "deliverability",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
    extendedOnly: true,
  },

  // ------------------------------------------------------------ technical
  {
    id: "html-size",
    label: "HTML stays under the Gmail clipping limit",
    description:
      'Past the limit Gmail cuts the email ("Message clipped") and the open-tracking pixel is lost.',
    family: "technical",
    defaultSeverity: "auto",
    severityAdjustable: false,
    params: [
      {
        key: "clipKb",
        kind: "int",
        label: "Clipping limit",
        // « Critical » est cité comme le LIBELLÉ que la personne va lire, pas
        // comme une échelle de sévérité qu'on réglerait ici : c'est le badge
        // rendu par components/badges.tsx et la valeur de la colonne dans
        // l'export Excel (app/api/export/route.ts). Une aide qui décrit la
        // conséquence sans nommer ce mot obligerait le lecteur à faire la
        // traduction lui-même devant son rapport.
        // Ce que le réglage NE fait PAS : proposer un niveau. `html-size` porte
        // `severityAdjustable: false` et `defaultSeverity: "auto"` — le nombre
        // déplace la frontière, jamais l'étiquette. D'où le contraste explicite
        // avec l'aide de `warnKb` juste en dessous.
        help: 'Above this size the email is reported at the highest level, badged "Critical", instead of merely flagged as close to the limit.',
        min: 50,
        max: 200,
        default: 102,
        unit: "KB",
      },
      {
        key: "warnKb",
        kind: "int",
        label: "Warning threshold",
        help: "Above this size the email is flagged as close to the limit.",
        min: 30,
        max: 200,
        default: 90,
        unit: "KB",
      },
    ],
  },
  {
    id: "image-alt",
    label: "Images have fallback text",
    description:
      "Many mailboxes block images by default: without an alt attribute the recipient sees an empty frame.",
    family: "technical",
    defaultSeverity: "MAJEUR",
    severityAdjustable: true,
    extendedOnly: true,
  },
  {
    id: "image-dimensions",
    label: "Images have fixed dimensions",
    description: "Without width/height, Outlook can render an image at an aberrant size.",
    family: "technical",
    defaultSeverity: "MINEUR",
    severityAdjustable: true,
    extendedOnly: true,
  },

  // ---------------------------------------------------------------- brand
  {
    id: "brand-editorial-rules",
    label: "Brand editorial rules (mechanical checks)",
    description:
      "Runs the brand rules that can be verified literally: forbidden terms, required wording, maximum subject length.",
    family: "brand",
    defaultSeverity: "auto",
    severityAdjustable: false,
  },
];

export const RULE_BY_ID: Record<string, RuleCatalogEntry> = Object.fromEntries(
  RULE_CATALOG.map((r) => [r.id, r])
);

/** Ids RETIRÉS du catalogue, conservés pour mémoire. Un id est un CONTRAT : il
 *  ne doit jamais disparaître en silence (la config persistée y fait référence)
 *  ni être RÉUTILISÉ pour une autre règle — un ancien override se rappliquerait
 *  alors à un contrôle qui n'a rien à voir.
 *
 *  CE QUI EST RÉELLEMENT TENU, et il faut le lire avant de s'y fier : la seule
 *  moitié du contrat qui a un instrument est la NON-RÉUTILISATION. Les deux
 *  seuls lecteurs de cette liste (la garde au chargement de lib/rule-registry.ts
 *  et son test) vont dans le sens « inscrit ici ⟹ absent du catalogue ».
 *
 *  L'autre moitié — « inscrire un id qu'on retire » — n'a AUCUN vérificateur.
 *  Rien ne rougit quand une règle quitte le catalogue sans passer par ici : il
 *  faudrait pour ça un inventaire gelé des ids DÉJÀ LIVRÉS, et cette liste ne
 *  peut pas le fournir puisqu'elle est justement ce qu'on oublie de remplir.
 *  Ce commentaire annonçait un test qui n'existe pas ; c'est la promesse qui a
 *  été corrigée, pas le code. Tant que l'inventaire n'existe pas, l'inscription
 *  reste un geste de discipline, à faire quand l'id a pu ATTEINDRE une config
 *  persistée — un id créé et supprimé sans jamais être livré n'est référencé
 *  nulle part, et l'inscrire lui interdirait sans raison sa propre réutilisation
 *  par son auteur.
 *
 *  CHANTIER ÉCARTÉ, noté pour qu'il ne soit pas rouvert par erreur : typer les
 *  ids (`RuleId` dérivé du catalogue, via `as const satisfies` — aujourd'hui
 *  l'annotation `RULE_CATALOG: RuleCatalogEntry[]` efface les types littéraux,
 *  et c'est elle qui coûte la garde). Ça marche, et ça rendrait rouge au
 *  typecheck tout `cfg.enabled("id-disparu")`.
 *
 *  Mais ça garde les APPELS ÉCRITS DANS LE CODE, pas les ids DORMANT DANS UNE
 *  CONFIG STOCKÉE — or c'est ce second cas, et lui seul, qui motive cette liste.
 *  Bonne garde, autre problème. Ne pas la rouvrir en croyant régler RETIRED_IDS.
 *
 *  La même borne vaut pour `AgentRun.key`, resserré de `string` à un type dans
 *  lib/types.ts : il contraint les écritures futures, jamais les données au
 *  repos. Un type ne repasse pas sur ce qui est déjà sur le disque. */
export const RETIRED_IDS: string[] = [];

/** Sévérités proposées pour une règle écrite à la main. CRITIQUE est
 *  volontairement ABSENT : une règle jugée par un LLM ne doit pas pouvoir
 *  bloquer un envoi à elle seule. */
export const CUSTOM_RULE_SEVERITIES: AdjustableSeverity[] = ["MAJEUR", "MINEUR"];

export const CUSTOM_RULE_MAX = 20;
export const CUSTOM_RULE_MAX_CHARS = 2000;

/** Titre d'une règle écrite à la main. Exporté depuis ce module client-safe
 *  pour que le champ de saisie et le schéma d'écriture lisent LA MÊME borne :
 *  recopiée dans la page, elle dérive en silence — le jour où la borne monte,
 *  l'écran continue de couper à l'ancienne valeur et personne ne le voit. */
export const CUSTOM_RULE_TITLE_MAX = 120;

/** Catégories créées à la main depuis /rules, EN PLUS des familles du catalogue
 *  (FAMILY_LABELS), qui restent disponibles comme catégories implicites. Le
 *  plafond a la même raison d'être que CUSTOM_RULE_MAX : une liste sans borne
 *  rend la page illisible et gonfle chaque écriture de la config. */
export const CUSTOM_CATEGORY_MAX = 12;
export const CUSTOM_CATEGORY_LABEL_MAX = 40;

/** Exemples attachés à une règle. Ils partent dans le prompt de l'agent avec
 *  l'instruction : leur nombre et leur longueur plafonnent donc ce qu'une règle
 *  peut y injecter, et bornent le coût du contexte. */
export const RULE_EXAMPLES_MAX = 6;
export const RULE_EXAMPLE_MAX_CHARS = 300;

/** Bornes de l'intitulé et de la description réécrits par le métier sur une
 *  règle du CATALOGUE. Exportées pour que la page et le schéma d'écriture
 *  lisent la MÊME valeur : un `maxLength` d'input qui diverge de la borne
 *  serveur produit une saisie acceptée à l'écran puis refusée à la sauvegarde. */
export const RULE_LABEL_MAX = 120;
export const RULE_DESCRIPTION_MAX = 400;

// --- Texte affiché : réécriture du métier, sinon code -----------------------

// L'intitulé d'une règle a DEUX sources possibles. Recalculer ce choix à chaque
// endroit qui affiche un nom, c'est se garantir qu'un des endroits finira par
// afficher l'autre : un message d'erreur qui nomme une règle sous son libellé
// de code, alors que le métier l'a renommée, désigne pour la personne une règle
// introuvable dans sa page. Ces deux helpers sont le SEUL point de décision.
//
// Ils vivent ICI et pas dans lib/rule-config.ts, où `RuleOverride` est défini :
// ce module-là importe `crypto` et lit process.env — or /rules est un composant
// client et affiche ces mêmes textes (cf. la frontière en tête de fichier).
// lib/rule-config.ts les importe pour ses messages d'erreur.
//
// Le second paramètre est `RuleOverride` et non une forme réduite à `label` et
// `description` : un objet littéral écrit sur place et portant d'autres champs
// (`{ enabled: false }`, pour vérifier qu'un override SANS réécriture ne change
// rien) serait refusé par le contrôle de propriétés excédentaires — or c'est un
// appel légitime. Le type est importé en `import type`, effacé à la
// compilation : rien n'entre dans le graphe de modules.

/** Intitulé réécrit par le métier, sinon celui du code. Un texte réduit à des
 *  espaces ne compte pas : il effacerait le nom de la règle à l'écran. */
export function effectiveLabel(entry: RuleCatalogEntry, override?: RuleOverride): string {
  return override?.label?.trim() || entry.label;
}

/** Même règle que `effectiveLabel`, pour la description. */
export function effectiveDescription(entry: RuleCatalogEntry, override?: RuleOverride): string {
  return override?.description?.trim() || entry.description;
}

export const SEVERITY_LABELS: Record<AdjustableSeverity, string> = {
  CRITIQUE: "Critical",
  MAJEUR: "Major",
  MINEUR: "Minor",
};
