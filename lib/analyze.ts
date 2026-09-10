// Orchestrateur d'analyse : pré-parse → checks code → 6 workers en parallèle
// → agrégation déterministe → juge streamé. Émet des événements SSE-friendly.

import crypto from "crypto";
import { parseEmailFacts } from "./parse-email";
import { checkLinks, linkOptionsFromConfig } from "./check-links";
import { runCodeChecks } from "./checks-code";
import { evaluateAuthResults } from "./auth-results";
import {
  TRANSLATION_RULE_ID,
  WORKERS,
  activeRuleIdsForAgent,
  buildWorkerCtx,
  runTranslationWorker,
  runWorker,
  streamExecutiveSummary,
  type TranslationArbitration,
} from "./agents";
import { captureRealRender, DEVICES, listRenders, renderSessionAvailable, VISION_DEVICES } from "./render-real";
import { runRenderVision } from "./render-vision";
import { dedupFindings, computeVerdict } from "./aggregate";
import { detectEmailLanguage, type DetectedLanguage } from "./detect-language";
import { canonLang } from "./lang-codes";
import { resolveTemplate, type ResolvedTemplate } from "./template-resolve";
import { Reports, Settings, uid } from "./store";
import {
  customRulesAsBrandRules,
  isGuidelinesRule,
  resolveRuleConfig,
  type ResolvedRuleConfig,
} from "./rule-config";
import { nonEmpty, templateConformanceRun } from "./template-conformance-run";
import type {
  AnalysisReport,
  Brand,
  BriefExtraction,
  Campaign,
  EmailFacts,
  EmailVersion,
  Finding,
  LinkCheckResult,
  Verdict,
} from "./types";

// `nonEmpty` est importé de ./template-conformance-run et non redéfini ici :
// « ne jamais écrire [] dans unverifiedRuleIds » est UNE règle, et deux copies
// d'une règle divergent. Sa justification est écrite là-bas, avec elle.

export type AnalyzeEvent =
  | { type: "log"; line: string }
  | { type: "stage"; stage: string; detail?: string }
  | { type: "agent"; agent: string; status: "running" | "done" | "error" | "skipped"; detail?: string; findingsCount?: number }
  | { type: "finding"; finding: Finding }
  | { type: "link-results"; count: number; broken: number }
  | { type: "verdict"; verdict: Verdict; counters: AnalysisReport["counters"] }
  | { type: "summary-delta"; text: string }
  | { type: "done"; reportId: string; cached?: boolean; degraded?: boolean }
  | { type: "error"; message: string };

export function contentHash(
  html: string,
  briefJson: string,
  brandVersion: number,
  extra?: string
): string {
  const h = crypto
    .createHash("sha256")
    .update(html)
    .update(briefJson)
    .update(String(brandVersion));
  if (extra) h.update(extra);
  return h.digest("hex").slice(0, 24);
}

// Copie locale du motif "désinscription" de check-links (SÉCURITÉ : un GET peut
// désabonner l'adresse de test → ces liens ne sont JAMAIS requêtés, et deux liens
// de même URL ne sont dédupliqués ensemble que s'ils ont le même statut unsub).
const UNSUB_KEY_RE =
  /unsubscribe|d[ée]sinscri|d[ée]sabonn|opt.?out|se d[ée]sinscrire|preference center|g[ée]rer mes pr[ée]f[ée]rences/i;

/** Clé de déduplication d'un lien : kind + URL normalisée (sans fragment) + flag unsub. */
function linkDedupKey(l: EmailFacts["links"][number]): string {
  let href = l.href.trim();
  try {
    const u = new URL(href);
    u.hash = "";
    href = u.toString();
  } catch {
    // href non-URL (AMPscript, ancre, mailto malformé) : clé brute
  }
  const unsub = UNSUB_KEY_RE.test(l.href) || UNSUB_KEY_RE.test(l.text) ? "unsub|" : "";
  return `${l.kind}|${unsub}${href}`;
}

/** Champs de CONTENU par langue de l'extraction texte, remplacés par la grille
 *  quand elle couvre la langue du mail. L'extraction texte du xlsx aspire
 *  souvent la page MODÈLE du template (ex cta_label "Shop Now", subject
 *  "Dear [Name], discover…") → faux écarts brief↔email. La grille parsée
 *  (blocs × langues) est la source de vérité du contenu par langue. */
const GRID_COVERED_FIELDS = [
  "subject_line",
  "preheader",
  "key_message",
  "offer",
  "cta_label",
  "landing_urls",
] as const;

function stripGridCoveredFields(extraction: BriefExtraction): BriefExtraction {
  const empty = { value: null, quote: null, confidence: "low" as const };
  const out = { ...extraction };
  for (const k of GRID_COVERED_FIELDS) out[k] = empty;
  return out;
}

/** Sélectionne la BriefExtraction correspondant à la langue détectée parmi les
 *  extractions par langue (clés canoniques ou composites "EN|US-CA"). */
function pickBriefExtraction(
  extractions: Record<string, BriefExtraction> | undefined,
  detected: DetectedLanguage
): { key: string; extraction: BriefExtraction } | null {
  if (!extractions) return null;
  const candidates = detected.ambiguous ?? (detected.lang ? [detected.lang] : []);
  if (candidates.length === 0) return null;
  for (const [key, extraction] of Object.entries(extractions)) {
    const parts = key.split("|").map((p) => canonLang(p.trim()) || p.trim());
    if (parts.some((p) => candidates.includes(p))) return { key, extraction };
  }
  return null;
}

export async function analyze(opts: {
  campaign: Campaign;
  version: EmailVersion;
  brand?: Brand | null;
  emit: (e: AnalyzeEvent) => void | Promise<void>;
  noCache?: boolean;
  /** Cache partagé inter-versions (batch) : résultats HTTP par URL normalisée
   *  (clé = linkDedupKey). Les déclinaisons partagent ~80% des URLs. */
  linkCache?: Map<string, LinkCheckResult>;
  /** Configuration des règles (page /rules), lue UNE fois par lot d'analyse :
   *  les déclinaisons d'un même batch sont ainsi jugées avec exactement la même
   *  configuration, même si quelqu'un sauvegarde pendant l'exécution. */
  ruleConfig?: ResolvedRuleConfig | null;
  /** Template de brief EFFECTIF, lu une fois par lot pour la même raison que
   *  `ruleConfig` : les déclinaisons d'un batch doivent être jugées contre le
   *  même référentiel, même si quelqu'un enregistre une édition pendant que le
   *  lot tourne. */
  template?: ResolvedTemplate | null;
}): Promise<AnalysisReport> {
  const { campaign, version, brand, emit } = opts;
  const ruleConfig = opts.ruleConfig ?? resolveRuleConfig(await Settings.get());
  // Le template qui JUGE, et non la constante de code. Jusqu'ici `runCodeChecks`
  // lisait `DEFAULT_TEMPLATE` : l'éditeur écrivait dans le stockage, le classeur
  // téléchargé portait bien les champs ajoutés, et le juge continuait de mesurer
  // contre le référentiel d'origine. Un champ ajouté puis rempli revenait donc
  // « non déclaré par le template de campagne » — un écart FABRIQUÉ, dans un
  // rapport qui a exactement la forme d'une mesure réussie.
  //
  // `campaign.templateId` d'abord : le référentiel épinglé à la création. Son
  // absence (campagne antérieure au champ) retombe sur le repli, qui est le
  // comportement qu'elle a toujours eu — mais l'absence dit « jamais épinglé »,
  // pas « épinglé sur le défaut », et les deux ne doivent pas s'écrire pareil.
  const resolvedTemplate =
    opts.template ?? (await resolveTemplate(campaign.templateId ?? undefined));

  // --- Langue & brief par langue ---
  // Parse tôt (déterministe, cheerio) : la langue détectée et l'empreinte du
  // briefGrid entrent dans le hash de cache, pour ne pas rejouer un vieux
  // rapport après un changement de brief/grille.
  const facts = parseEmailFacts(version.html);
  // Sujet RÉEL (header MIME, posé à l'attach) : le HTML ne le contient pas
  // (<title> absent des emails SFMC), donc les checks objet (longueur,
  // placeholders, bloc "Subject line" de la grille) ne tournaient jamais.
  // Préfixe de test SFMC "[1293370 - … - US]" retiré : absent en production.
  if (!facts.subject && version.name) {
    const cleaned = version.name.replace(/^\[[^\]]*\]\s*/, "").trim();
    if (cleaned) facts.subject = cleaned;
  }
  const grid = campaign.briefGrid ?? null;
  let detected: DetectedLanguage = detectEmailLanguage(facts, grid);
  if (version.language) {
    // Langue déclarée à l'attache (prioritaire sur l'heuristique de contenu).
    detected = { lang: canonLang(version.language) || version.language, confidence: "high" };
  }
  const picked = pickBriefExtraction(campaign.briefExtractions, detected);
  let brief: BriefExtraction | null = picked?.extraction ?? campaign.briefExtraction ?? null;
  const salesforceCampaignName: string | null =
    campaign.salesforceCampaignName ?? brief?.salesforce_campaign_name?.value ?? null;
  // Grille = source de vérité du contenu par langue : neutraliser les champs
  // de contenu de l'extraction texte (souvent pollués par la page modèle du
  // xlsx) pour ne plus générer de faux écarts type cta_label "Shop Now".
  const gridCoversLang = Boolean(
    grid &&
      detected.lang &&
      grid.languages.some((key) =>
        key.split("|").some((p) => canonLang(p.trim()) === detected.lang)
      )
  );
  if (brief && gridCoversLang) brief = stripGridCoveredFields(brief);

  const gridFingerprint = grid
    ? crypto.createHash("sha256").update(JSON.stringify(grid)).digest("hex").slice(0, 12)
    : "no-grid";
  // Les règles au niveau campagne entrent dans le hash (comme brand.version) :
  // modifier les règles du brief invalide le cache de rapport.
  const rulesFingerprint = campaign.rules?.length
    ? crypto.createHash("sha256").update(JSON.stringify(campaign.rules)).digest("hex").slice(0, 12)
    : "no-rules";
  const hash = contentHash(
    version.html,
    JSON.stringify(brief ?? {}),
    brand?.version ?? 0,
    // version.name (sujet → marché utm_campaign) et QA_EXTENDED changent les
    // findings déterministes : ils invalident le cache.
    // "authv2" : sel du verdict SPF/DKIM/DMARC structuré (lib/auth-results) —
    // invalide une fois les rapports en cache pour que le nouveau check tourne.
    // "|mime:" : une version qui acquiert son rawMime après coup (re-sync) ne doit
    // pas rejouer un rapport en cache calculé sans le verdict d'authentification.
    // "|cfg:" : toute modification faite sur /rules (règle éteinte, sévérité,
    // seuil, règle écrite à la main) change le résultat attendu → invalide le
    // cache, sinon l'utilisateur sauvegarde et ne voit rien changer.
    // "|tpl:" : la RÉVISION du référentiel de brief, suivie de sa PROVENANCE.
    // Sans elle, éditer le template ne rejoue AUCUN rapport en cache — la spec
    // bouge, les verdicts rendus contre l'ancienne restent affichés comme s'ils
    // la suivaient. La révision est celle du template RÉSOLU : jusqu'ici elle
    // était calculée sur `DEFAULT_TEMPLATE`, c'est-à-dire sur un objet que
    // l'édition ne touche jamais — le sel était constant quoi qu'on enregistre.
    // La provenance entre aussi parce que `stored_invalid` et `code` rendent le
    // MÊME template pour deux raisons opposées : « rien d'enregistré » et « une
    // édition existe mais ne peut pas mesurer ». Leurs rapports ne doivent pas
    // se servir mutuellement leur cache, sans quoi réparer un template cassé
    // rejouerait le rapport rendu pendant qu'il l'était.
    // `templateRevision()` et non `.version` : `version` est un ordinal posé à
    // la MAIN. Tant que le template ne se modifiait qu'en éditant le fichier,
    // l'oubli d'incrémenter se voyait à la relecture ; le jour où l'édition
    // passe par l'UI, plus personne n'incrémente et le sel cesse de suivre le
    // référentiel — sans qu'aucune erreur ne se lève. La révision est dérivée
    // de la DÉCLARATION (géométrie, colonnes de langue, et par champ key/label/
    // kind/required/translatable/aliases/rowOffset), donc elle bouge parce que
    // la spec a bougé, jamais parce que quelqu'un a pensé à la faire bouger.
    //
    // La propriété dont ce cache dépend n'est pas « elle change quand il faut »
    // mais « elle NE change PAS quand il ne faut pas » : une révision instable
    // rendrait chaque analyse froide, donc rejouerait tout à chaque appel, en
    // silence et pour un coût LLM. Mesurée sur trois PROCESSUS neufs le 04/09 —
    // `e4e478ecd8a8` les trois fois (elle valait `f169be4e064f` avant que
    // `languages` n'entre dans la déclaration hachée, le 04/09). Trois appels
    // dans le même processus
    // n'auraient rien prouvé : la mémoïsation est une WeakMap par identité
    // d'objet, elle aurait masqué une non-détermination.
    // "|fam:" : gridFingerprint hache la GRILLE, pas la famille détectée au
    // parse. Un brief réimporté dans une autre famille produit une grille
    // différente dans la plupart des cas, mais rien ne le GARANTIT : c'est la
    // famille qui décide entre « écart » et « hors périmètre », elle doit donc
    // entrer au titre de ce qu'elle gouverne, pas de ce qu'elle corrèle.
    // `?? "?"` et non `?? "none"` : "none" est une famille RECONNUE (le parseur
    // a tourné et n'a rien reconnu), "?" est l'absence de mesure. Deux états
    // distincts qui doivent donner deux clés de cache distinctes.
    `${detected.lang ?? "?"}|${(detected.ambiguous ?? []).join(",")}|${gridFingerprint}|${salesforceCampaignName ?? ""}|${rulesFingerprint}|${version.name ?? ""}|qx${process.env.QA_EXTENDED === "1" ? 1 : 0}|authv2|mime:${version.rawMime ? 1 : 0}|cfg:${ruleConfig.hash}|tpl:${resolvedTemplate.revision}/${resolvedTemplate.source}|fam:${campaign.briefFamily ?? "?"}`
  );

  // --- Filet anti-panne démo : cache par hash de contenu ---
  // Scopé à CETTE version : deux mails identiques de marchés différents ne
  // doivent pas se servir mutuellement leurs rapports (versionId croisé).
  if (!opts.noCache) {
    const existing = (await Reports.list()).find(
      (r) =>
        r.versionId === version.id &&
        (r as AnalysisReport & { contentHash?: string }).contentHash === hash
    );
    if (existing) {
      await replayCached(existing, emit);
      return existing;
    }
  }

  const logs: string[] = [];
  const log = async (line: string) => {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    logs.push(stamped);
    await emit({ type: "log", line: stamped });
  };

  await emit({ type: "stage", stage: "preparse", detail: "Extraction des faits (DOM, liens, images, UTM, AMPscript)…" });
  await log(`parse: cheerio sur ${Math.round(version.html.length / 1024)}KB de HTML`);
  await log(
    `parse: ${facts.links.length} liens (${facts.links.filter((l) => l.kind === "ampscript").length} AMPscript, ${facts.links.filter((l) => l.kind === "tracked").length} trackés), ${facts.images.length} images, ${facts.msoBlockCount} blocs MSO, ${facts.personalizationTokens.length} tokens de perso`
  );
  await log(
    `langue: ${detected.lang ?? "non détectée"} (confiance ${detected.confidence}${detected.ambiguous ? `, groupe ambigu {${detected.ambiguous.join(", ")}}` : ""})${
      picked
        ? ` · brief "${picked.key}" sélectionné`
        : brief
          ? " · brief global (extraction unique)"
          : " · aucun brief"
    }${salesforceCampaignName ? ` · campagne SF attendue: ${salesforceCampaignName}` : ""}`
  );

  // --- Déduplication des liens avant test HTTP ---
  // Les déclinaisons répètent massivement les mêmes URLs (logo, footer, CTA) :
  // on ne teste chaque URL unique qu'une fois, puis on ré-étend le résultat à
  // tous les liens d'origine (les liens unsub gardent une clé à part et restent
  // exclus du scan HTTP, cf. check-links).
  const keyOf = facts.links.map((l) => linkDedupKey(l));
  const repIndexByKey = new Map<string, number>();
  const representatives: EmailFacts["links"] = [];
  for (let i = 0; i < facts.links.length; i++) {
    if (!repIndexByKey.has(keyOf[i])) {
      repIndexByKey.set(keyOf[i], representatives.length);
      representatives.push(facts.links[i]);
    }
  }
  const dupCount = facts.links.length - representatives.length;
  if (dupCount > 0) {
    await log(
      `liens: dédup ${facts.links.length} → ${representatives.length} URLs uniques (${dupCount} doublons réutiliseront le résultat de leur représentant)`
    );
  }

  // --- Cache batch inter-versions (opts.linkCache) ---
  // Les représentants dont l'URL normalisée a déjà été testée pour une autre
  // déclinaison réutilisent le résultat en cache ; seuls les nouveaux passent
  // par checkLinks, puis leurs résultats alimentent le cache à leur tour.
  const linkCache = opts.linkCache;
  const cachedByRepIndex = new Map<number, LinkCheckResult>();
  const toCheck: EmailFacts["links"] = [];
  const toCheckKeys: string[] = [];
  for (let i = 0; i < representatives.length; i++) {
    const key = linkDedupKey(representatives[i]);
    const cached = linkCache?.get(key);
    if (cached) {
      cachedByRepIndex.set(i, cached);
    } else {
      toCheck.push(representatives[i]);
      toCheckKeys.push(key);
    }
  }
  if (cachedByRepIndex.size > 0) {
    await log(
      `liens: cache batch — ${cachedByRepIndex.size}/${representatives.length} URLs déjà testées pour une autre déclinaison (résultats réutilisés sans requête)`
    );
  }

  await emit({ type: "stage", stage: "links", detail: `Test HTTP de ${representatives.filter((l) => l.kind === "statique" || l.kind === "tracked").length} liens uniques (SSRF-guard, 4 états)…` });
  const freshResults = await checkLinks({ ...facts, links: toCheck }, async (r) => {
    if (r.status === "non_teste") {
      await log(`liens: SKIP ${r.kind} ${r.href.slice(0, 70)}`);
    } else {
      await log(
        `liens: ${r.status.toUpperCase()}${r.httpStatus ? ` ${r.httpStatus}` : ""} ${r.href.slice(0, 70)}${r.redirects ? ` (${r.redirects} redir.)` : ""}`
      );
    }
  }, linkOptionsFromConfig(ruleConfig));
  if (linkCache) {
    for (let i = 0; i < freshResults.length; i++) {
      linkCache.set(toCheckKeys[i], freshResults[i]);
    }
  }
  // Reconstitution des résultats par représentant (cache ou frais, même ordre).
  const repResults: LinkCheckResult[] = [];
  let freshIdx = 0;
  for (let i = 0; i < representatives.length; i++) {
    const cached = cachedByRepIndex.get(i);
    repResults.push(cached ?? freshResults[freshIdx++]);
  }
  // Ré-expansion : chaque lien d'origine reprend le résultat HTTP de son
  // représentant, en conservant ses propres texte/utm (identiques par clé).
  const linkResults: LinkCheckResult[] = facts.links.map((l, i) => {
    const rep = repResults[repIndexByKey.get(keyOf[i]) ?? 0];
    return { ...rep, href: l.href, text: l.text, kind: l.kind, utm: l.utm };
  });
  await emit({
    type: "link-results",
    count: linkResults.length,
    broken: linkResults.filter((r) => r.status === "casse").length,
  });

  await emit({ type: "stage", stage: "rules", detail: "Règles déterministes (désinscription, clipping Gmail, placeholders, marque)…" });
  // Objet non-littéral : le contexte langue/grille est consommé par checks-code
  // s'il le supporte, ignoré structurellement sinon (pas d'excess property check).
  // Verdict d'authentification (SPF/DKIM/DMARC) recalculé à CHAQUE analyse
  // depuis le MIME brut : couvre aussi les mails attachés avant l'existence du
  // parseur structuré, sans resync ni migration (rawMime est déjà en base).
  const enrichedHeaderChecks = version.rawMime
    ? { ...(version.headerChecks ?? {}), authResults: evaluateAuthResults(version.rawMime, version.source) }
    : version.headerChecks ?? null;
  const codeCheckOpts = {
    facts,
    linkResults,
    brand,
    brief,
    headerChecks: enrichedHeaderChecks,
    source: version.source,
    language: detected.lang,
    detectedLanguage: detected,
    briefGrid: grid,
    // Famille du FICHIER importé, pas de la grille qu'on en tire — sans elle le
    // contrôle de conformité au template refuse de tourner (checks-code.ts:682)
    // plutôt que de mesurer en aveugle : appliqué à un brief que le template ne
    // gouverne pas, il rend des écarts fabriqués, nommés et plausibles.
    // `?? null` parce qu'une campagne importée avant ce champ n'en a pas, et que
    // « on n'a pas mesuré » ne doit pas se replier sur « autre famille ».
    briefFamily: campaign.briefFamily ?? null,
    // Le référentiel RÉSOLU (édition enregistrée si elle est valide), et non la
    // constante de code : c'est le seul point où l'édition du template atteint
    // le juge de conformité. Il entre aussi dans le sel de cache plus haut.
    template: resolvedTemplate.template,
    salesforceCampaignName,
    // Sujet réel (header MIME, posé à l'attach) : porte le marché de la
    // déclinaison ("[1293370 - … - ALL - US]") attendu en utm_campaign.
    subject: version.name ?? null,
    config: ruleConfig,
  };
  const code = runCodeChecks(codeCheckOpts);
  await log(`règles: ${code.findings.length} anomalies, ${code.passed.length} contrôles conformes (0 token utilisé)`);
  // Écarts de traduction en attente d'ARBITRAGE (cf. agent Traduction) : leur
  // émission SSE est DIFFÉRÉE jusqu'au verdict. Les afficher tout de suite puis
  // les retirer du rapport final montrerait, en direct, des défauts que le
  // rapport ne contient pas — l'écran et le rapport doivent dire la même chose.
  const pendingTranslation = new Set(code.translationCases.map((c) => c.findingId));
  for (const f of code.findings) {
    if (pendingTranslation.has(f.id)) continue;
    await emit({ type: "finding", finding: f });
  }

  // --- Workers LLM en parallèle ---
  // briefGrid + langue détectée alimentent le contexte grille des agents
  // (Liens, Tracking, Cohérence, Anomalies) via buildWorkerCtx.
  const workerCtxOpts = {
    facts,
    linkResults,
    brief,
    brand,
    // Règles éditoriales de la CAMPAGNE : prioritaires sur brand.compiledRules
    // (fallback dans buildWorkerCtx si absentes/vides — rien de cassé).
    campaignRules: campaign.rules,
    // Règles écrites à la main dans /rules : elles S'AJOUTENT aux règles de la
    // campagne/marque (jamais de remplacement — une règle globale ne doit pas
    // faire disparaître le brief de la campagne).
    // Seules celles destinées à l'agent guidelines passent par ce canal : une
    // règle routée vers un autre agent lui arrive par activeRulesBlock, et la
    // laisser ici la ferait juger DEUX fois (doublons de findings).
    // isGuidelinesRule et non le prédicat écrit ici : il était recopié à
    // l'identique dans les tests, et son énoncé porte deux pièges (l'agent
    // inconnu qu'il n'avale PAS, son complément qui n'est pas sa négation)
    // qu'un seul endroit peut documenter. Voir lib/rule-config.ts.
    extraRules: customRulesAsBrandRules(ruleConfig.customRules.filter(isGuidelinesRule)),
    codeFindings: code.findings,
    language: detected.lang,
    detectedLanguage: detected,
    briefGrid: grid,
    // Le référentiel RÉSOLU, pour son glossaire (lib/glossary.ts). Le même
    // objet que celui passé aux contrôles déterministes plus haut : deux
    // résolutions distinctes dans la même analyse laisseraient les agents
    // expliquer un brief avec les notes d'un autre template.
    template: resolvedTemplate.template,
    salesforceCampaignName,
  };
  const ctx = buildWorkerCtx(workerCtxOpts);
  let llmErrors = 0;
  const allFindings: Finding[] = [...code.findings];
  const allPassed = [...code.passed];
  const agentRuns: AnalysisReport["agents"] = [];
  // --- Conformité au template : donner une VOIX à ses trois « je ne juge pas ».
  //
  // Le verdict est déterministe et déjà rendu par runCodeChecks. Sans cette
  // ligne, ses trois refus produisent le même écran vide qu'un contrôle qui a
  // tourné et n'a rien trouvé — c'est précisément la confusion que le champ
  // `cause` a été créé pour lever, et elle survivait faute de consommateur.
  //
  // La DÉCISION (aveu ou constat, quelles règles nommer) vit dans
  // lib/template-conformance-run.ts, et pas ici : rien n'exécute ce fichier-ci
  // en test — l'importer tirerait Azure, Playwright et les clients LLM — donc
  // toute logique laissée ici n'est vérifiée que par une regex sur son propre
  // texte, qui prouve qu'elle est écrite et jamais qu'elle rend juste.
  //
  // Ce qui reste ici est ce qui ne peut PAS en sortir : écrire au journal et
  // émettre l'événement SSE.
  const templateRun = templateConformanceRun(code.templateConformance, ruleConfig);
  if (templateRun) {
    agentRuns.push(templateRun);
    await log(`template: ⤳ ${templateRun.detail}`);
    await emit({
      type: "agent",
      agent: templateRun.agent,
      status: "skipped",
      detail: templateRun.detail,
    });
  }
  const tokenTotals = { in: 0, out: 0 };
  const model = process.env.FOUNDRY_WORKER_DEPLOYMENT ?? "claude-opus-4-6";

  const runOne = async (w: (typeof WORKERS)[number], c: typeof ctx) => {
    const start = Date.now();
    await emit({ type: "agent", agent: w.label, status: "running" });
    // Requête : modèle, taille du contexte envoyé, prompt système, outil forcé.
    await log(
      `llm: → ${w.label} · ${model} · ~${Math.round(c.factsJson.length / 4 / 100) / 10}k tokens de faits · outil forcé emit_report(strict)`
    );
    await log(`llm:   ↳ system: "${w.system.slice(0, 90).replace(/\s+/g, " ")}…"`);
    const res = await runWorker(w, c, ruleConfig);
    if (res.error) {
      llmErrors++;
      // Un agent en ERREUR n'a rien vérifié non plus — un timeout ou une panne
      // Foundry laisse ses règles sans juge exactement comme un skip. C'est le
      // cas que personne n'anticipe en éditant /rules, d'où la même liste ici.
      agentRuns.push({
        agent: w.label,
        key: w.key,
        status: "error",
        detail: res.error,
        durationMs: Date.now() - start,
        unverifiedRuleIds: nonEmpty(activeRuleIdsForAgent(w.key, ruleConfig)),
      });
      await log(`llm: ✗ ${w.label} ERREUR après ${((Date.now() - start) / 1000).toFixed(1)}s — ${res.error.slice(0, 80)}`);
      await emit({ type: "agent", agent: w.label, status: "error", detail: res.error });
      return;
    }
    for (const f of res.findings) {
      allFindings.push(f);
      await emit({ type: "finding", finding: f });
    }
    allPassed.push(...res.passed);
    const unverified = res.findings.filter((f) => f.quoteVerified === false).length;
    const tIn = res.usage?.input_tokens ?? 0;
    const tOut = res.usage?.output_tokens ?? 0;
    tokenTotals.in += tIn;
    tokenTotals.out += tOut;
    agentRuns.push({
      agent: w.label,
      key: w.key,
      status: "done",
      findingsCount: res.findings.length,
      durationMs: Date.now() - start,
      tokensIn: tIn,
      tokensOut: tOut,
    });
    // Self-heal éventuel (2e appel après sortie invalide).
    if ((res.attempts ?? 1) > 1) {
      await log(`llm:   ↻ ${w.label} self-heal ×${(res.attempts ?? 1) - 1} (sortie Zod invalide corrigée)`);
    }
    // Réponse : tokens réels + contenu du tool call (catégories émises).
    await log(
      `llm: ✓ ${w.label} en ${((Date.now() - start) / 1000).toFixed(1)}s · ${tIn} tok in → ${tOut} tok out · ${res.findings.length} findings, ${res.passed.length} checks OK${unverified ? `, ${unverified} citation(s) rejetée(s) (anti-hallucination)` : ""}`
    );
    if (res.findings.length) {
      const cats = res.findings.map((f) => `${f.severite[0]}:${f.categorie}`).join(", ");
      await log(`llm:   ↳ emit_report → [${cats.slice(0, 160)}]`);
    }
    await emit({ type: "agent", agent: w.label, status: "done", findingsCount: res.findings.length });
  };

  // 5 workers spécialisés en parallèle, puis l'agent Anomalies en balayeur
  // final avec TOUT ce qui est déjà signalé (zéro doublon inter-agents).
  // Quand la grille couvre la langue du mail, l'agent LLM "Cohérence brief"
  // est SKIPPÉ : la conformité contenu↔grille est vérifiée en code pur
  // (bloc par bloc, déterministe) — la couche LLM ne faisait que générer des
  // faux écarts contre l'extraction texte. La grille est la seule vérité contenu.
  const sweeper = WORKERS.find((w) => w.key === "anomalies");
  // Périmètre STRICT MINIMUM (exigence utilisateur) : on vérifie le brief,
  // rien d'autre. Skippés :
  // - "brief" quand la grille couvre la langue (conformité contenu↔grille
  //   déjà vérifiée en code, bloc par bloc, déterministe) ;
  // - "assets" toujours (qualité générique images/alt, hors brief) — sauf
  //   QA_EXTENDED=1 pour réactiver l'audit qualité étendu.
  const extendedQA = process.env.QA_EXTENDED === "1";
  const skippedKeys = new Set<string>();
  if (gridCoversLang) skippedKeys.add("brief");
  if (!extendedQA) skippedKeys.add("assets");
  for (const key of skippedKeys) {
    const w = WORKERS.find((x) => x.key === key);
    if (!w) continue;
    const detail =
      key === "brief"
        ? "contenu vérifié en code contre la grille du brief (déterministe)"
        : "qualité générique images — hors périmètre strict brief (QA_EXTENDED=1 pour réactiver)";
    // Les règles confiées à cet agent ne sont lues par PERSONNE quand il est
    // skippé. Le cas "brief" est différent des autres : son contrôle est repris
    // en code, bloc par bloc — d'où la liste uniquement pour les autres.
    const unverifiedRuleIds =
      key === "brief" ? undefined : nonEmpty(activeRuleIdsForAgent(key, ruleConfig));
    // `w.key` et non la variable `key` : même valeur par construction (w est
    // trouvé PAR elle, deux lignes plus haut), mais celle du worker porte le
    // type, là où `key` sort d'un Set<string> et n'en a aucun.
    agentRuns.push({ agent: w.label, key: w.key, status: "skipped", detail, unverifiedRuleIds });
    await log(`llm: ⤳ ${w.label} skippé — ${detail}`);
    await emit({ type: "agent", agent: w.label, status: "skipped", detail });
  }
  // --- Agent Traduction : ESCALADE d'un contrôle déterministe ---------------
  // Il ne mesure rien : le contrôle bloc-par-bloc a déjà décidé qu'il y avait un
  // écart, l'agent tranche seulement ce qu'une comparaison de chaînes ne sait
  // pas trancher (reformulation fidèle vs vrai écart de sens). Il ne peut donc
  // QUE retirer un signalement, jamais en créer.
  const translationWorker = WORKERS.find((w) => w.runner === "translation");
  const arbitrable = code.translationCases.length > 0;
  const runTranslation = async (
    w: (typeof WORKERS)[number]
  ): Promise<TranslationArbitration | null> => {
    const start = Date.now();
    await emit({ type: "agent", agent: w.label, status: "running" });
    await log(
      `llm: → ${w.label} · ${model} · ${code.translationCases.length} bloc(s) en écart à arbitrer · outil forcé emit_translation_verdicts(strict)`
    );
    const res = await runTranslationWorker(w, ctx, code.translationCases);
    if (res.error) {
      llmErrors++;
      // Pas de `unverifiedRuleIds` ici, contrairement aux workers génériques :
      // cet agent ne porte aucune règle de /rules (protocole fixe), et son
      // contrôle déterministe a DÉJÀ tourné. Sa panne ne laisse donc aucune
      // règle sans juge — elle laisse des écarts non arbitrés, qui partent tels
      // quels ci-dessous. Lister des règles ici serait un faux constat.
      agentRuns.push({
        agent: w.label,
        key: w.key,
        status: "error",
        detail: res.error,
        durationMs: Date.now() - start,
      });
      await log(`llm: ✗ ${w.label} ERREUR après ${((Date.now() - start) / 1000).toFixed(1)}s — ${res.error.slice(0, 80)}`);
      await emit({ type: "agent", agent: w.label, status: "error", detail: res.error });
      // L'arbitre est indisponible : on rend `null`, et les signalements
      // déterministes partent tels quels. Jamais de relâchement sur une panne.
      return null;
    }
    tokenTotals.in += res.usage?.input_tokens ?? 0;
    tokenTotals.out += res.usage?.output_tokens ?? 0;
    agentRuns.push({
      agent: w.label,
      key: w.key,
      status: "done",
      // Ce que l'agent laisse au rapport : les écarts qu'il a CONFIRMÉS.
      findingsCount: code.translationCases.length - res.cleared.size,
      durationMs: Date.now() - start,
      tokensIn: res.usage?.input_tokens ?? 0,
      tokensOut: res.usage?.output_tokens ?? 0,
    });
    await log(
      `llm: ✓ ${w.label} en ${((Date.now() - start) / 1000).toFixed(1)}s · ${res.cleared.size}/${code.translationCases.length} bloc(s) jugés fidèles (signalement retiré), ${code.translationCases.length - res.cleared.size} écart(s) confirmé(s)`
    );
    await emit({
      type: "agent",
      agent: w.label,
      status: "done",
      findingsCount: code.translationCases.length - res.cleared.size,
    });
    return res;
  };
  // Aucun écart à arbitrer ⟹ AUCUN appel LLM, et l'agent se DIT skippé avec le
  // motif exact. Le motif distingue les deux silences que rien ne sépare
  // autrement : « contrôle passé, rien à arbitrer » et « contrôle jamais
  // effectué ». Un rapport ne doit jamais laisser croire que la traduction a été
  // vérifiée quand aucun contrôle n'a tourné.
  if (translationWorker && !arbitrable) {
    // Le motif NOMME la cause plutôt que de l'énumérer : sur les 133 rapports
    // stockés, les 21 sans contrôle de traduction viennent d'une grille ABSENTE,
    // pas d'une langue hors grille. Un motif qui ne cite qu'un cas sur trois se
    // lit comme un diagnostic et envoie corriger la mauvaise chose.
    const why = !grid
      ? "aucune grille de brief attachée à la campagne"
      : !detected.lang
        ? "langue de l'email non détectée"
        : !gridCoversLang
          ? `langue ${detected.lang} absente de la grille (${grid.languages.join(", ")})`
          : "règle brief-block-content éteinte dans /rules";
    const detail = code.translationChecked
      ? "contrôle de traduction bloc-par-bloc conforme — aucun écart à arbitrer"
      : `traduction NON vérifiée — ${why}`;
    agentRuns.push({
      agent: translationWorker.label,
      key: translationWorker.key,
      status: "skipped",
      detail,
    });
    await log(`llm: ⤳ ${translationWorker.label} skippé — ${detail}`);
    await emit({ type: "agent", agent: translationWorker.label, status: "skipped", detail });
  }
  const [, translationRun] = await Promise.all([
    // `!w.runner` : les workers à protocole spécialisé (Traduction) ne passent
    // pas par runWorker, qui attend un AgentReport.
    Promise.all(
      WORKERS.filter((w) => !w.runner && w.key !== "anomalies" && !skippedKeys.has(w.key)).map((w) =>
        runOne(w, ctx)
      )
    ),
    translationWorker && arbitrable
      ? runTranslation(translationWorker)
      : Promise.resolve<TranslationArbitration | null>(null),
  ]);
  if (sweeper) {
    await log(`llm: balayeur final — ${allFindings.length} findings existants injectés en "déjà signalé" (anti-doublons)`);
    await runOne(sweeper, {
      ...ctx,
      alreadyFlagged: allFindings
        .map((f) => `- [${f.severite}] ${f.message}`)
        .join("\n"),
    });
  }

  // --- Application de l'arbitrage traduction --------------------------------
  // Après le balayeur, à qui l'état déterministe complet reste présenté : lui
  // retirer des écarts avant son passage l'inviterait à les re-signaler.
  // Si l'agent n'a pas tourné (zéro écart, erreur API), `translationRun` est
  // null : les signalements déterministes sont émis TELS QUELS. L'indisponibilité
  // de l'arbitre ne relâche jamais un contrôle.
  {
    const arb: TranslationArbitration | null = translationRun;
    const blockOf = new Map(code.translationCases.map((c) => [c.findingId, c.block]));
    let cleared = 0;
    const kept: Finding[] = [];
    for (const f of allFindings) {
      if (!pendingTranslation.has(f.id)) {
        kept.push(f);
        continue;
      }
      if (arb?.cleared.has(f.id)) {
        cleared++;
        // Le bloc reste un contrôle EFFECTUÉ et conforme : il rejoint les
        // contrôles passés plutôt que de disparaître sans trace. Le ruleId le
        // rattache à la règle qui l'a produit — c'est elle qu'on éteint dans
        // /rules, et un contrôle conforme sans étiquette y survivrait seul.
        allPassed.push({
          categorie: "brief",
          label: `Translation reviewed — brief block "${blockOf.get(f.id) ?? "?"}" faithfully rendered in the email (different wording)`,
          ruleId: TRANSLATION_RULE_ID,
        });
        continue;
      }
      // Écart CONFIRMÉ (ou non arbitré) : le finding est conservé, précisé par
      // la note de l'agent quand il y en a une.
      const note = arb?.precisions.get(f.id);
      const precised = note
        ? { ...f, suggestion: `Translation review: ${note}${f.suggestion ? ` — ${f.suggestion}` : ""}` }
        : f;
      kept.push(precised);
      await emit({ type: "finding", finding: precised });
    }
    if (cleared > 0) {
      await log(`traduction: ${cleared} signalement(s) retiré(s) après arbitrage (reformulation fidèle)`);
    }
    allFindings.length = 0;
    allFindings.push(...kept);
  }

  // --- Rendu RÉEL (Playwright + juge vision) — automatique, skip gracieux ---
  // Le mail vient d'une vraie boîte (gmail/outlook) : on le rouvre dans le
  // client web, screenshot, et Opus vision le compare au mockup du brief.
  const renderProvider =
    version.source === "gmail" || version.source === "outlook" ? version.source : null;
  // Les règles confiées à l'agent vision (llm-vision-* du catalogue + règles
  // écrites à la main routées vers lui) : personne ne les lit si aucun juge ne
  // tourne. Calculées ici pour être identiques dans les quatre issues ci-dessous.
  const visionRuleIds = nonEmpty(activeRuleIdsForAgent("vision", ruleConfig));
  /** Un skip du rendu réel se DIT, dans le rapport et pas seulement à l'écran.
   *
   *  Les trois branches d'abandon n'écrivaient rien dans `agentRuns` : deux
   *  n'émettaient que vers l'UI (perdu au rechargement), la troisième ne faisait
   *  rien du tout. Un rapport sans aucune ligne pour un agent ne se distingue
   *  pas d'un rapport où l'agent a tout validé — et c'est le cas de PRODUCTION,
   *  RENDER_REAL=0 étant figé dans infra/azure/main.bicep. */
  const skipRender = async (detail: string) => {
    agentRuns.push({
      agent: "Rendu réel",
      key: "vision",
      status: "skipped",
      detail,
      unverifiedRuleIds: visionRuleIds,
    });
    await log(`rendu réel: ⤳ skippé — ${detail}`);
    await emit({ type: "agent", agent: "Rendu réel", status: "skipped", detail });
  };
  if (process.env.RENDER_REAL === "0") {
    await skipRender("rendu réel désactivé sur cet environnement (RENDER_REAL=0)");
  } else if (!renderProvider || !version.providerMessageId) {
    await skipRender("version sans message provider (upload/collé) — rendu réel impossible");
  } else if (!(await renderSessionAvailable())) {
    await skipRender("profil navigateur non initialisé — lancer `npm run render:login` une fois");
  } else {
    const label = `Rendu réel (${renderProvider === "gmail" ? "Gmail" : "Outlook"})`;
    const start = Date.now();
    await emit({ type: "agent", agent: label, status: "running" });
    try {
      // Les screenshots sont normalement déjà capturés à l'ATTACH du mail :
      // on ne re-capture que s'il en manque (le HTML d'une version ne change pas).
      let renders = await listRenders(version.id);
      if (renders.filter((r) => r.provider === renderProvider).length < DEVICES.length) {
        await log(`rendu réel: capture ${renderProvider} du message ${version.providerMessageId} (Playwright, desktop + mobiles)…`);
        renders = await captureRealRender({
          provider: renderProvider,
          providerMessageId: version.providerMessageId,
          versionId: version.id,
          html: version.html,
        });
      } else {
        await log(`rendu réel: screenshots déjà capturés à l'attach — réutilisés`);
      }
      await log(`rendu réel: ${renders.length} screenshots ${renderProvider} disponibles (${renders.map((r) => r.device).join(", ")})`);
      // Par défaut : PAS d'analyse vision LLM (choix utilisateur — zéro crédit,
      // les screenshots sont vérifiés par un HUMAIN dans l'onglet Email et
      // l'export Excel). RENDER_VISION=1 réactive le juge vision Opus.
      if (process.env.RENDER_VISION === "1") {
        const visionRenders = renders.filter((r) => VISION_DEVICES.includes(r.device));
        const vis = await runRenderVision({
          renders: visionRenders.length > 0 ? visionRenders : renders,
          mockup: campaign.briefMockups?.[0] ?? null,
          campaignName: campaign.name,
          cfg: ruleConfig,
          // Le glossaire atteint AUSSI le juge vision. Il construit son message
          // utilisateur à part (images + texte), donc rien ne le lui donnerait
          // sinon — et c'est exactement le trou déjà payé une fois avec les
          // exemples de règles : un réglage saisi à l'écran, invisible pour un
          // agent, sans qu'aucun écran ne le dise.
          glossaryBlock: ctx.glossaryBlock,
        });
        if (vis.error) throw new Error(vis.error);
        for (const f of vis.findings) {
          allFindings.push(f);
          await emit({ type: "finding", finding: f });
        }
        allPassed.push(...vis.passed);
        tokenTotals.in += vis.usage?.input_tokens ?? 0;
        tokenTotals.out += vis.usage?.output_tokens ?? 0;
        agentRuns.push({
          agent: label,
          key: "vision",
          status: "done",
          findingsCount: vis.findings.length,
          durationMs: Date.now() - start,
          tokensIn: vis.usage?.input_tokens,
          tokensOut: vis.usage?.output_tokens,
        });
        await log(`rendu réel: ✓ ${label} — ${vis.findings.length} findings, ${vis.passed.length} checks OK`);
        await emit({ type: "agent", agent: label, status: "done", findingsCount: vis.findings.length });
      } else {
        // DEUX lignes, parce qu'il y a deux sujets et qu'une seule les confondait.
        // La CAPTURE a bien eu lieu : `done` est vrai pour elle. Le JUGEMENT n'a
        // pas eu lieu : `done, 0 finding` se lisait « vision : rien à signaler »
        // alors qu'aucun modèle n'avait ouvert les images. Une absence de
        // contrôle qui ressemble à un contrôle réussi est le pire des deux.
        const detail = `${renders.length} screenshots capturés (${renders.map((r) => r.device).join(", ")}) — revue humaine dans l'onglet Email et l'Excel, 0 token`;
        agentRuns.push({ agent: label, status: "done", findingsCount: 0, durationMs: Date.now() - start, detail });
        await log(`rendu réel: ✓ ${label} — ${detail}`);
        await emit({ type: "agent", agent: label, status: "done", findingsCount: 0, detail });
        const judgeDetail =
          "juge vision non exécuté (RENDER_VISION≠1) — les screenshots sont capturés mais aucun modèle ne les a jugés";
        agentRuns.push({
          agent: "Juge vision",
          key: "vision",
          status: "skipped",
          detail: judgeDetail,
          unverifiedRuleIds: visionRuleIds,
        });
        await log(`rendu réel: ⤳ ${judgeDetail}`);
        await emit({ type: "agent", agent: "Juge vision", status: "skipped", detail: judgeDetail });
      }
    } catch (e) {
      // Jamais bloquant : session expirée, DOM client changé, vision KO →
      // l'analyse code+LLM reste complète, le rendu réel est juste absent.
      const msg = e instanceof Error ? e.message : String(e);
      agentRuns.push({
        agent: label,
        key: "vision",
        status: "skipped",
        detail: msg,
        durationMs: Date.now() - start,
        unverifiedRuleIds: visionRuleIds,
      });
      await log(`rendu réel: ⤳ ignoré — ${msg.slice(0, 140)}`);
      await emit({ type: "agent", agent: label, status: "skipped", detail: msg });
    }
  }

  // Dégradé = TOUS les workers effectivement lancés ont échoué (les skippés
  // volontaires ne comptent pas — sinon degraded était inatteignable).
  const launchedWorkers = WORKERS.length - skippedKeys.size;
  const degraded = launchedWorkers > 0 && llmErrors === launchedWorkers;

  // --- Agrégation déterministe ---
  const findings = dedupFindings(allFindings);
  const { verdict, counters } = computeVerdict(findings);
  counters.passed = allPassed.length;
  await log(
    `agrégation: dédup ${allFindings.length} → ${findings.length} findings · verdict ${verdict} calculé par règle déterministe (≥1 CRITIQUE actif = NO-GO · sinon ≥1 actif = GO AVEC RÉSERVES · sinon GO)`
  );
  await emit({ type: "verdict", verdict, counters });

  // --- Juge (streamé) ---
  let summary = "";
  if (!degraded) {
    await log(`llm: → juge (${process.env.FOUNDRY_JUDGE_DEPLOYMENT ?? "claude-opus-4-8"}) rédige le verdict exécutif en streaming…`);
    try {
      for await (const delta of streamExecutiveSummary({
        verdict,
        counters,
        findings,
        campaignName: campaign.name,
      })) {
        summary += delta;
        await emit({ type: "summary-delta", text: delta });
      }
      // streamText ne renvoie pas d'usage : estimation à partir du texte produit.
      const judgeOut = Math.round(summary.length / 4);
      tokenTotals.out += judgeOut;
      await log(`llm: ✓ juge — verdict rédigé en streaming (~${judgeOut} tok out)`);
    } catch {
      summary = summaryFallback(verdict, counters);
      await emit({ type: "summary-delta", text: summary });
    }
  } else {
    summary = `${summaryFallback(verdict, counters)} (Degraded mode: AI agents unavailable, only deterministic rules were run.)`;
    await emit({ type: "summary-delta", text: summary });
  }

  const report: AnalysisReport & { contentHash: string } = {
    id: uid(),
    campaignId: campaign.id,
    versionId: version.id,
    createdAt: new Date().toISOString(),
    verdict,
    counters,
    findings,
    passedChecks: allPassed,
    executiveSummary: summary,
    agents: agentRuns,
    linkResults,
    facts,
    degraded,
    // Enrichi du verdict auth structuré (pas la copie brute de la version) :
    // l'export et l'UI voient le même verdict que les checks.
    headerChecks: enrichedHeaderChecks ?? undefined,
    // Version de configuration utilisée : un rapport reste interprétable même
    // si les règles changent après coup.
    configVersion: ruleConfig.version,
    logs,
    contentHash: hash,
  };
  await log(
    `llm: total ${tokenTotals.in} tok in → ${tokenTotals.out} tok out sur ${agentRuns.length} agents + juge`
  );
  await log(`terminé: rapport ${report.id} persisté (cache hash ${hash.slice(0, 10)}…)`);
  await Reports.put(report);
  await emit({ type: "done", reportId: report.id, degraded });
  return report;
}

function summaryFallback(
  verdict: Verdict,
  c: { critiques: number; majeurs: number; mineurs: number }
): string {
  if (verdict === "NO_GO")
    return `NO-GO as it stands: ${c.critiques} critical issue(s) must be fixed before sending (${c.majeurs} major and ${c.mineurs} minor issues also flagged).`;
  // Les deux branches restantes se distinguent par une seule chose : reste-t-il
  // quelque chose à lire. Un GO franc n'a rien à faire relire — le dire
  // explicitement évite qu'un mail propre traîne une phrase de réserve vide.
  if (verdict === "GO_AVEC_RESERVES")
    return `GO with reservations: no critical issues, but ${c.majeurs} major and ${c.mineurs} minor point(s) to review before sending.`;
  return "GO: no issue left open. The email can be sent as is.";
}

// Rejoue un rapport en cache avec le même flux d'événements (mode démo).
async function replayCached(report: AnalysisReport, emit: (e: AnalyzeEvent) => void | Promise<void>) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const logReplay = (async () => {
    for (const line of report.logs ?? []) {
      await emit({ type: "log", line });
      await sleep(90);
    }
  })();
  await emit({ type: "stage", stage: "preparse", detail: "Extraction des faits…" });
  await sleep(400);
  await emit({ type: "stage", stage: "links", detail: "Test HTTP des liens…" });
  await sleep(500);
  await emit({ type: "link-results", count: report.linkResults.length, broken: report.linkResults.filter((r) => r.status === "casse").length });
  for (const a of report.agents) {
    await emit({ type: "agent", agent: a.agent, status: "running" });
  }
  const regles = report.findings.filter((f) => f.source === "regle");
  for (const f of regles) {
    await emit({ type: "finding", finding: f });
    await sleep(120);
  }
  for (const a of report.agents) {
    const fs = report.findings.filter((f) => f.agent.includes(a.agent) && f.source === "agent");
    for (const f of fs) {
      await emit({ type: "finding", finding: f });
      await sleep(150);
    }
    await emit({ type: "agent", agent: a.agent, status: a.status === "error" ? "error" : "done", findingsCount: fs.length });
    await sleep(200);
  }
  await emit({ type: "verdict", verdict: report.verdict, counters: report.counters });
  for (const word of report.executiveSummary.split(/(?<= )/)) {
    await emit({ type: "summary-delta", text: word });
    await sleep(18);
  }
  await logReplay;
  await emit({ type: "done", reportId: report.id, cached: true, degraded: report.degraded });
}
