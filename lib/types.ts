// Modèle de données central — la CAMPAGNE est l'objet racine.

// Import type-only : effacé à la compilation, pas de cycle runtime avec ./analyze.
import type { AnalyzeEvent } from "./analyze";
// Idem, et lib/agent-catalog.ts ne dépend de RIEN : aucun cycle possible.
import type { AgentKey } from "./agent-catalog";

/** Producteurs de lignes de rapport qui NE SONT PAS des agents : contrôles
 *  déterministes, sans prompt, et vers lesquels aucune règle n'est routée. Ils
 *  ont besoin d'une clé pour la même raison que les agents — rattacher leurs
 *  `unverifiedRuleIds` à quelque chose — mais emprunter une clé d'agent leur
 *  ferait revendiquer un routage qui n'existe pas.
 *
 *  Un seul membre aujourd'hui, et c'est voulu : cette liste ne grandit que
 *  lorsqu'un producteur non-agent apparaît réellement.
 *
 *  Ne PAS y ajouter `translation`, mais pas pour la raison qu'on croit : voir
 *  WorkerOnlyKey juste en dessous. */
export type ReportProducerKey = "template";

/** Worker LLM qui produit une ligne de rapport SANS figurer dans AGENT_CHOICES.
 *
 *  `translation` n'est pas un contrôle déterministe — c'est bien un modèle qu'on
 *  interroge, avec un prompt — donc il n'a rien à faire dans ReportProducerKey.
 *  Mais il n'est pas non plus un `AgentKey` : AGENT_CHOICES est la liste des
 *  agents vers lesquels on peut ROUTER une règle depuis /rules, et celui-ci
 *  n'accepte aucune règle routée. Il arbitre une entrée fixe (les écarts de
 *  traduction relevés par le code) avec un outil forcé. Zéro règle du catalogue
 *  LLM lui est confiée, et `rerouteOrphanAgent` renverrait vers guidelines toute
 *  règle custom qui le désignerait. Son absence du catalogue est donc cohérente,
 *  pas un oubli — et l'y ajouter offrirait dans /rules un agent qui ne lirait
 *  jamais ce qu'on lui confie.
 *
 *  Mesuré le 03/09 à 14:30:59, parce que les deux listes ont la MÊME LONGUEUR
 *  (7 et 7) et que la différence est un échange, invisible à un simple décompte :
 *    worker sans entrée au catalogue : ["translation"]
 *    entrée sans worker              : ["vision"]
 *  `vision` est l'inverse — une entrée de catalogue servie hors de WORKERS, par
 *  lib/render-vision.ts. Ne pas « réparer » l'un des deux sans mesurer l'autre. */
export type WorkerOnlyKey = "translation";

export type Severity = "CRITIQUE" | "MAJEUR" | "MINEUR" | "OK";

export type CampaignStatus =
  | "BRIEF_RECU"
  | "EMAIL_ATTENDU"
  | "EN_ANALYSE"
  | "NO_GO"
  | "CORRECTIONS"
  | "GO_AVEC_RESERVES"
  | "GO"
  | "ENVOYE";

/** Les trois seules valeurs qu'un verdict de rapport peut prendre.
 *  La règle qui les produit est `computeVerdict` (lib/aggregate.ts), avec
 *  l'historique de la décision. Ne jamais tester `verdict !== "GO"` pour savoir
 *  si l'envoi est bloqué : utiliser `isBlocking` — seul NO_GO bloque. */
export type Verdict = "GO" | "GO_AVEC_RESERVES" | "NO_GO";

export interface BriefField {
  value: string | null;
  quote: string | null; // extrait verbatim du brief, vérifié en code
  confidence: "high" | "medium" | "low";
}

export interface BriefExtraction {
  campaign_name: BriefField;
  market: BriefField;
  email_type: BriefField;
  target_audience: BriefField;
  send_datetime: BriefField;
  subject_line: BriefField;
  preheader: BriefField;
  key_message: BriefField;
  offer: BriefField;
  promo_code: BriefField;
  cta_label: BriefField;
  landing_urls: BriefField;
  utm_campaign: BriefField;
  legal_mentions: BriefField;
  // Champs xlsm Kering (feuille Common / EMAIL) — optionnels, tolérants
  campaign_type?: BriefField; // ex "ADHOC"
  campaign_subtype?: BriefField; // ex "GLOBAL"
  campaign_category?: BriefField; // ex "OTO"
  salesforce_campaign_name?: BriefField; // ex "ADHOC_GLOBAL_OTO_EMAIL_20260714_Le7BowlingBag"
  missing_fields: string[];
}

// --- Grille multilingue du brief (ex: BAL Newsletter — colonnes par langue) ---

/** Un bloc de contenu du brief (Subject line, COPY 1, CTA 1...) décliné par langue.
 *  Les clés de valueByLang sont les codes langue CANONIQUES (voir lib de canonicalisation). */
export interface BriefBlock {
  name: string; // ex "Subject line", "CTA 1"
  valueByLang: Record<string, string>;
}

/** Liens attendus pour un bloc : lien WW (worldwide) et/ou CN (Chine).
 *  Le bon lien dépend du marché du mail testé. */
export interface ExpectedLink {
  block: string; // nom du bloc (ex "CTA 1")
  ctaLabelByLang?: Record<string, string>;
  /** Lien attendu par marché : { WW, CN, JP, US… } — tout marché capté, pas que WW/CN. */
  linksByMarket?: Record<string, string>;
  ww?: string; // "WW Linkthrough" (raccourci compat = linksByMarket.WW)
  cn?: string; // "CN Linkthrough" (raccourci compat = linksByMarket.CN)
}

/** Grille complète extraite d'un brief type BAL : langues (codes canoniques,
 *  y compris groupes ambigus type "EN|US-CA" traités comme même langue), blocs, liens. */
export interface BriefGridMeta {
  /** Nom de campagne Salesforce lu DÉTERMINISTIQUEMENT dans le template
   *  (feuille EMAIL, ligne "Campaign Name") — prioritaire sur l'extraction LLM. */
  salesforceCampaignName?: string;
  /** Le contenu ressemble aux placeholders du template Kering ("Dear [Name],
   *  discover…", liens brand.com) : probablement un TEMPLATE VIERGE uploadé
   *  par erreur à la place du brief final → avertissement dans l'UI. */
  isLikelyTemplate?: boolean;
  /** Provenance de la grille : parseur déterministe (défaut) ou plan du
   *  structure scout LLM (lib/brief-scout). */
  meta?: { source?: "deterministic" | "scout" };
}

export interface BriefGrid extends BriefGridMeta {
  languages: string[];
  blocks: BriefBlock[];
  expectedLinks: ExpectedLink[];
  /** Libellé de colonne ORIGINAL du fichier par code canonique (ex ES → "MX",
   *  PT → "BR") — l'UI affiche le terme du brief, jamais le code interne
   *  (exigence fidélité : reprendre 100% les termes du Excel). */
  langLabels?: Record<string, string>;
}

/** Visuel/maquette embarqué dans le brief (image extraite du xlsx ou uploadée). */
export interface BriefMockup {
  name: string;
  mimeType: string;
  dataUrl: string;
  width?: number;
  height?: number;
  source: "xlsx" | "upload";
}

export interface Finding {
  id: string;
  agent: string; // ajouté par l'orchestrateur, jamais par le LLM
  categorie:
    | "assets"
    | "liens"
    | "tracking"
    | "brief"
    | "guidelines"
    | "contenu"
    | "rendu"
    | "delivrabilite"
    | "technique";
  severite: Severity;
  /** Titre harmonisé (une des valeurs de lib/finding-titles). OPTIONNEL : les
   *  rapports persistés d'avant n'en ont pas → fallback titleForFinding(). */
  title?: string;
  message: string;
  evidence: string; // ≤ 300 chars
  locator: string; // sélecteur CSS / "subject" / "header:list-unsubscribe" / index lien
  suggestion?: string;
  source: "regle" | "agent"; // règle déterministe vs jugement LLM
  /** Id de la règle du catalogue (lib/rule-catalog) qui a produit ce finding.
   *  Présent sur les findings déterministes uniquement — sert au pilotage
   *  depuis /rules et au compteur "déclenchements récents". Optionnel : les
   *  rapports persistés avant cette fonctionnalité n'en ont pas. */
  ruleId?: string;
  quoteVerified?: boolean;
  /** Comparaison Attendu (brief) ↔ Reçu (email) — l'UI affiche un diff surligné. */
  expected?: string;
  received?: string;
  // revue humaine
  review?: "faux_positif" | "accepte" | "corrige";
}

export interface LinkCheckResult {
  href: string;
  finalUrl?: string;
  text: string;
  kind: "statique" | "ampscript" | "tracked" | "mailto" | "anchor";
  status: "ok" | "casse" | "suspect" | "non_verifiable" | "non_teste";
  httpStatus?: number;
  redirects?: number;
  reason?: string;
  utm: Record<string, string>;
  wasSafeLinkWrapped?: boolean;
  finalUtm?: Record<string, string>; // utm sur l'URL FINALE (après redirections)
  /** Comparaison au lien attendu du brief (WW vs CN selon le marché du mail testé). */
  expectedMatch?: { expectedUrl: string; market: "WW" | "CN"; ok: boolean };
}

export interface EmailFacts {
  subject?: string;
  preheader?: string;
  htmlSizeBytes: number;
  links: Array<{
    index: number;
    href: string;
    text: string;
    kind: LinkCheckResult["kind"];
    utm: Record<string, string>;
    otherParams?: Record<string, string>; // params non-utm (ex e=...)
    inMsoBlock: boolean;
  }>;
  images: Array<{
    index: number;
    src: string;
    alt: string | null;
    width?: string;
    height?: string;
    isTrackingPixel: boolean;
    kind: "remote" | "cid" | "data";
  }>;
  textBlocks: string[];
  msoBlockCount: number;
  hasUnsubscribeLink: boolean;
  personalizationTokens: string[]; // %%...%% trouvés
  ampscriptSnippets: string[];
  footerText?: string;
  lang?: string;
}

export interface AgentRun {
  /** LIBELLÉ affiché ("Assets & images"). Ne PAS s'en servir pour router :
   *  il est traduit, réécrit, et deux agents peuvent finir homonymes. */
  agent: string;
  /** CLÉ du producteur de cette ligne — la seule chose qui la relie aux règles
   *  dont elle rend compte, le routage se faisant par clé et non par libellé.
   *  Optionnel : les rapports enregistrés avant ce champ n'en ont pas, et
   *  `undefined` doit se lire « inconnu », jamais « aucune règle ».
   *
   *  TYPÉ, et non `string`, parce qu'une clé inventée pour faire passer un test
   *  au vert ne serait rattrapée par rien : elle ne résout vers aucune entrée,
   *  et aucun outil ne peut contredire une chaîne libre. Ici une faute de frappe
   *  est rouge au typecheck.
   *
   *  ⚠️ CETTE GARDE NE PROTÈGE QUE LE CODE ÉCRIT. Un `key` déjà couché dans un
   *  rapport JSON stocké ne sera jamais retypé — le type contraint les
   *  écritures futures, pas les données au repos. Ne pas la présenter comme une
   *  garantie sur l'existant : c'est la même borne que celle qui a fait écarter
   *  un `RuleId` typé pour régler RETIRED_IDS (voir lib/rule-catalog.ts).
   *
   *  Resserrer était sans risque sur les données : mesuré côté rapports
   *  stockés, 133 rapports / 892 lignes d'agent / 0 `key` renseignée. */
  key?: AgentKey | WorkerOnlyKey | ReportProducerKey;
  status: "pending" | "running" | "done" | "error" | "skipped";
  detail?: string;
  /** Règles actives confiées à cet agent qu'AUCUN modèle n'a lues, parce qu'il
   *  n'a pas tourné. Renseigné uniquement quand c'est le cas : une liste vide et
   *  une liste absente disent la même chose, « rien à signaler ici », alors
   *  qu'une liste non vide est un constat — ces règles-là sont éteintes de fait
   *  alors que /rules les affiche « On ». */
  unverifiedRuleIds?: string[];
  findingsCount?: number;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface AnalysisReport {
  id: string;
  campaignId: string;
  versionId: string;
  createdAt: string;
  /** Trois états — voir `Verdict` dans lib/aggregate.ts pour la règle et son
   *  historique. Les rapports antérieurs au 04/09/2026 ne portent que "GO" ou
   *  "NO_GO" : c'est une valeur STOCKÉE, jamais à recalculer pour l'afficher. */
  verdict: Verdict;
  counters: { critiques: number; majeurs: number; mineurs: number; passed: number };
  findings: Finding[];
  passedChecks: Array<{ categorie: string; label: string; ruleId?: string }>;
  executiveSummary: string; // rédigé par le juge (streamé)
  /** Version de la configuration des règles (/rules) utilisée pour cette
   *  analyse — traçabilité "avec quels réglages ce verdict a été rendu".
   *  Absent sur les rapports antérieurs : tout consommateur doit le tolérer. */
  configVersion?: number;
  agents: AgentRun[];
  linkResults: LinkCheckResult[];
  facts?: EmailFacts;
  degraded?: boolean; // mode code-only si LLM indisponible
  headerChecks?: HeaderChecks;
  logs?: string[]; // journal d'exécution (terminal live)
}

export interface HeaderChecks {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  from?: string;
  authResultsRaw?: string;
  /** Verdict structuré recalculé à l'analyse depuis rawMime (lib/auth-results). */
  authResults?: AuthResultsSummary;
}

/** Résultat structuré de l'en-tête Authentication-Results (RFC 8601) retenu.
 *  Une entrée dkim PAR signature (les envois SFMC en portent ≥2 : marque + ESP). */
export interface AuthResultsSummary {
  present: boolean;
  /** L'en-tête retenu vient bien du récepteur attendu (authserv-id vérifié selon
   *  la source d'ingestion). false = .eml importé ou authserv-id inattendu :
   *  verdict affiché mais plafonné (jamais CRITIQUE). */
  trusted: boolean;
  authservId?: string;
  spf?: { result: string; mailfrom?: string };
  dkim: Array<{ result: string; domain?: string; selector?: string; alignedWithFrom?: boolean }>;
  dmarc?: { result: string; fromDomain?: string; policy?: string };
  compauth?: { result: string; reason?: string };
  raw?: string;
}

export interface EmailVersion {
  id: string;
  label: string; // v1, v2...
  /** Nom réel du mail : sujet (gmail/outlook/.eml) ou nom de fichier (upload). */
  name?: string;
  /** Id du message chez le provider (gmail/outlook) — permet de rouvrir le
   *  mail dans le vrai client web pour le rendu réel (screenshot Playwright). */
  providerMessageId?: string;
  receivedAt: string;
  source: "upload" | "gmail" | "outlook" | "colle";
  html: string;
  rawMime?: string;
  headerChecks?: HeaderChecks;
  reportId?: string;
  language?: string; // code langue canonique détecté/déclaré pour cette version
  market?: "WW" | "CN"; // marché du mail testé (détermine le lien attendu WW vs CN)
}

/** État du structure scout LLM pour le brief courant d'une campagne.
 *  - skipped : parse déterministe propre, scout inutile (fast-path 0 LLM) ;
 *  - running : plan en cours d'analyse en arrière-plan ;
 *  - applied : la grille du scout a REMPLACÉ une grille absente ;
 *  - proposed : une grille existait déjà → proposition à appliquer via bouton ;
 *  - user_edited : la grille a été modifiée à la main après le scout ;
 *  - rejected/error : plan invalide ou LLM indisponible — la grille
 *    déterministe reste la vérité, warnings visibles. */
export interface BriefScoutState {
  status: "skipped" | "running" | "applied" | "proposed" | "user_edited" | "rejected" | "error";
  fileHash: string;
  /** Départ du job — un "running" plus vieux que ~3 min est périmé (process
   *  redémarré) : l'UI ré-autorise "Re-parse with AI". */
  startedAt?: string;
  confidence?: number;
  /** Plan persisté (audit/rejeu) — BriefParsePlan de lib/schemas. */
  plan?: unknown;
  /** Grille proposée (statut "proposed") en attente d'application. */
  proposedGrid?: BriefGrid;
  finishedAt?: string;
}

export interface Campaign {
  id: string;
  name: string;
  brandId?: string;
  period: string; // ex "2026-T3"
  status: CampaignStatus;
  humanDecision?: "GO" | "NO_GO";
  humanDecisionAt?: string;
  briefRaw?: string;
  briefExtraction?: BriefExtraction;
  briefMarkets?: string[]; // marchés détectés dans un brief multi-marché (colonnes Excel)
  briefMarket?: string; // marché sélectionné pour l'extraction
  /** Extractions par langue CANONIQUE (le brief est PAR LANGUE, pas par pays).
   *  Clé = code langue canonique ou groupe ambigu (ex "EN|US-CA" : même texte anglais). */
  briefExtractions?: Record<string, BriefExtraction>;
  briefGrid?: BriefGrid; // grille multilingue brute (blocs x langues + liens WW/CN)
  briefMockups?: BriefMockup[]; // visuels extraits du brief
  /** Nom du FICHIER importé (provenance) — affiché partout : les briefs Kering
   *  ont des noms très proches, sans ça impossible de savoir lequel a été lu. */
  briefFileName?: string;
  /** Jeton de génération d'import : invalide les extractions LLM de fond d'un
   *  import PRÉCÉDENT (sinon le mauvais fichier pollue le bon 30s après). */
  briefImportId?: string;
  /** Éléments présents dans le brief mais non captés par le parsing (audit LLM, non bloquant). */
  briefParseWarnings?: string[];
  /** Famille de mise en page reconnue par le parseur (BriefParseTelemetry.family)
   *  au moment de l'import. Décide si le template canonique gouverne ce brief :
   *  sans elle, un brief `grid` dont quelques libellés s'apparient rend un ÉCART
   *  détaillé au lieu d'un « hors périmètre » (mesuré sur la newsletter
   *  Balenciaga : 3 champs reconnus, 10 requis déclarés manquants).
   *
   *  DÉLIBÉRÉMENT ici et NON dans BriefGrid, pour deux raisons de même nature :
   *   - `briefGrid` est dans la liste blanche du PATCH
   *     (app/api/campaigns/[id]/route.ts:33) : la mettre dedans rendrait
   *     CLIENT-MODIFIABLE le champ qui décide qu'un verdict est émis ;
   *   - la grille a trois écrivains (parse déterministe, scout LLM, édition
   *     manuelle) et deux d'entre eux n'ont aucune télémétrie — le champ
   *     repartirait à `undefined` à la première correction à la main. La famille
   *     est une propriété du FICHIER importé, pas de la grille qu'on en tire :
   *     rangée ici, elle survit correctement aux retouches de la grille.
   *
   *  `undefined` n'est PAS « autre famille » : il dit qu'on n'a pas mesuré
   *  (campagne importée avant ce champ). Les deux se replient sur le même
   *  résultat — pas de verdict — mais pas sur le même sens, et afficher le
   *  premier fabriquerait un constat à partir d'une date d'import. */
  briefFamily?: "field_value" | "grid" | "none";
  /** Référentiel de brief contre lequel CETTE campagne est jugée. ÉPINGLÉ à la
   *  création, au dernier template créé (`latestTemplateId`).
   *
   *  Épinglé et non recalculé à chaque analyse : sans ça, créer un template
   *  changerait rétroactivement le référentiel de toutes les campagnes en cours,
   *  y compris celles dont un rapport a déjà été rendu — le verdict affiché et
   *  le verdict rejoué ne diraient plus la même chose, et rien ne le signalerait.
   *
   *  `undefined` est un TROISIÈME ÉTAT, pas « le template livré » : les
   *  campagnes créées avant ce champ n'en ont pas. Elles retombent sur le repli,
   *  ce qui est le comportement qu'elles ont toujours eu — mais l'absence dit
   *  « jamais épinglé », pas « épinglé sur le défaut ».
   *
   *  DÉLIBÉRÉMENT hors de la liste blanche du PATCH
   *  (app/api/campaigns/[id]/route.ts) pour la même raison que `briefFamily` :
   *  rendre client-modifiable le champ qui décide contre quoi on mesure. */
  templateId?: string;
  /** Chemin local du fichier Excel importé (rejouable par le structure scout). */
  briefFilePath?: string;
  /** État du structure scout LLM (lib/brief-scout) pour ce brief. */
  briefScout?: BriefScoutState;
  expectedLanguages?: string[]; // langues attendues (codes canoniques)
  salesforceCampaignName?: string; // ex ADHOC_GLOBAL_OTO_EMAIL_20260714_Le7BowlingBag (attendu en utm_source)
  /** Règles éditoriales au niveau CAMPAGNE (le brief porte ses propres règles).
   *  Si présentes et non vides, elles priment sur brand.compiledRules. */
  rules?: BrandRule[];
  versions: EmailVersion[];
  createdAt: string;
  updatedAt: string;
  sendDate?: string;
}

export type RuleEngine = "code" | "llm" | "hybrid";

export interface BrandRule {
  id: string;
  title: string;
  description: string;
  category: "lexical" | "tone" | "format" | "structure" | "legal" | "links";
  engine: RuleEngine;
  severity: "error" | "warning" | "suggestion";
  params?: {
    check?:
      | "forbidden_terms"
      | "required_text"
      | "regex"
      | "max_length"
      | "link_domains";
    tokens?: string[];
    exactText?: string;
    max?: number;
  };
  examples?: { good: string[]; bad: string[] };
  exceptions?: string[];
  enabled: boolean;
}

export interface Brand {
  id: string;
  name: string;
  allowedLinkDomains: string[];
  referenceLogoUrl?: string;
  brandColors?: string[];
  guidelinesSourceText: string;
  compiledRules: BrandRule[];
  compiledAt?: string;
  version: number;
}

export interface MailboxConnection {
  provider: "gmail" | "outlook";
  email?: string;
  connectedAt?: string;
  lastSyncAt?: string;
  status: "connected" | "disconnected" | "error";
  error?: string;
}

export interface InboxEmail {
  id: string;
  provider: "gmail" | "outlook";
  providerMessageId: string;
  subject: string;
  from: string;
  receivedAt: string;
  html?: string;
  rawMime?: string;
  headerChecks?: HeaderChecks;
  campaignId?: string; // rattachement
  matchScore?: number;
  matchConfirmed?: boolean;
  language?: string; // code langue canonique détecté
  favorite?: boolean; // marqué favori par l'utilisateur
}

/** Job d'analyse persisté (survit aux déconnexions SSE / changements de page).
 *  Les events sont appendés au fil de l'analyse et rejoués à la reconnexion. */
export interface AnalysisJob {
  id: string;
  campaignId: string;
  versionIds: string[];
  status: "running" | "done" | "error";
  events: AnalyzeEvent[];
  createdAt: string;
  updatedAt: string;
}

/** Verdict agrégé par langue pour le report GO/NO-GO multilingue. */
export interface LanguageVerdict {
  lang: string; // code langue canonique (ou groupe ex "EN|US-CA")
  label: string; // libellé affichable
  /** "—" = cette langue n'a pas encore de rapport. Distinct de "GO". */
  verdict: Verdict | "—";
  counters: { critiques: number; majeurs: number; mineurs: number };
  /** Nombre total de findings actifs (hors findings arbitrés en review). */
  total: number;
  /** Findings actifs par critère métier (clé = Criterion.key de lang-report). */
  byCriterion: Record<string, number>;
  versionId?: string;
  reportId?: string;
}
