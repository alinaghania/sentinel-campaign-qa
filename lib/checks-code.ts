// Checks 100% déterministes → findings source:"regle".
// C'est le socle fiable : zéro LLM, zéro hallucination, coût nul.

import { uid } from "./store";
import { DEFAULT_RULE_CONFIG, type ResolvedRuleConfig } from "./rule-config";
import { RULE_BY_ID } from "./rule-catalog";
import { TITLE_BY_CATEGORY, type FindingTitle } from "./finding-titles";
import { baseLang, sameLang } from "./lang-codes";
import {
  DEFAULT_TEMPLATE,
  validateAgainstTemplate,
  type BriefTemplate,
  type TemplateConformance,
} from "./brief-template";
import { marketFromSubject, parseTestName } from "./lang-report";
import { diceSimilarity } from "./diff";
import type { DetectedLanguage } from "./detect-language";
import type {
  Brand,
  BriefExtraction,
  BriefGrid,
  EmailFacts,
  Finding,
  HeaderChecks,
  LinkCheckResult,
  Severity,
} from "./types";

const GMAIL_CLIP_KB = 102;
const GMAIL_WARN_KB = 90;

/** Bloc du brief que le contrôle bloc-par-bloc n'a PAS retrouvé tel quel dans
 *  l'email, décrit assez précisément pour être ARBITRÉ par l'agent Traduction.
 *
 *  Pourquoi un canal séparé plutôt qu'un champ de plus sur `Finding` : ces cas
 *  ne s'affichent nulle part, ils servent uniquement à rappeler l'agent. Un
 *  champ sur le finding voyagerait jusqu'au rapport enregistré et jusqu'à
 *  l'export, pour rien.
 *
 *  Ne sortent ICI que les deux verdicts fondés sur une SIMILARITÉ (« le texte
 *  diffère », « introuvable ») : ce sont les seuls que l'instrument ne sait pas
 *  trancher, parce qu'il compare des chaînes sans les lire. Les deux autres
 *  verdicts de la section (texte présent dans une AUTRE langue, variante de la
 *  MAUVAISE audience) reposent sur une correspondance EXACTE avec un autre
 *  texte de la grille : ils sont prouvés, et un modèle à qui on demande « est-ce
 *  une traduction fidèle ? » répondrait « oui » — c'est le cas, mais du mauvais
 *  texte. Les escalader effacerait de vrais défauts. */
export interface TranslationCase {
  /** Finding déterministe correspondant (retiré si l'agent conclut "faithful"). */
  findingId: string;
  /** Libellé du bloc dans la grille du brief. */
  block: string;
  /** Clé de langue de la grille utilisée pour la comparaison. */
  lang: string;
  /** Valeur ATTENDUE : texte de la grille du brief dans cette langue. */
  expected: string;
  /** Texte de l'email le plus ressemblant. "" = rien de ressemblant trouvé. */
  found: string;
  /** Similarité 0–1 du meilleur candidat, `null` si aucun candidat. */
  similarity: number | null;
}

const PLACEHOLDER_RE = /lorem ipsum|\bTBD\b|\bTODO\b|xxx+|placeholder|à compléter|a completer/i;
const STAGING_RE = /staging\.|preprod\.|\.test\b|localhost|127\.0\.0\.1|dev\./i;

/** Échappement OBLIGATOIRE de tout terme venant de la configuration : ces
 *  listes sont saisies par une personne fonctionnelle et ne doivent JAMAIS
 *  être interprétées comme un motif (ni ReDoS, ni faux positif silencieux). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ajoute des termes LITTÉRAUX de la config à un motif du code. */
function withExtraTerms(base: RegExp, terms: string[]): RegExp {
  const extra = terms.map((t) => escapeRe(t.trim())).filter(Boolean);
  if (extra.length === 0) return base;
  return new RegExp(`${base.source}|${extra.join("|")}`, base.flags);
}
// RAPPEL SÉCURITÉ : ce module ne fait AUCUNE requête HTTP. Les liens de
// désinscription sont de toute façon exclus des comparaisons ci-dessous
// (et ne doivent JAMAIS être requêtés : un GET peut désabonner l'adresse de test).
const UNSUB_RE = /d[ée]sinscri|d[ée]sabonn|unsubscribe|opt[- ]?out/i;

/** Normalisation tolérante de texte (mêmes règles que la détection de langue) :
 *  apostrophes/guillemets typographiques, espaces insécables, casse. */
function normText(s: string): string {
  return s
    // Largeur nulle (ZWSP/ZWNJ/ZWJ/BOM/soft-hyphen/bidi — anti-spam "b\u200Dalenciaga.com") :
    // SUPPRIMÉS, pas remplacés par un espace (ils ne coupent pas les mots).
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, "")
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[\u00a0\u2000-\u200a\u202f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Jetons de personnalisation du brief ("[Nombre del Cliente]", %%firstname%%,
// {{var}}) : remplacés par le vrai nom à l'envoi — jamais comparés littéralement.
const PERSO_TOKEN = /\[[^\]]{2,40}\]|%%[^%]{1,40}%%|\{\{[^}]{1,40}\}\}/;
const PERSO_TOKEN_G = new RegExp(PERSO_TOKEN.source, "g");

/** Regex de correspondance d'un bloc de brief PERSONNALISÉ contre le texte
 *  email normalisé : jeton → joker court, et sur une ligne à jeton, " / "
 *  sépare des ALTERNATIVES (salutation personnalisée / repli sans nom —
 *  "Hola [Nombre del Cliente], / Hola,") : l'une OU l'autre suffit.
 *  null si le bloc ne contient aucun jeton (comparaison exacte habituelle). */
function personalizationPattern(raw: string): RegExp | null {
  if (!PERSO_TOKEN.test(raw)) return null;
  const literal = (s: string): string =>
    normText(s.replace(PERSO_TOKEN_G, "\uE000"))
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\uE000/g, "[^\\n]{0,60}?")
      .replace(/ /g, "\\s+");
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (PERSO_TOKEN.test(line) && / \/ /.test(line)) {
      parts.push(`(?:${line.split(/ \/ /).map(literal).filter(Boolean).join("|")})`);
    } else {
      const p = literal(line);
      if (p) parts.push(p);
    }
  }
  if (parts.length === 0) return null;
  try {
    return new RegExp(parts.join("\\s*"), "i");
  } catch {
    return null;
  }
}

/** Normalise une URL pour comparaison : host lowercase, strip utm_* / e=,
 *  slash final retiré. Renvoie null si l'URL est invalide/dynamique. */
function normalizeUrl(u: string | undefined): string | null {
  if (!u || /%%/.test(u)) return null;
  try {
    const url = new URL(u);
    const params = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      const kl = k.toLowerCase();
      if (kl.startsWith("utm_") || kl === "e") continue;
      params.append(k, v);
    }
    const qs = params.toString();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.toLowerCase()}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return null;
  }
}

/** Retrouve la clé de la grille (potentiellement composite "EN|US-CA")
 *  correspondant à un code langue canonique.
 *
 *  `market` est le code marché du nom de test SFMC ("[… - MX - F]"). Il ne sert
 *  qu'à DÉPARTAGER, et seulement à l'intérieur d'une même langue :
 *
 *  Un brief peut porter deux colonnes de la même langue — ES et MX en sont le
 *  cas réel. Aucune détection de langue ne les sépare : l'espagnol du Mexique
 *  EST de l'espagnol, et c'est vrai, pas une limite de l'outil. Sans autre
 *  information, tout mail espagnol tombe sur la PREMIÈRE colonne espagnole, et
 *  un mail mexicain se voit donc jugé contre le texte de l'Espagne — comparaison
 *  qui échoue sur des différences voulues et rapporte des traductions
 *  « absentes » qui sont juste ailleurs.
 *
 *  Le marché est la seule chose qui tranche, et il est déjà là : SFMC le pose
 *  dans le nom de test. Mais c'est un libellé SAISI, pas une mesure — d'où la
 *  garde `sameLang` : le marché n'a le droit de choisir QU'ENTRE des colonnes de
 *  la langue effectivement détectée. Un sujet qui annonce MX sur un mail japonais
 *  ne fait pas juger ce mail contre le mexicain ; on retombe sur la langue, qui
 *  elle est mesurée sur le contenu. Une étiquette ne doit jamais pouvoir
 *  contredire une mesure — seulement préciser ce que la mesure ne distingue pas.
 */
function gridKeyForLang(languages: string[], lang: string, market?: string | null): string | null {
  if (market) {
    const wanted = market.trim().toUpperCase();
    const exact = languages.find((key) =>
      key.split("|").some((c) => c.trim().toUpperCase() === wanted)
    );
    if (exact && sameLang(baseLang(exact), lang)) return exact;
  }
  for (const key of languages) {
    if (key.split("|").some((c) => sameLang(c.trim(), lang))) return key;
  }
  return null;
}


/** Fabrique de findings qui ÉTIQUETTE automatiquement chaque finding avec la
 *  règle du catalogue en cours (lib/rule-catalog).
 *
 *  Pourquoi un curseur `section()` plutôt qu'un paramètre sur chaque appel :
 *  les findings sont produits par blocs contigus (une règle = un bloc), et
 *  déclarer la règle UNE fois en tête de bloc évite 55 signatures à modifier —
 *  donc 55 occasions de se tromper d'étiquette. runCodeChecks est SYNCHRONE
 *  (aucun await) : ce curseur ne peut pas être vu par deux analyses à la fois. */
function makeFindingFactory() {
  let current: string | null = null;
  return {
    /** Déclare la règle du catalogue à laquelle appartiennent les findings et
     *  les contrôles conformes qui suivent. `null` = hors catalogue (jamais
     *  filtré, jamais reclassé). */
    section(ruleId: string | null) {
      current = ruleId;
    },
    f(
      categorie: Finding["categorie"],
      severite: Severity,
      message: string,
      evidence: string,
      locator: string,
      suggestion?: string,
      opts?: { title?: FindingTitle; expected?: string; received?: string }
    ): Finding {
      return {
        id: uid(),
        agent: "règles",
        categorie,
        severite,
        // Titre harmonisé : override explicite, sinon titre par défaut de la catégorie.
        title: opts?.title ?? TITLE_BY_CATEGORY[categorie],
        message,
        evidence: evidence.slice(0, 300),
        locator,
        suggestion,
        source: "regle",
        ruleId: current ?? undefined,
        expected: opts?.expected,
        received: opts?.received,
      };
    },
    currentRule: () => current,
  };
}

export function runCodeChecks(opts: {
  facts: EmailFacts;
  linkResults: LinkCheckResult[];
  brand?: Brand | null;
  brief?: BriefExtraction | null;
  headerChecks?: HeaderChecks | null;
  /** Grille multilingue du brief (blocs x langues + liens WW/CN). */
  briefGrid?: BriefGrid | null;
  /** Template de référence contre lequel le brief est jugé. C'est le template
   *  RÉSOLU (édité depuis l'UI, éventuellement propre à la campagne), pas la
   *  constante de code : l'appelant de production le lit via `resolveTemplate`.
   *
   *  Le défaut `DEFAULT_TEMPLATE` n'existe que pour les tests unitaires qui
   *  n'ont rien à dire du référentiel. Il a été le comportement de PRODUCTION
   *  jusqu'ici, et c'est précisément ce qui rendait l'édition sans effet : un
   *  champ ajouté depuis l'UI arrivait dans le classeur téléchargé, revenait
   *  rempli, et se faisait compter « non déclaré par le template » — un écart
   *  fabriqué, nommé, plausible, et rendu dans un rapport qui a la forme d'une
   *  mesure réussie. Un défaut silencieux ici se relit dans le rapport : les
   *  lignes de détail portent `Template ${label}`, donc le nom du référentiel
   *  qui a jugé est écrit à côté de son verdict. */
  template?: BriefTemplate | null;
  /** Famille détectée par le parseur (BriefParseTelemetry.family). Sans elle,
   *  la conformité au template ne distingue pas « écart » de « hors périmètre »
   *  et rend un verdict détaillé sur un brief qu'elle ne gouverne pas. */
  briefFamily?: "field_value" | "grid" | "none" | null;
  /** Langue détectée du mail testé (voir lib/detect-language). */
  detectedLanguage?: DetectedLanguage | null;
  /** Nom de campagne Salesforce attendu en utm_source (ex ADHOC_GLOBAL_OTO_EMAIL_...). */
  salesforceCampaignName?: string | null;
  /** Sujet RÉEL du mail (header MIME, ex "[1293370 - … - ALL - US] …") — le HTML
   *  ne le contient pas (facts.subject souvent vide). Sert au marché utm_campaign. */
  subject?: string | null;
  /** Marché du mail testé, s'il est connu explicitement (EmailVersion.market : WW, CN, JP, US…). */
  market?: string | null;
  /** Source d'ingestion du mail (EmailVersion.source) — distingue "en-tête
   *  Authentication-Results absent" anormal (gmail/outlook) du cas normal
   *  (.eml/HTML exporté avant toute réception). */
  source?: "upload" | "gmail" | "outlook" | "colle" | null;
  /** Configuration éditée depuis /rules. Absente = tous les défauts du code
   *  (comportement historique) — les tests et les appelants existants n'ont
   *  donc rien à changer. */
  config?: ResolvedRuleConfig | null;
}): {
  findings: Finding[];
  passed: Array<{ categorie: string; label: string; ruleId?: string }>;
  /** Blocs de traduction en écart, à faire arbitrer par l'agent Traduction.
   *  Vide = aucun écart ⟹ aucun appel LLM (cf. TranslationCase). */
  translationCases: TranslationCase[];
  /** Le contrôle de traduction bloc-par-bloc a-t-il RÉELLEMENT tourné ?
   *  `false` = pas de grille de brief, langue de l'email absente de la grille,
   *  ou règle éteinte dans /rules. Distinction indispensable : sans elle, une
   *  liste de cas vide se lit « traduction conforme » alors qu'elle peut vouloir
   *  dire « traduction jamais vérifiée ». */
  translationChecked: boolean;
  /** Conformité du brief au template, à TROIS états (cf. TemplateConformance).
   *  `null` = le contrôle n'a pas tourné (pas de grille, ou règles éteintes).
   *  Hors `findings` pour la même raison que `translationChecked` : « le
   *  template ne gouverne pas ce brief » n'est pas un défaut de l'email, et un
   *  Finding part dans le rapport stocké et l'export Excel. */
  templateConformance: TemplateConformance | null;
} {
  const { facts, linkResults, brand, brief, headerChecks, briefGrid, detectedLanguage, salesforceCampaignName } = opts;
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const cfg = opts.config ?? DEFAULT_RULE_CONFIG;
  const { f, section, currentRule } = makeFindingFactory();
  const findings: Finding[] = [];
  const passed: Array<{ categorie: string; label: string; ruleId?: string }> = [];
  const translationCases: TranslationCase[] = [];
  const ok = (categorie: string, label: string) =>
    passed.push({ categorie, label, ruleId: currentRule() ?? undefined });
  // PAS de nom métier ici, et c'est une décision, pas un oubli. `label` porte
  // une PHRASE écrite à la main ("Every image has alt text"), pas l'intitulé de
  // la règle : y substituer le libellé réécrit dans /rules changerait la nature
  // du texte, pas son nom. Et l'AJOUTER à côté a été refusé tant qu'il ne
  // servirait à personne — un champ que rien n'affiche et qu'aucun test ne
  // mesure a l'air d'un progrès sans qu'on puisse jamais savoir s'il est juste.
  // Condition pour rouvrir, les deux ensemble : un consommateur AFFICHE le
  // champ, ET un test épingle la valeur RENDUE. Le renommage métier atteint
  // déjà le modèle par lib/agents.ts (activeRulesBlock → cfg.label).

  // --- Taille / clipping Gmail ---
  section("html-size");
  const gmailClipBytes = cfg.int("html-size", "clipKb", GMAIL_CLIP_KB) * 1024;
  const gmailWarnBytes = cfg.int("html-size", "warnKb", GMAIL_WARN_KB) * 1024;
  if (facts.htmlSizeBytes > gmailClipBytes) {
    findings.push(
      f("technique", "CRITIQUE", `HTML is ${Math.round(facts.htmlSizeBytes / 1024)}KB > ${gmailClipBytes / 1024}KB: Gmail will clip the message ("Message clipped") and the open-tracking pixel will likely be cut off`, `${Math.round(facts.htmlSizeBytes / 1024)}KB`, "html", `Minify the HTML (remove comments/unused CSS) to under ${gmailWarnBytes / 1024}KB`)
    );
  } else if (facts.htmlSizeBytes > gmailWarnBytes) {
    findings.push(
      f("technique", "MINEUR", `HTML is ${Math.round(facts.htmlSizeBytes / 1024)}KB, close to the Gmail clipping threshold (${gmailClipBytes / 1024}KB)`, `${Math.round(facts.htmlSizeBytes / 1024)}KB`, "html", undefined, { title: "Possible issue to review" })
    );
  } else ok("technique", `HTML weight OK (${Math.round(facts.htmlSizeBytes / 1024)}KB < ${gmailClipBytes / 1024}KB Gmail limit)`);

  // --- Nomenclature du nom de test SFMC : "[numéro - campagne - marché - audience] sujet" ---
  // Élément de la spec client (Testing Elements) : le nom du test doit suivre la
  // nomenclature. Vérifié seulement si le sujet a un préfixe crocheté (les
  // envois de prod n'en ont pas).
  section("test-name-nomenclature");
  if (opts.subject && /^\s*\[/.test(opts.subject)) {
    const tn = parseTestName(opts.subject);
    if (tn?.wellFormed) {
      ok(
        "contenu",
        `Test name follows the nomenclature (#${tn.testNumber} · ${tn.campaignName} · market ${tn.market} · audience ${tn.audience})`
      );
    } else {
      findings.push(
        f(
          "contenu",
          "MINEUR",
          "Test name does not follow the expected nomenclature [test number - campaign name - market - audience]",
          opts.subject.slice(0, 200),
          "subject",
          'Expected format: "[1294653 - Campaign Name - MX - F] Subject line" (audience = ALL, F or M)',
          { title: "Problem in the subject line" }
        )
      );
    }
  }

  // --- Désinscription (règle qualité générique — hors périmètre strict brief) ---
  section("unsubscribe-link");
  if (cfg.enabled("unsubscribe-link")) {
    const unsubLinks = facts.links.filter((l) =>
      /d[ée]sinscri|d[ée]sabonn|unsubscribe|opt[- ]?out/i.test(l.text)
    );
    if (!facts.hasUnsubscribeLink) {
      const anchor = unsubLinks.find((l) => l.kind === "anchor");
      findings.push(
        f("delivrabilite", "CRITIQUE",
          anchor
            ? `Unsubscribe link present but href is empty/anchor ("${anchor.href || "#"}") — not functional`
            : "No unsubscribe link detected (CAN-SPAM/GDPR obligation + Gmail/Yahoo requirement)",
          anchor ? `"${anchor.text}" → href="${anchor.href || "#"}"` : "no candidate link",
          anchor ? `lien#${anchor.index}` : "footer",
          "Add a functional unsubscribe link in the footer",
          { title: "Problem in the unsubscribe setup" })
      );
    } else ok("delivrabilite", "Unsubscribe link present");
  }

  // --- Liens cassés / staging / ancres ---
  const stagingRe = withExtraTerms(STAGING_RE, cfg.terms("staging-links", "extraTerms"));
  for (const r of linkResults) {
    if (r.status === "casse") {
      section("broken-links");
      findings.push(f("liens", "CRITIQUE", `Broken link: "${r.text || r.href.slice(0, 60)}"`, `${r.href.slice(0, 180)} → ${r.reason}`, `lien:${r.href.slice(0, 100)}`, "Fix or remove this link before sending"));
    } else if (r.status === "suspect") {
      section("suspicious-links");
      findings.push(f("liens", "MAJEUR", `Suspicious link: "${r.text || r.href.slice(0, 60)}"`, `${r.href.slice(0, 180)} → ${r.reason}`, `lien:${r.href.slice(0, 100)}`, "Check this link manually"));
    }
    if (stagingRe.test(r.href)) {
      section("staging-links");
      findings.push(f("liens", "CRITIQUE", "Link to a staging/preprod environment", r.href.slice(0, 200), `lien:${r.href.slice(0, 100)}`, "Replace with the production URL"));
    }
  }
  section("broken-links");
  const kOk = linkResults.filter((r) => r.status === "ok").length;
  const kNv = linkResults.filter((r) => r.status === "non_verifiable").length;
  const kAmp = linkResults.filter((r) => r.kind === "ampscript").length;
  if (kOk) ok("liens", `${kOk} links respond correctly (HTTP 2xx)`);
  if (kNv) ok("liens", `${kNv} links behind anti-bot protection (400/403/429) — check manually, not broken`);
  if (kAmp) ok("liens", `${kAmp} dynamic AMPscript links excluded from HTTP tests (expected)`);

  // Ancres href="#" hors désinscription (déjà traitée)
  section("empty-anchor-cta");
  for (const l of facts.links) {
    if (l.kind === "anchor" && !/d[ée]sinscri|unsubscribe/i.test(l.text) && l.text) {
      findings.push(f("liens", "MAJEUR", `CTA with no destination: "${l.text}"`, `href="${l.href || "#"}"`, `lien#${l.index}`, "Set the target URL"));
    }
  }

  // --- AMPscript : variable dans un href sans RedirectTo ---
  section("ampscript-redirect");
  for (const l of facts.links) {
    if (l.kind === "ampscript" && /%%=?\s*v\(/i.test(l.href) && !/RedirectTo/i.test(l.href)) {
      findings.push(f("liens", "CRITIQUE", "Link built with a malformed Salesforce (AMPscript) variable: at send time, the recipient will receive a link that leads nowhere", l.href.slice(0, 200), `lien#${l.index}`, "On the SFMC side: wrap the variable in RedirectTo() so the link is resolved at send time"));
    }
  }

  // --- UTM : présence + cohérence ---
  // Liens trackés SFMC (click.news.*) : le href brut ne porte qu'un "qs" opaque,
  // les vrais UTM ne sont visibles que sur l'URL FINALE après redirections
  // (LinkCheckResult.finalUtm). UTM effectif = utm du href brut, sinon finalUtm.
  const resultByHref = new Map(linkResults.map((r) => [r.href, r]));
  const effUtm = (l: EmailFacts["links"][number]): Record<string, string> => {
    if (Object.keys(l.utm).length > 0) return l.utm;
    return resultByHref.get(l.href)?.finalUtm ?? {};
  };
  const trackables = facts.links.filter(
    (l) => (l.kind === "statique" || l.kind === "tracked") && !/^mailto|^#/.test(l.href)
  );
  const withUtm = trackables.filter((l) => Object.keys(effUtm(l)).length > 0);
  const campaigns = new Set(withUtm.map((l) => effUtm(l)["utm_campaign"]).filter(Boolean));
  section("utm-campaign-consistency");
  if (campaigns.size > 1) {
    findings.push(f("tracking", "MAJEUR", `Inconsistent utm_campaign across links: ${[...campaigns].map((c) => `"${c}"`).join(" vs ")}`, [...campaigns].join(" | "), "liens", "Align the utm_campaign value across all links"));
  } else if (campaigns.size === 1) ok("tracking", `utm_campaign consistent ("${[...campaigns][0]}")`);
  // Liens fonctionnels jamais tagués UTM par convention (désinscription, version
  // en ligne/miroir, préférences, legal/privacy) — détectés par texte, href OU
  // URL finale (les mails non-FR/EN mettent "here"/"ここ" en texte).
  const NON_TRACKED_HREF = /unsub|preference|privacy|datenschutz|legal|mentions|view\.news\.|vawp|mirror/i;
  const noUtm = trackables.filter((l) => {
    if (Object.keys(effUtm(l)).length > 0) return false;
    if (/d[ée]sinscri|unsubscribe|mentions|voir en ligne|miroir|view (this )?(email|online)|online version/i.test(l.text)) return false;
    if (NON_TRACKED_HREF.test(l.href)) return false;
    const r = resultByHref.get(l.href);
    if (r?.finalUrl && NON_TRACKED_HREF.test(r.finalUrl)) return false;
    // Lien tracké dont l'URL finale n'a pas pu être observée (non testé,
    // anti-bot, désinscription jamais requêtée) : UTM INCONNUS ≠ absents.
    if (l.kind === "tracked" && !r?.finalUrl) return false;
    return true;
  });
  section("utm-missing");
  if (noUtm.length > 0 && withUtm.length > 0) {
    // Nommer les liens concernés dans le message (exigence Alina : retrouvable
    // directement dans la cellule FEEDBACK de l'Excel, sans ouvrir l'evidence).
    const names = noUtm.slice(0, 3).map((l) => `"${(l.text || l.href).slice(0, 60)}"`).join(", ");
    const more = noUtm.length > 3 ? ` and ${noUtm.length - 3} more` : "";
    findings.push(f("tracking", "MAJEUR", `${noUtm.length} link(s) with no UTM parameters at all (href and final URL) while other links have them: ${names}${more}`, noUtm.map((l) => `${l.text || "?"} → ${l.href.slice(0, 80)}`).join(" | ").slice(0, 280), "liens", "Add utm_source/medium/campaign"));
  }
  // --- Règles QUALITÉ GÉNÉRIQUE (hors brief) : éteintes par défaut, activables
  // désormais depuis /rules (et toujours par QA_EXTENDED=1). ---
  section("malformed-url");
  if (cfg.enabled("malformed-url")) {
    for (const l of facts.links) {
      if (/\?\?|%20%20| /.test(l.href) && l.kind === "statique") {
        findings.push(f("tracking", "MINEUR", "Malformed URL (unencoded space or double '?')", l.href.slice(0, 200), `lien#${l.index}`, undefined, { title: "Possible issue to review" }));
      }
    }
  }
  const contentImgs = facts.images.filter((im) => !im.isTrackingPixel);
  section("image-alt");
  if (cfg.enabled("image-alt")) {
    const noAlt = contentImgs.filter((im) => im.alt === null || im.alt === "");
    if (noAlt.length > 0) {
      findings.push(f("assets", "MAJEUR", `${noAlt.length} of ${contentImgs.length} image(s) have no fallback text (alt attribute): many mailboxes block images by default, so the recipient will see an empty frame with no indication instead`, noAlt.map((im) => im.src.split("/").pop()).join(", ").slice(0, 280), "images", "General email quality rule (not from the brief), non-blocking: add a short text describing each image (e.g. alt=\"Black Le 7 Bowling bag\")"));
    } else if (contentImgs.length) ok("assets", `All content images have fallback text (${contentImgs.length})`);
  }
  section("image-dimensions");
  if (cfg.enabled("image-dimensions")) {
    const noDim = contentImgs.filter((im) => im.kind === "remote" && (!im.width || !im.height));
    if (noDim.length > 0) {
      findings.push(f("rendu", "MINEUR", `${noDim.length} image(s) without fixed dimensions (width/height): Outlook may render them at an aberrant size and break the layout`, noDim.map((im) => im.src.split("/").pop()).join(", ").slice(0, 280), "images", "General email quality rule: set width and height on every image", { title: "Possible issue to review" }));
    }
  }

  // --- Placeholders / tokens (vrai bloqueur d'envoi : visible destinataire) ---
  section("placeholders");
  const allText = [facts.subject, facts.preheader, ...facts.textBlocks].filter(Boolean).join(" | ");
  const placeholderRe = withExtraTerms(PLACEHOLDER_RE, cfg.terms("placeholders", "extraTerms"));
  const ph = placeholderRe.exec(allText);
  if (ph) {
    findings.push(f("contenu", "CRITIQUE", `Unreplaced placeholder detected: "${ph[0]}"`, allText.slice(Math.max(0, ph.index - 60), ph.index + 80), "contenu", "Replace with the final content"));
  } else ok("contenu", "No placeholder (lorem/TBD/TODO) detected");

  // Année périmée dans le footer (qualité générique)
  section("copyright-year");
  if (cfg.enabled("copyright-year")) {
    const year = new Date().getFullYear();
    const badYear = new RegExp(`(©|&copy;|copyright)\\s*(${year - 3}|${year - 2}|${year - 1})`, "i").exec(facts.footerText || "");
    if (badYear) {
      findings.push(f("contenu", "MAJEUR", `Outdated copyright year in the footer: ${badYear[2]} (current year is ${year})`, badYear[0], "footer", `Update to ${year}`));
    }
  }

  // Tokens de personnalisation suspects (typos probables)
  section("personalization-tokens");
  const KNOWN_TOKENS = /^%%(firstname|lastname|first_name|last_name|prenom|nom|email(addr)?|view_email_url|profile_center_url|unsub|subscriberid|jobid|member_)/i;
  // Tokens supplémentaires déclarés dans /rules : comparaison littérale (aucune
  // regex construite à partir d'une saisie utilisateur), insensible à la casse
  // et tolérante au préfixe %% absent.
  const extraKnown = cfg
    .terms("personalization-tokens", "extraKnownTokens")
    .map((t) => t.trim().toLowerCase().replace(/^%%/, "").replace(/%%$/, ""))
    .filter(Boolean);
  const isKnownToken = (t: string) => {
    if (KNOWN_TOKENS.test(t)) return true;
    const bare = t.toLowerCase().replace(/^%%/, "").replace(/%%$/, "");
    return extraKnown.some((k) => bare === k || bare.startsWith(k));
  };
  for (const t of facts.personalizationTokens) {
    if (!isKnownToken(t) && !/%%[=[]/.test(t)) {
      findings.push(f("contenu", "MAJEUR", `Unknown personalization token: ${t} — likely a typo, it will display as-is for the recipient`, t, "contenu", "Check the spelling of the SFMC attribute"));
    }
  }

  // --- Marque : domaines autorisés ---
  section("brand-allowed-domains");
  if (brand?.allowedLinkDomains?.length) {
    const allowed = brand.allowedLinkDomains.map((d) => d.toLowerCase());
    // Réseaux sociaux tolérés hors liste de marque — éditable depuis /rules.
    const social = cfg
      .terms("brand-allowed-domains", "socialExemptions")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    for (const l of trackables.filter((x) => x.kind === "statique")) {
      try {
        const host = new URL(l.href).hostname.toLowerCase();
        const okDomain = allowed.some((d) => host === d || host.endsWith(`.${d}`));
        if (!okDomain && !social.some((s) => host.includes(s))) {
          findings.push(f("liens", "MAJEUR", `Link to a domain outside the brand's allowed list: ${host}`, l.href.slice(0, 200), `lien#${l.index}`, `Allowed domains: ${allowed.join(", ")}`));
        }
      } catch {
        // URL invalide — déjà couverte ailleurs
      }
    }
    ok("liens", "Brand domain check performed");
  }

  // --- Règles de marque "code" (forbidden_terms, required_text, max_length...) ---
  section("brand-editorial-rules");
  if (brand) {
    for (const rule of brand.compiledRules.filter((r) => r.enabled && (r.engine === "code" || r.engine === "hybrid"))) {
      const sev: Severity = rule.severity === "error" ? "CRITIQUE" : rule.severity === "warning" ? "MAJEUR" : "MINEUR";
      const check = rule.params?.check;
      if (check === "forbidden_terms" && rule.params?.tokens?.length) {
        for (const tok of rule.params.tokens) {
          const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
          const m = re.exec(allText);
          if (m) {
            findings.push(f("guidelines", sev, `${rule.title}: forbidden term "${m[0]}" detected`, allText.slice(Math.max(0, m.index - 60), m.index + 80), "contenu", rule.description));
            break;
          }
        }
      }
      if (check === "required_text" && rule.params?.exactText) {
        const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
        if (!norm(allText).includes(norm(rule.params.exactText))) {
          // Le texte attendu vit dans expected (diff UI/Excel) — l'evidence ne le duplique plus.
          findings.push(f("guidelines", sev, `${rule.title}: required mention missing`, `Rule: ${rule.title}`, "contenu", rule.description, { expected: rule.params.exactText, received: "" }));
        } else ok("guidelines", `Required mention present (${rule.title})`);
      }
      if (check === "max_length" && rule.params?.max && facts.subject) {
        if (facts.subject.length > rule.params.max) {
          findings.push(f("guidelines", sev, `${rule.title}: subject line is ${facts.subject.length} characters (max ${rule.params.max})`, facts.subject, "subject", undefined, { title: "Problem in the subject line" }));
        }
      }
    }
  }

  // --- Croisement brief (déterministe) ---
  if (brief) {
    section("brief-promo-code");
    const code = brief.promo_code?.value;
    if (code && !allText.toLowerCase().includes(code.toLowerCase())) {
      findings.push(f("brief", "CRITIQUE", `Promo code from the brief ("${code}") not found in the email`, `Brief: "${brief.promo_code.quote?.slice(0, 150) ?? code}"`, "contenu", "Check the displayed promo code", { title: "Problem in the content", expected: code, received: "" }));
    } else if (code) ok("brief", `Promo code from the brief present ("${code}")`);
    section("brief-utm-campaign");
    const utmExpected = brief.utm_campaign?.value;
    if (utmExpected && campaigns.size >= 1 && ![...campaigns].some((c) => c?.toLowerCase() === utmExpected.toLowerCase())) {
      findings.push(f("brief", "MAJEUR", `Email utm_campaign (${[...campaigns].join(", ")}) ≠ brief tracking plan ("${utmExpected}")`, `Brief: "${brief.utm_campaign.quote?.slice(0, 150) ?? utmExpected}"`, "liens", undefined, { title: "Problem in the tracking", expected: utmExpected, received: [...campaigns].filter(Boolean).join(", ") }));
    }
  }

  // --- Croisement grille multilingue du brief (déterministe, zéro LLM) ---
  // Marché effectif : explicite (EmailVersion.market) sinon HEURISTIQUE
  // (langue ZH ou majorité de hostnames .cn → CN, sinon WW par défaut).
  // Une inférence est une heuristique → jamais de CRITIQUE dessus.
  const isUnsubText = (t: string) => UNSUB_RE.test(t);
  const testable = facts.links.filter(
    (l) => (l.kind === "statique" || l.kind === "tracked") && !isUnsubText(l.text)
  );
  const detectedLang = detectedLanguage?.lang ?? null;
  // Marché : explicite (EmailVersion.market) sinon celui du sujet SFMC.
  const marketExplicit =
    (opts.market?.trim() ? opts.market.trim().toUpperCase() : null) ??
    marketFromSubject(opts.subject);
  // Les liens trackés pointent tous vers click.news.* : le domaine .cn n'est
  // visible que sur l'URL FINALE après redirection.
  const cnHostCount = testable.filter((l) => {
    try {
      const u = resultByHref.get(l.href)?.finalUrl ?? l.href;
      const h = new URL(u).hostname.toLowerCase();
      return h.endsWith(".cn") || h.endsWith(".com.cn");
    } catch {
      return false;
    }
  }).length;
  const effectiveMarket: string =
    marketExplicit ??
    (detectedLang === "ZH" || (testable.length > 0 && cnHostCount > testable.length / 2)
      ? "CN"
      : "WW");
  const marketSev: Severity = marketExplicit ? "CRITIQUE" : "MAJEUR";
  const marketNote = marketExplicit ? "" : " (inferred market — to be confirmed)";

  // 1. utm_source (ou param "e=") === nom de campagne Salesforce.
  //    UTM lu sur le href brut OU sur l'URL finale (liens trackés SFMC).
  //    Si le nom SF est absent du brief → on ne peut rien vérifier, aucun finding.
  section("utm-source-salesforce");
  if (salesforceCampaignName) {
    const sfNorm = salesforceCampaignName.trim().toLowerCase();
    const observed: Array<{ text: string; value: string }> = [];
    for (const l of testable) {
      const src = effUtm(l)["utm_source"] ?? l.otherParams?.["e"];
      if (src) observed.push({ text: l.text || l.href.slice(0, 50), value: src });
    }
    const bad = observed.filter((o) => o.value.trim().toLowerCase() !== sfNorm);
    if (observed.length === 0) {
      findings.push(f("tracking", "MAJEUR", `No link carries the Salesforce campaign name in utm_source (expected "${salesforceCampaignName}") — checked on both hrefs AND final URLs after redirection`, `0 links with utm_source/e= out of ${testable.length} testable links`, "liens", "Check the SFMC tracking plan", { expected: salesforceCampaignName, received: "" }));
    } else if (bad.length > 0) {
      const distinct = [...new Set(bad.map((o) => o.value))];
      // Un seul utm_source cohérent sur tous les liens ET même produit final
      // (dernier segment) → probable renommage SFMC après rédaction du brief,
      // pas un mail piraté : suggestion orientée arbitrage plutôt que correction.
      const lastSeg = (s: string) => s.split("_").pop()?.toLowerCase() ?? s.toLowerCase();
      const probableRename =
        distinct.length === 1 && lastSeg(distinct[0]) === lastSeg(salesforceCampaignName);
      findings.push(
        f(
          "tracking",
          "MAJEUR",
          `Tracking — the campaign name in the links does not match the one in the brief (${bad.length} link${bad.length > 1 ? "s" : ""} affected)`,
          `Brief: ${salesforceCampaignName} — Links: ${distinct.slice(0, 2).join(", ")}`,
          "liens",
          probableRename
            ? "The two names are nearly identical (differences highlighted): the name was probably finalized in Salesforce AFTER the brief was written. Confirm the actual name in SFMC, then update the brief — or fix the tracking if that is what is wrong."
            : "Align the Salesforce tracking (utm_source) with the campaign name from the brief, or fix the name in the brief.",
          // Diff surligné (même style que les écarts de traduction).
          { expected: salesforceCampaignName, received: distinct[0] }
        )
      );
    } else {
      ok("tracking", `utm_source = Salesforce campaign name on ${observed.length} link(s) ("${salesforceCampaignName}")`);
    }
  }

  // 2. utm_campaign === code MARCHÉ du mail (observé sur les vrais envois SFMC :
  //    utm_campaign=US/CA/ME/JP, repris du préfixe de sujet "[1293370 - … - ALL - US]").
  //    Fallback : comparaison à la langue détectée. Check SOFT : MAJEUR max, JAMAIS CRITIQUE.
  section("utm-campaign-market");
  const subjectMarket = marketFromSubject(opts.subject ?? facts.subject);
  if (campaigns.size >= 1 && (subjectMarket || detectedLang)) {
    const values = [...campaigns].filter((c): c is string => Boolean(c));
    if (subjectMarket) {
      const mismatched = values.filter((c) => c.trim().toUpperCase() !== subjectMarket);
      if (mismatched.length === 0) {
        ok("tracking", `utm_campaign = email market (${subjectMarket}, from the subject)`);
      } else {
        // opts.subject = le sujet MIME réel (celui d'où vient le marché) — pas
        // facts.subject (souvent le <title> HTML, trompeur dans le message).
        findings.push(f("tracking", "MAJEUR", `utm_campaign (${mismatched.join(", ")}) ≠ email market ("${subjectMarket}" from the test name "${(opts.subject ?? facts.subject ?? "").slice(0, 60)}")`, mismatched.join(" | "), "liens", `utm_campaign should be "${subjectMarket}" for this variant`, { expected: subjectMarket, received: mismatched.join(", ") }));
      }
    } else if (detectedLang) {
      const langLike = /^[A-Za-z]{2,3}([-_ ]+[A-Za-z]{2,3})?$/;
      const marketLike = /^[A-Z]{2,3}$/; // US, ME, JP… (utm_campaign = code MARCHÉ chez SFMC)
      const mismatched = values.filter((c) => !sameLang(c, detectedLang));
      if (mismatched.length === 0) {
        ok("tracking", `utm_campaign matches the detected language (${detectedLang})`);
      } else if (mismatched.every((c) => marketLike.test(c.trim()))) {
        // Sujet sans préfixe SFMC (envoi prod) : le marché du mail est inconnu,
        // et un code 2-3 lettres majuscules est un code MARCHÉ probable (ME, US…)
        // — le comparer à la LANGUE produirait un faux écart (ex ME vs EN).
        ok("tracking", `utm_campaign = probable market code (${mismatched.join(", ")}) — email market not found in the subject, not compared to the language`);
      } else if (mismatched.some((c) => langLike.test(c.trim()))) {
        findings.push(f("tracking", "MAJEUR", `utm_campaign (${mismatched.join(", ")}) ≠ detected email language (${detectedLang}) — market not found in the subject, convention to be confirmed`, mismatched.join(" | "), "liens", `If the convention applies, utm_campaign should be "${detectedLang}"`));
      } else {
        findings.push(f("tracking", "MINEUR", `utm_campaign (${mismatched.join(", ")}) looks like neither a market code nor the detected language code (${detectedLang}) — informational only`, mismatched.join(" | "), "liens", undefined, { title: "Possible issue to review" }));
      }
    }
  }

  // 3. Mix marché : hostname .cn dans un mail non-CN (WW, JP, US…).
  section("cn-domain-mix");
  if (effectiveMarket !== "CN") {
    for (const l of testable) {
      try {
        const host = new URL(l.href).hostname.toLowerCase();
        const finalUrl = resultByHref.get(l.href)?.finalUrl;
        const finalHost = finalUrl ? new URL(finalUrl).hostname.toLowerCase() : null;
        const cnHost = [host, finalHost].find((h) => h && (h.endsWith(".cn") || h.endsWith(".com.cn")));
        if (cnHost) {
          findings.push(f("liens", marketSev, `Link to a Chinese domain (${cnHost}) in a ${effectiveMarket} market email${marketNote}`, `"${l.text || l.href.slice(0, 60)}" → ${(finalUrl ?? l.href).slice(0, 200)}`, `lien#${l.index}`, "Use the WW link from the brief for this market"));
        }
      } catch {
        // URL invalide — couverte ailleurs
      }
    }
  }

  // 3bis. Conformité du BRIEF au TEMPLATE (lib/brief-template.ts).
  //
  // Sujet distinct de la section 4 qui suit, et les deux doivent tourner
  // indépendamment : ici on compare le BRIEF à la SPEC ; là on compare l'EMAIL
  // au brief. Un brief McQueen est hors spec pour le template et sa grille
  // reste parfaitement exploitable pour le contrôle bloc-par-bloc — éteindre
  // le second parce que le premier ne s'applique pas ferait écrire
  // « traduction non vérifiée » pour une raison fausse.
  // Le contrôle REFUSE de mesurer sans `briefFamily`, au lieu de mesurer en
  // aveugle. Ce n'est pas de la prudence décorative : mesuré sur
  // bal-newsletter-grid.xlsx, un brief de famille `grid` dont trois libellés
  // s'apparient au template ("Subject line", "Preheader", "CTA 1") rend, sans
  // la famille, un écart circonstancié — 3 champs reconnus, 10 requis déclarés
  // manquants — sur un brief que le template ne gouverne pas. Un appelant qui
  // omet la télémétrie ne dégrade pas la mesure, il en FABRIQUE une.
  //
  // Ce refus appartient au VALIDATEUR (brief-template.ts, cause
  // `family_unknown`), pas à cet appel. Une version antérieure de cette ligne
  // court-circuitait sur `opts.briefFamily &&` : le validateur n'était alors
  // jamais appelé sans famille, et sa cause `family_unknown` était INATTEIGNABLE
  // depuis le seul chemin de production. Un état nommé qu'aucune exécution ne
  // peut produire ne vaut pas mieux que l'état muet qu'il devait remplacer.
  // Le refus est identique dans les deux montages ; ce qui change est qu'il
  // s'ÉCRIT désormais dans le rapport au lieu de se déduire d'un `null`.
  //
  // `null` au retour signifie « ce contrôle n'a pas eu lieu ». Deux versions
  // successives de ce commentaire ont été fausses, et de la même façon : elles
  // décrivaient l'aval au moment où elles étaient écrites, puis l'aval a bougé
  // sans elles. La première prêtait au champ « le même contrat que
  // `translationChecked` » ; la seconde affirmait que `templateConformance`
  // n'avait « encore aucun consommateur » — ce n'est plus vrai depuis que
  // `templateConformanceRun` le lit (analyze.ts:426) et transforme
  // `not_applicable` en une ligne d'agent portant un motif NOMMÉ.
  //
  // Ce qui reste vrai et qui est la seule raison d'être de ce paragraphe : le
  // champ `cause` existe pour que le consommateur distingue un CONSTAT (« le
  // template ne gouverne pas ce brief ») d'un AVEU (« je n'ai pas mesuré », « je
  // n'ai rien su lire »), sans avoir à relire une phrase anglaise. La liste des
  // causes se lit dans brief-template.ts, pas ici : la recopier fabriquerait la
  // troisième version périmée de ce commentaire.
  const templateConformance =
    briefGrid &&
    (cfg.enabled("template-structure") ||
      cfg.enabled("template-language-coverage") ||
      cfg.enabled("template-field-shared-cell"))
      ? validateAgainstTemplate(briefGrid, template, {
          // `?? undefined` : `null` (campagne importée avant l'existence du
          // champ) et `undefined` disent la même chose au validateur — la
          // famille n'a pas été mesurée. Le type de ValidateOptions n'admet pas
          // `null`, et le convertir ici est le seul endroit où les deux formes
          // de l'absence se rejoignent.
          family: opts.briefFamily ?? undefined,
        })
      : null;

  if (templateConformance) {
    section("template-structure");
    if (templateConformance.state === "not_applicable") {
      // Ni conforme ni en écart : le template ne dit rien de ce brief. On ne
      // pousse ni finding ni « contrôle passé » — un OK afficherait une
      // conformité qu'on n'a pas mesurée.
    } else {
      // Cellules fusionnées, AVANT la branche conforme/écart parce qu'elles
      // valent pour les deux : un brief sans le moindre écart peut porter deux
      // champs déclarés séparément dans une seule cellule. Ce n'est pas un
      // reproche — les champs sont là — c'est une réserve sur ce que la mesure
      // peut établir : une valeur unique n'atteste pas deux contenus distincts.
      // Id PROPRE, pas un second niveau de `template-structure` : l'override de
      // sévérité est par id et le défaut par appel, donc les deux niveaux ne
      // tenaient que tant que personne ne touchait au curseur de /rules (mesuré
      // par A). Un aveu et un reproche sous un même réglage se confondent au
      // premier clic.
      section("template-field-shared-cell");
      for (const s of templateConformance.sharedCells) {
        // Le cas MIROIR passe par le même id : c'est le même aveu — une valeur
        // unique n'atteste pas deux contenus distincts — et la mise en garde
        // rappelée plus haut visait le mélange d'un aveu et d'un REPROCHE, pas
        // celui de deux aveux. Le message, lui, doit dire laquelle des deux
        // réductions a eu lieu : « deux champs dans une cellule » et « deux
        // lignes lues comme une seule » se corrigent à des endroits opposés.
        const fusion = (s.sources?.length ?? 0) > 1;
        findings.push(
          f(
            "brief",
            cfg.severity("template-field-shared-cell", "MINEUR"),
            fusion
              ? `${s.sources?.length} brief rows read as the single field "${s.label}" — their values cannot be told apart`
              : `"${s.label}" carries ${s.keys.length} fields that the campaign template declares separately — they cannot be checked against one another`,
            fusion
              ? `Template ${template.label} — rows ${s.sources?.map((n) => `"${n}"`).join(", ")} collapse to one field`
              : `Template ${template.label} — fields ${s.keys.map((k) => `"${k}"`).join(", ")} share one cell`,
            "template#shared-cell",
            fusion
              ? "Declare one template field per row, or give the rows labels that differ outside the final parenthesis"
              : "Split them into one row per field if they must hold different values",
            { title: "Possible issue to review" }
          )
        );
      }
    }
    // Retour explicite à la section précédente : `section()` est un état, et
    // les findings qui suivent appartiennent bien à `template-structure`.
    section("template-structure");
    if (templateConformance.state === "conformant") {
      ok("brief", "Brief follows the campaign template");
    } else if (templateConformance.state === "deviation") {
      for (const m of templateConformance.missing) {
        findings.push(
          f(
            "brief",
            cfg.severity("template-structure", "MAJEUR"),
            `Field "${m.label}" required by the campaign template is missing from the brief`,
            `Template ${template.label} — field "${m.key}"`,
            `template#${m.key}`,
            "Add the field to the brief, or mark it optional in the campaign template"
          )
        );
      }
      for (const label of templateConformance.extra) {
        findings.push(
          f(
            "brief",
            cfg.severity("template-structure", "MAJEUR"),
            `Field "${label}" is not declared by the campaign template`,
            `Template ${template.label}`,
            `template#extra`,
            // Ne propose toujours PAS « ou comme alias d'un champ existant ».
            // Le mécanisme n'est plus inerte — FIELD_ALIASES en déclare un —
            // mais c'est une décision de RÉFÉRENTIEL, prise dans le code après
            // arbitrage, pas un geste que le métier peut faire depuis le
            // rapport. Le proposer ici enverrait vers une porte fermée.
            "Add it to the campaign template, or rename it to match a declared field"
          )
        );
      }

      section("template-language-coverage");
      for (const u of templateConformance.untranslated) {
        findings.push(
          f(
            "brief",
            cfg.severity("template-language-coverage", "MAJEUR"),
            `"${u.label}" has no content in ${u.missingLanguages.join(", ")}`,
            `Activated languages without content: ${u.missingLanguages.join(", ")}`,
            `template#${u.key}`,
            "Fill in the missing language columns, or deactivate those languages for this campaign"
          )
        );
      }

      // Les deux signalements qui suivent portent sur l'INSTRUMENT, pas sur le
      // brief : ils disent ce qui n'a pas pu être mesuré. Sans eux, une colonne
      // entière perdue en silence ressemble à une campagne qui ne la vise pas.
      section("template-language-ambiguous");
      if (templateConformance.ambiguousLanguages.length > 0) {
        findings.push(
          f(
            "brief",
            cfg.severity("template-language-ambiguous", "MINEUR"),
            `Translation coverage not measured for ${templateConformance.ambiguousLanguages.join(", ")}: these template columns share one internal language code`,
            `${templateConformance.ambiguousLanguages.join(", ")} — only one of each pair reaches the analysis`,
            "template#ambiguous-languages",
            "Check these columns by hand until the platform can tell them apart"
          )
        );
      }

      section("template-language-unsupported");
      if (templateConformance.unsupportedLanguages.length > 0) {
        findings.push(
          f(
            "brief",
            cfg.severity("template-language-unsupported", "MINEUR"),
            `Language column ${templateConformance.unsupportedLanguages.join(", ")} declared by the template is dropped when the brief is read and cannot be checked`,
            `Unknown to the platform: ${templateConformance.unsupportedLanguages.join(", ")}`,
            "template#unsupported-languages",
            "Check these columns by hand, or ask for the language to be added to the platform"
          )
        );
      }
    }
  }

  // 4. Contenu bloc-par-bloc : chaque bloc du brief dans la langue détectée
  //    doit être présent dans l'email. Trois issues :
  //    - présent tel quel → OK ;
  //    - texte PROCHE mais différent → "Traduction — le texte diffère" avec
  //      expected/received (l'UI surligne les différences) ;
  //    - rien de ressemblant → "introuvable".
  section("brief-block-content");
  // Seuil de ressemblance au-delà duquel un bloc est jugé "traduit mais
  // différent" plutôt qu'"introuvable" — réglable depuis /rules.
  const similarityMin = cfg.int("brief-block-content", "similarityPercent", 55) / 100;
  // Le marché du nom de test départage deux colonnes de la MÊME langue (ES/MX).
  // `marketFromSubject` est déjà utilisé plus bas pour l'UTM : même source, même
  // lecture — deux extractions parallèles du même sujet finiraient par diverger.
  const gridKey =
    briefGrid && detectedLang
      ? gridKeyForLang(briefGrid.languages, detectedLang, marketFromSubject(opts.subject))
      : null;
  // Le contrôle a-t-il eu de quoi tourner ? (voir translationChecked au retour)
  const blockCheckRan = Boolean(briefGrid && detectedLang && gridKey);
  if (briefGrid && detectedLang && gridKey) {
    const emailOriginals = [facts.subject, facts.preheader, ...facts.textBlocks].filter(
      (t): t is string => Boolean(t)
    );
    const emailTexts = emailOriginals.map(normText);
    const emailJoined = emailTexts.join(" \n ");
    const contains = (val: string) =>
      emailTexts.some((t) => t === val || t.includes(val)) || emailJoined.includes(val);
    // La détection de langue est elle-même heuristique : si sa confiance n'est
    // pas "high", un bloc absent reste MAJEUR (jamais de faux NO_GO sur une heuristique).
    const absentSev: Severity = detectedLanguage?.confidence === "high" ? "CRITIQUE" : "MAJEUR";
    let okBlocks = 0;
    // VARIANTES d'un même bloc (suffixe parenthésé : "Subject line (male &
    // others)" / "(female)", "CTA 2 (WOMEN)"…) = ALTERNATIVES : un mail réel
    // n'en contient qu'UNE. Le groupe passe si AU MOINS UNE variante matche ;
    // sinon UN SEUL finding pour le groupe (meilleure similarité) — jamais un
    // finding par variante (faux positifs garantis, les variantes se
    // ressemblent à ~97%).
    const groups = new Map<string, typeof briefGrid.blocks>();
    for (const block of briefGrid.blocks) {
      const base = block.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || block.name;
      const list = groups.get(base);
      if (list) list.push(block);
      else groups.set(base, [block]);
    }
    // Audience du test ("[… - MX - F]" → F) : quand le brief a des variantes
    // genrées, la variante correspondant à l'audience est EXIGÉE — trouver
    // l'AUTRE variante à sa place ("Bienvenida" dans un test M) est un vrai
    // défaut, pas un match acceptable.
    const audience = parseTestName(opts.subject)?.audience ?? null;
    const variantAudience = (name: string): "F" | "M" | null => {
      const suffix = /\(([^)]*)\)\s*$/.exec(name)?.[1] ?? "";
      if (/female|femme|women/i.test(suffix)) return "F";
      if (/male|homme|men\b/i.test(suffix)) return "M"; // "male & others" — female testé AVANT
      return null;
    };
    for (const [base, variants] of groups) {
      const hasGendered = variants.some((v) => variantAudience(v.name) !== null);
      const enforceAudience = (audience === "F" || audience === "M") && hasGendered;
      let expectedVariants = enforceAudience
        ? variants.filter((v) => {
            const a = variantAudience(v.name);
            return a === null || a === audience;
          })
        : variants;
      if (expectedVariants.length === 0) expectedVariants = variants; // brief sans la variante de cette audience
      const oppositeVariants = enforceAudience
        ? variants.filter((v) => !expectedVariants.includes(v))
        : [];
      let matched = false;
      let wrongLang: { name: string; raw: string; key: string; found: string } | null = null;
      let best: { name: string; raw: string; sim: number; idx: number } | null = null;
      let firstRaw: { name: string; raw: string } | null = null;
      for (const block of expectedVariants) {
        const raw = block.valueByLang[gridKey];
        if (!raw) continue;
        const expected = normText(raw);
        if (expected.length < 3) continue; // trop court pour un match fiable
        if (!firstRaw) firstRaw = { name: block.name, raw };
        // Jetons de personnalisation ("[Nombre del Cliente]") : remplacés par le
        // vrai nom à l'envoi → matching par motif (joker + alternative " / ").
        if (contains(expected) || (personalizationPattern(raw)?.test(emailJoined) ?? false)) {
          matched = true;
          break;
        }
        // Présent mais dans une AUTRE langue ?
        if (!wrongLang) {
          const wrongLangKey = briefGrid.languages.find((k) => {
            if (k === gridKey) return false;
            const other = block.valueByLang[k];
            if (!other) return false;
            const otherNorm = normText(other);
            return otherNorm.length >= 3 && otherNorm !== expected && contains(otherNorm);
          });
          // La valeur de l'autre langue est capturée AU MOMENT de la détection
          // (elle alimente le diff expected/received du finding).
          if (wrongLangKey) wrongLang = { name: block.name, raw, key: wrongLangKey, found: block.valueByLang[wrongLangKey] ?? "" };
        }
        // Texte PROCHE dans l'email ? (bloc traduit mais différent du brief)
        for (let ei = 0; ei < emailTexts.length; ei++) {
          const sim = diceSimilarity(expected, emailTexts[ei]);
          if (!best || sim > best.sim) best = { name: block.name, raw, sim, idx: ei };
        }
      }
      if (!firstRaw) continue; // aucune variante remplie pour cette langue
      const label = variants.length > 1 ? `${base} (any of ${variants.length} variants)` : firstRaw.name;
      if (matched) {
        okBlocks++;
        continue;
      }
      // La variante de l'AUTRE audience est-elle présente à la place ?
      // (ex : test "- M]" contenant le texte "(female)" → "Bienvenida" au lieu
      // de "Bienvenido"). Message dédié + diff surligné, AVANT le fallback
      // "texte diffère" (les variantes se ressemblent à ~97%).
      if (oppositeVariants.length > 0) {
        const found = oppositeVariants.find((block) => {
          const raw = block.valueByLang[gridKey];
          if (!raw) return false;
          const exp = normText(raw);
          return (
            exp.length >= 3 &&
            (contains(exp) || (personalizationPattern(raw)?.test(emailJoined) ?? false))
          );
        });
        if (found && firstRaw) {
          findings.push(
            f(
              "brief",
              "MAJEUR",
              `Wrong audience variant — this test targets audience "${audience}" but the email contains the "${found.name}" text instead of "${firstRaw.name}"`,
              `Test name audience: ${audience}`,
              "contenu",
              `Use the "${firstRaw.name}" text from the brief for this audience`,
              { title: "Problem in the translation", expected: firstRaw.raw, received: found.valueByLang[gridKey] }
            )
          );
          continue;
        }
      }
      if (wrongLang) {
        findings.push(f("brief", "MAJEUR", `Translation — block "${wrongLang.name}" present but in another language (${wrongLang.key}) instead of ${detectedLang}`, `Expected (${detectedLang}): "${wrongLang.raw.slice(0, 120)}" — found: ${wrongLang.key} version`, "contenu", `Replace with the ${detectedLang} text from the brief`, { expected: wrongLang.raw, received: wrongLang.found }));
        continue;
      }
      // Les deux verdicts qui suivent reposent sur une SIMILARITÉ de chaînes :
      // l'instrument ne sait pas distinguer une reformulation fidèle d'un vrai
      // écart de sens. Chacun est donc enregistré comme cas d'ARBITRAGE pour
      // l'agent Traduction (cf. TranslationCase) — le finding reste émis tel
      // quel, et n'est retiré que si l'agent tourne et conclut "faithful".
      if (best && best.sim >= similarityMin) {
        const received = emailOriginals[best.idx];
        const finding = f(
          "brief",
          "MAJEUR",
          `Translation — block "${best.name}" text (${detectedLang}) differs from the brief (${Math.round(best.sim * 100)}% similarity)`,
          // Les textes comparés vivent dans expected/received — l'evidence ne les duplique plus.
          `Block "${best.name}" — ${Math.round(best.sim * 100)}% similarity`,
          "contenu",
          "Compare the highlighted passages: if the email wording is intentional, mark this item as resolved; otherwise use the text from the brief",
          { expected: best.raw, received }
        );
        findings.push(finding);
        translationCases.push({
          findingId: finding.id,
          block: best.name,
          lang: gridKey,
          expected: best.raw,
          found: received,
          similarity: best.sim,
        });
      } else {
        const finding = f("brief", absentSev, `Translation — brief block "${label}" (${detectedLang}) not found in the email (no similar text)`, `Block "${label}"`, "contenu", "Check that the brief content was integrated for this language", { expected: firstRaw.raw, received: "" });
        findings.push(finding);
        // `found` reste le MEILLEUR candidat même sous le seuil : c'est
        // précisément le cas où une traduction fidèle mais reformulée est
        // déclarée "introuvable". Sans ce candidat, l'agent n'aurait rien à
        // comparer (il reçoit aussi les faits de l'email, mais lui montrer le
        // texte le plus proche est ce qui rend l'arbitrage possible).
        translationCases.push({
          findingId: finding.id,
          block: label,
          lang: gridKey,
          expected: firstRaw.raw,
          found: best ? emailOriginals[best.idx] : "",
          similarity: best ? best.sim : null,
        });
      }
    }
    if (okBlocks > 0) ok("brief", `${okBlocks} brief block(s) (${gridKey}) found in the email`);
  } else if (briefGrid && detectedLang && !gridKey) {
    findings.push(f("brief", "MAJEUR", `Detected email language (${detectedLang}) missing from the brief grid (${briefGrid.languages.join(", ")})`, `Brief languages: ${briefGrid.languages.join(", ")}`, "contenu", "Check the language of the tested email or complete the brief"));
  }

  // 5. Liens attendus PAR MARCHÉ (linksByMarket : WW, CN, JP, US… + raccourcis
  //    ww/cn) par bloc : appariement par libellé CTA. L'appariement est une
  //    HEURISTIQUE → MAJEUR max, jamais CRITIQUE (y compris pour un lien d'un
  //    autre marché ; le mix marché .cn déterministe reste couvert par le check 3).
  section("expected-links-market");
  if (briefGrid && gridKey) {
    let okExpected = 0;
    for (const el of briefGrid.expectedLinks) {
      // Appariement TOLÉRANT bloc↔lien attendu : les libellés diffèrent souvent
      // ("CTA 1" vs "CTA 1 \"SHOP LE 7\"") — égalité stricte = contrôle mort.
      const elBlockNorm = normText(el.block ?? "");
      const label =
        el.ctaLabelByLang?.[gridKey] ??
        briefGrid.blocks.find((b) => {
          const bn = normText(b.name);
          return bn === elBlockNorm || bn.includes(elBlockNorm) || elBlockNorm.includes(bn);
        })?.valueByLang[gridKey];
      if (!label) continue;
      const labelNorm = normText(label);
      if (labelNorm.length < 2) continue;
      // Liens attendus par marché (clés normalisées en MAJUSCULES).
      const byMarket: Record<string, string> = {};
      for (const [mk, u] of Object.entries(el.linksByMarket ?? {})) {
        if (u) byMarket[mk.trim().toUpperCase()] = u;
      }
      if (el.ww && !byMarket["WW"]) byMarket["WW"] = el.ww;
      if (el.cn && !byMarket["CN"]) byMarket["CN"] = el.cn;
      // Lien attendu pour le marché du mail, avec repli WW puis premier dispo
      // (comportement historique ww ?? cn conservé).
      const expectedUrl =
        byMarket[effectiveMarket] ?? byMarket["WW"] ?? Object.values(byMarket)[0];
      const expectedNorm = normalizeUrl(expectedUrl);
      if (!expectedNorm) continue;
      // URLs des AUTRES marchés du brief (pour qualifier un mix marché).
      const otherMarkets: Array<{ market: string; norm: string }> = [];
      for (const [mk, u] of Object.entries(byMarket)) {
        if (mk === effectiveMarket) continue;
        const n = normalizeUrl(u);
        if (n && n !== expectedNorm) otherMarkets.push({ market: mk, norm: n });
      }
      const candidates = testable.filter((l) => normText(l.text) === labelNorm);
      if (candidates.length === 0) continue; // pas de CTA appariable — couvert par le check de contenu
      for (const l of candidates) {
        const finalUrl = resultByHref.get(l.href)?.finalUrl;
        const actualNorms = [normalizeUrl(l.href), normalizeUrl(finalUrl)].filter(
          (n): n is string => Boolean(n)
        );
        if (actualNorms.length === 0) continue;
        if (actualNorms.includes(expectedNorm)) {
          okExpected++;
          continue;
        }
        const wrong = otherMarkets.find((o) => actualNorms.includes(o.norm));
        if (wrong) {
          findings.push(
            f(
              "liens",
              "MAJEUR",
              `Link — CTA "${label}" points to the ${wrong.market} market link while this email targets the ${effectiveMarket} market${marketNote}`,
              `Expected (${effectiveMarket}) vs found (${wrong.market})`,
              `lien#${l.index}`,
              `Replace with the ${effectiveMarket} link specified in the brief for this block`,
              { expected: expectedUrl, received: finalUrl ?? l.href }
            )
          );
        } else {
          findings.push(
            f(
              "liens",
              "MAJEUR",
              `Link — CTA "${label}" does not point to the URL planned in the brief for the ${effectiveMarket} market (differences highlighted — may come from a geolocated redirect, to be confirmed)`,
              `Expected (${effectiveMarket}) vs observed final URL`,
              `lien#${l.index}`,
              "Compare the two URLs: if only the locale differs (e.g. /de-de), it is the test's geolocation, not an error; otherwise use the link from the brief",
              { expected: expectedUrl, received: finalUrl ?? l.href }
            )
          );
        }
      }
    }
    if (okExpected > 0) ok("liens", `${okExpected} CTA(s) point to the expected ${effectiveMarket} link from the brief`);
  }

  // --- Headers du vrai mail (si .eml / Gmail / Outlook) ---
  if (headerChecks) {
    const auth = headerChecks.authResults;
    if (auth) {
      // Verdict structuré (lib/auth-results) — pivot = DMARC : c'est la seule
      // clause qui intègre l'alignement SPF/DKIM calculé par le récepteur.
      // Un SPF non aligné est NORMAL chez SFMC (bounce domain exacttarget).
      const evidence = auth.raw?.slice(0, 280) ?? "";
      const cap = (s: Severity): Severity => (!auth.trusted && s === "CRITIQUE" ? "MAJEUR" : s);
      const src = auth.trusted ? "" : " Note: this email was imported as a file, so the authentication header could not be certified as genuine.";
      // Raccourcis titres (les 2 titres auth sont réservés à ce bloc code).
      const T_PROBLEM = "Problem in the email authentication" as const;
      const T_UNVERIFIED = "Email authentication could not be verified" as const;
      const dmarcPass = auth.dmarc?.result === "pass";
      section("auth-missing");
      if (!auth.present) {
        if (opts.source === "gmail" || opts.source === "outlook") {
          findings.push(f("delivrabilite", "MINEUR", "The mailbox provider recorded no authentication verdict for this email, so we cannot confirm it would pass spam filters in a real send (internal routing or direct insertion into the mailbox).", "Authentication-Results header missing", "header:auth", "Send a fresh test from SFMC through a normal send, then re-run the check.", { title: T_UNVERIFIED }));
        }
        // upload/colle : un fichier exporté avant réception n'a pas d'AR — rien à signaler.
      } else if (!auth.spf && !auth.dmarc && auth.dkim.length === 0) {
        findings.push(f("delivrabilite", "MINEUR", `The mailbox provider explicitly reported that it performed no authentication checks on this email.${src}`, evidence, "header:auth", "Send a new test through a normal delivery route.", { title: T_UNVERIFIED }));
      } else {
        // DMARC
        section("auth-dmarc");
        const d = auth.dmarc;
        if (!d) {
          findings.push(f("delivrabilite", "MINEUR", `The mailbox provider did not report a verdict for the main sender-identity check (DMARC).${src}`, evidence, "header:dmarc", "Send a new test to a Gmail mailbox, which always reports a DMARC verdict.", { title: T_UNVERIFIED }));
        } else if (d.result === "pass") {
          ok("delivrabilite", `DMARC: pass (header.from=${d.fromDomain ?? "?"}${d.policy ? `, p=${d.policy}` : ""})`);
        } else if (d.result === "fail") {
          findings.push(f("delivrabilite", cap("CRITIQUE"), `This email fails the key check mailbox providers use to verify it genuinely comes from the brand's domain — in a real send, Gmail and Outlook would reject it or deliver it to spam.${src}`, evidence, "header:dmarc", "In SFMC, check that the From domain is provisioned as a Private Domain (Sender Authentication Package) and that the test uses the production sender profile.", { title: T_PROBLEM }));
        } else if (d.result === "none") {
          findings.push(f("delivrabilite", "MAJEUR", `The brand's sending domain publishes no DMARC policy telling mailbox providers how to verify its identity — since 2024 Gmail and Yahoo require one for bulk senders, so the campaign risks being filtered to spam.${src}`, evidence, "header:dmarc", "Ask the team managing the domain's DNS to publish a DMARC record (at minimum p=none).", { title: T_PROBLEM }));
        } else if (d.result === "bestguesspass") {
          findings.push(f("delivrabilite", "MAJEUR", `Outlook could only make a 'best guess' that this email is legitimate because the sending domain publishes no sender-identity policy — this is not a real pass and does not meet Gmail/Yahoo bulk sender requirements.${src}`, evidence, "header:dmarc", "Publish a DMARC record on the sending domain.", { title: T_PROBLEM }));
        } else if (d.result === "temperror") {
          findings.push(f("delivrabilite", "MINEUR", "The mailbox provider hit a temporary technical error while verifying the sender's identity — a one-off glitch on the receiver's side, not a campaign setup problem.", evidence, "header:dmarc", "Send a new test and re-run the check.", { title: T_UNVERIFIED }));
        } else if (d.result === "permerror") {
          findings.push(f("delivrabilite", "MAJEUR", `The sender-identity (DMARC) record published for the brand's domain is malformed, so mailbox providers cannot apply it.${src}`, evidence, "header:dmarc", "Ask the team managing the domain's DNS to fix the DMARC record syntax.", { title: T_PROBLEM }));
        } else {
          findings.push(f("delivrabilite", "MINEUR", `The mailbox provider returned an unusual verdict for the sender-identity check — the raw verdict is attached for the deliverability team to review.${src}`, evidence, "header:dmarc", undefined, { title: T_UNVERIFIED }));
        }
        // DKIM : ≥1 signature valide suffit (RFC 6376) — détail par signature (d=).
        section("auth-dkim");
        const passSigs = auth.dkim.filter((s) => s.result === "pass");
        if (passSigs.length > 0) {
          ok("delivrabilite", `DKIM: pass (${passSigs.map((s) => `d=${s.domain ?? "?"}`).join(", ")})`);
          if (!dmarcPass && passSigs.every((s) => s.domain && /(exacttarget\.com|salesforce\.com)$/i.test(s.domain))) {
            findings.push(f("delivrabilite", "MAJEUR", "The email is digitally signed only by Salesforce's domain, not by the brand's domain, so mailbox providers cannot link it to the brand — this typically means the From domain is not fully set up as a Private Domain in SFMC.", passSigs.map((s) => `d=${s.domain}`).join(", "), "header:dkim", "Provision the From domain as a Private Domain (Sender Authentication Package) in the sending Business Unit.", { title: T_PROBLEM }));
          }
        } else if (auth.dkim.length > 0) {
          findings.push(f("delivrabilite", cap(dmarcPass ? "MINEUR" : "CRITIQUE"), `None of the digital signatures on this email could be validated, so mailbox providers cannot confirm it comes from the brand or was left unaltered in transit.${src}`, evidence, "header:dkim", "Check the DKIM setup in SFMC (Private Domain); an invalid signature can also come from a gateway modifying the email in transit.", { title: T_PROBLEM }));
        } else {
          findings.push(f("delivrabilite", dmarcPass ? "MINEUR" : "MAJEUR", `The mailbox provider did not report any result for the email's digital signature.${src}`, evidence, "header:dkim", undefined, { title: T_UNVERIFIED }));
        }
        // SPF : informatif quand DMARC passe (bounce domain SFMC rarement aligné,
        // un transfert casse SPF mécaniquement) ; bloquant seulement sans filet DMARC.
        section("auth-spf");
        const s = auth.spf;
        if (s?.result === "pass") {
          ok("delivrabilite", `SPF: pass (smtp.mailfrom=${s.mailfrom ?? "?"})`);
        } else if (!s) {
          findings.push(f("delivrabilite", "MINEUR", `The mailbox provider did not report a result for the sending-server check.${src}`, evidence, "header:spf", undefined, { title: T_UNVERIFIED }));
        } else if (s.result === "temperror") {
          findings.push(f("delivrabilite", "MINEUR", "The mailbox provider hit a temporary technical error while checking the sending server — not a campaign setup issue.", evidence, "header:spf", "Send a new test and re-run the check.", { title: T_UNVERIFIED }));
        } else if (dmarcPass) {
          findings.push(f("delivrabilite", "MINEUR", "The sending-server check (SPF) did not pass, but this is not blocking: the email's main authentication (DMARC) still passes thanks to its valid digital signature — a normal pattern for SFMC sends and forwarded mailboxes.", evidence, "header:spf", undefined, { title: "Possible issue to review" }));
        } else if (s.result === "fail" || s.result === "softfail") {
          findings.push(f("delivrabilite", cap("CRITIQUE"), `The server that sent this email is not authorised to send on behalf of the return domain, and no other check compensates — mailbox providers would likely reject it or route it to spam.${src}`, evidence, "header:spf", "Check the SFMC bounce domain SPF setup and make sure the test did not reach this mailbox through a forward.", { title: T_PROBLEM }));
        } else {
          // none/neutral/permerror… : absence de verdict SPF, pas un échec avéré —
          // cohérent avec dmarc=none (MAJEUR), ne doit pas déclencher un NO-GO seul.
          findings.push(f("delivrabilite", "MAJEUR", `Mailbox providers could not determine whether the sending server is authorised for the brand, and no other check compensates.${src}`, evidence, "header:spf", "Publish or fix the SPF record of the sending (bounce) domain.", { title: T_PROBLEM }));
        }
      }
    } else {
      // Fallback legacy (mail stocké sans rawMime) : chaînes extraites à la synchro.
      for (const [k, label] of [["spf", "SPF"], ["dkim", "DKIM"], ["dmarc", "DMARC"]] as const) {
        section(`auth-${k}`);
        const v = headerChecks[k];
        if (v && /fail|softfail|permerror|temperror/i.test(v)) {
          findings.push(f("delivrabilite", "CRITIQUE", `${label} authentication failure: ${v}`, headerChecks.authResultsRaw?.slice(0, 280) ?? v, `header:${label.toLowerCase()}`, undefined, { title: "Problem in the email authentication" }));
        } else if (v && /pass/i.test(v)) ok("delivrabilite", `${label}: pass`);
      }
    }
    // La présence du header List-Unsubscribe n'appartient à aucune règle
    // réglable (constat brut) — seule l'exigence one-click en dessous l'est.
    section(null);
    if (headerChecks.listUnsubscribe) {
      ok("delivrabilite", "List-Unsubscribe header present");
      if (!headerChecks.listUnsubscribePost) {
        section("one-click-unsubscribe");
        if (cfg.enabled("one-click-unsubscribe")) {
          findings.push(f("delivrabilite", "MAJEUR", "One-click unsubscribe (List-Unsubscribe-Post technical header) is missing: Gmail and Yahoo require it for bulk senders, and its absence degrades sending reputation (spam risk)", headerChecks.listUnsubscribe.slice(0, 200), "header:list-unsubscribe", "General email quality rule: enable one-click unsubscribe on the SFMC side", { title: "Problem in the unsubscribe setup" }));
        }
        section(null);
      } else ok("delivrabilite", "One-click unsubscribe (RFC 8058) present");
    }
  }

  // --- Passe de configuration ---
  // Tout est produit d'abord, la config s'applique ENSUITE : une règle éteinte
  // disparaît (findings ET contrôles conformes), une sévérité redéfinie est
  // appliquée. Filtrer ici plutôt que d'entourer 30 blocs d'un `if` garantit
  // qu'aucune règle ne peut échapper au réglage par simple oubli de garde.
  // Un ruleId absent du catalogue (règle renommée dans le code, étiquette
  // erronée) est CONSERVÉ tel quel : une coquille ne doit jamais faire
  // disparaître un contrôle en silence.
  const keep = (ruleId?: string) => !ruleId || !RULE_BY_ID[ruleId] || cfg.enabled(ruleId);
  const keptFindings = findings
    .filter((x) => keep(x.ruleId))
    .map((x) => (x.ruleId ? { ...x, severite: cfg.severity(x.ruleId, x.severite) } : x));
  // Les cas d'arbitrage suivent le sort de leur finding : règle de traduction
  // éteinte dans /rules ⟹ plus de finding, donc plus rien à arbitrer et AUCUN
  // appel LLM. Un cas orphelin ferait tourner l'agent Traduction pour retirer
  // un signalement qui n'existe déjà plus.
  const keptIds = new Set(keptFindings.map((x) => x.id));
  return {
    findings: keptFindings,
    passed: passed.filter((p) => keep(p.ruleId)),
    translationCases: translationCases.filter((c) => keptIds.has(c.findingId)),
    // Règle éteinte dans /rules = contrôle NON effectué : ses findings viennent
    // d'être filtrés, et annoncer l'inverse ferait passer une absence de
    // contrôle pour un contrôle réussi.
    translationChecked: blockCheckRan && cfg.enabled("brief-block-content"),
    templateConformance,
  };
}
