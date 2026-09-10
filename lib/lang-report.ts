// Agrégation GO/NO-GO PAR LANGUE — Phase 4 (report multilingue exportable).
//
// Le brief est PAR LANGUE : chaque version attachée (mail reçu) porte une
// langue canonique (EmailVersion.language). Certaines clés de langue du brief
// sont des GROUPES ambigus (ex "EN|US-CA") : même langue anglaise, marchés
// différents — on les FUSIONNE en une seule ligne de verdict.
//
// Module pur (aucun accès store) : on lui passe la campagne + ses reports.

import type { AnalysisReport, Campaign, EmailVersion, Finding, LanguageVerdict, Verdict } from "./types";
import { canonLang, displayLang } from "./lang-codes";

/** Code MARCHÉ du mail depuis le préfixe de sujet des envois de test SFMC :
 *  "[1293370 - Le 7 Bowling Bag - ALL - US] Le 7 Bowling Bag" → "US".
 *  C'est ce code que SFMC pose en utm_campaign sur les liens.
 *  (Ici et pas dans checks-code : module PUR, importable côté client.) */
/** Nom de test SFMC parsé depuis le préfixe du sujet :
 *  "[1294653 - MX Guadalajara Midtown Store Closure - MX - F] Bienvenida…"
 *  → numéro, nom marketing, marché (MX/EU/US…), audience (ALL/F/M).
 *  L'ordre marché/audience varie selon les maisons ("ALL - EU" vs "MX - F") :
 *  les 2 derniers segments courts sont classés par nature. */
export interface ParsedTestName {
  testNumber: string | null;
  campaignName: string;
  market: string | null;
  audience: "ALL" | "F" | "M" | null;
  /** Nomenclature complète respectée : [numéro - nom - marché - audience]. */
  wellFormed: boolean;
}

export function parseTestName(subject?: string | null): ParsedTestName | null {
  if (!subject) return null;
  const m = /^\s*\[([^\]]+)\]/.exec(subject);
  if (!m) return null;
  const parts = m[1].split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const testNumber = /^\d{4,}$/.test(parts[0]) ? parts[0] : null;
  const body = testNumber ? parts.slice(1) : parts;
  let market: string | null = null;
  let audience: ParsedTestName["audience"] = null;
  // Les 2 derniers segments courts (le nom marketing peut contenir des tirets).
  for (let i = 0; i < 2 && body.length > 0; i++) {
    const last = body[body.length - 1];
    const up = last.toUpperCase();
    if (!audience && /^(ALL|F|M)$/.test(up)) {
      audience = up as "ALL" | "F" | "M";
      body.pop();
    } else if (!market && /^[A-Z]{2,3}$/.test(last) && up !== "ALL") {
      market = up;
      body.pop();
    } else break;
  }
  return {
    testNumber,
    campaignName: body.join(" - "),
    market,
    audience,
    wellFormed: Boolean(testNumber && market && audience && body.length > 0),
  };
}

export function marketFromSubject(subject?: string | null): string | null {
  return parseTestName(subject)?.market ?? null;
}

/** Critères métier affichés dans le tableau GO/NO-GO par langue.
 *  Chaque critère regroupe une ou plusieurs catégories internes de findings. */
export const CRITERIA: Array<{
  key: string;
  label: string;
  categories: Array<Finding["categorie"]>;
}> = [
  { key: "traductions", label: "Translations", categories: ["contenu", "brief", "guidelines"] },
  { key: "responsive", label: "Responsive", categories: ["rendu", "assets"] },
  { key: "liens", label: "Links", categories: ["liens"] },
  { key: "tracking", label: "Tracking (UTM)", categories: ["tracking"] },
  { key: "delivrabilite", label: "Deliverability", categories: ["delivrabilite", "technique"] },
];

/** Compte les findings ACTIFS (hors review humaine) par critère métier —
 *  même règle d'exclusion que computeVerdict. */
function countByCriterion(findings: Finding[]): { total: number; byCriterion: Record<string, number> } {
  const active = findings.filter((f) => !f.review);
  const byCriterion: Record<string, number> = {};
  for (const c of CRITERIA) {
    byCriterion[c.key] = active.filter((f) => c.categories.includes(f.categorie)).length;
  }
  return { total: active.length, byCriterion };
}

/** Verdict par MAIL (déclinaison de marché) — vérité terrain SFMC : les envois
 *  sont par marché (US, CA, ME, JP… dans le préfixe de sujet), pas par langue.
 *  Une ligne = un mail attaché, jamais de fusion. */
export interface MarketVerdict {
  versionId: string;
  /** Code marché du sujet SFMC ("[1293370 - … - ALL - US]" → "US"), null si absent. */
  market: string | null;
  /** Nom réel du mail (sujet), fallback label. */
  name: string;
  language?: string;
  verdict: Verdict | "—";
  total: number;
  byCriterion: Record<string, number>;
  reportId?: string;
}

/** Une ligne par mail attaché : marché + verdict + erreurs par critère. */
export function buildMarketReport(
  campaign: Campaign,
  reports: AnalysisReport[],
): MarketVerdict[] {
  return campaign.versions.map((v) => {
    const report = latestReportFor(v, reports);
    const counts = report
      ? countByCriterion(report.findings)
      : { total: 0, byCriterion: Object.fromEntries(CRITERIA.map((c) => [c.key, 0])) };
    return {
      versionId: v.id,
      market: marketFromSubject(v.name),
      name: v.name ?? `${v.label} · ${v.source}`,
      language: v.language,
      verdict: report ? report.verdict : "—",
      total: counts.total,
      byCriterion: counts.byCriterion,
      reportId: report?.id,
    };
  });
}

/** Canonicalise une clé de langue potentiellement groupée ("EN|US-CA" -> ["EN"]).
 *  Retourne l'ensemble dédupliqué des codes canoniques du groupe. */
function canonGroup(key: string): string[] {
  const canons = key
    .split("|")
    .map((part) => canonLang(part))
    .filter((c) => c.length > 0);
  return Array.from(new Set(canons));
}

/** Signature stable d'un groupe (pour fusionner "EN|US-CA" et "EN"). */
function groupSignature(canons: string[]): string {
  return [...canons].sort().join("|");
}

/** Report le plus récent d'une version : priorité à version.reportId (épinglé,
 *  ET appartenant bien à cette version), sinon max(createdAt) parmi les
 *  reports de cette version. Sélecteur UNIQUE — UI et exports doivent tous
 *  passer par lui pour éviter les verdicts divergents. */
export function latestReportFor(
  version: EmailVersion,
  reports: AnalysisReport[],
): AnalysisReport | undefined {
  const own = reports.filter((r) => r.versionId === version.id);
  if (own.length === 0) return undefined;
  const pinned = version.reportId ? own.find((r) => r.id === version.reportId) : undefined;
  if (pinned) return pinned;
  return own.reduce((best, r) => (r.createdAt > best.createdAt ? r : best));
}

interface LangBucket {
  /** Clé d'affichage : la clé brute du brief si dispo (ex "EN|US-CA"), sinon le canon. */
  lang: string;
  canons: string[];
  fromBrief: boolean;
}

/**
 * Construit le report GO/NO-GO par langue d'une campagne.
 *
 * - Base = langues attendues du brief (expectedLanguages, sinon briefGrid.languages,
 *   sinon clés de briefExtractions) + langues des versions attachées.
 * - Les groupes ambigus (ex "EN|US-CA") sont fusionnés avec leur langue canonique.
 * - Pour chaque langue : version attachée correspondante -> report le plus récent
 *   -> verdict + compteurs. "—" (U+2014) si aucune analyse n'a encore tourné.
 * - Trié par libellé de langue (ordre stable et lisible côté UI).
 */
export function buildLanguageReport(
  campaign: Campaign,
  reports: AnalysisReport[],
): LanguageVerdict[] {
  // 1. Langues déclarées par le brief (clés brutes, potentiellement groupées).
  const briefKeys: string[] =
    campaign.expectedLanguages && campaign.expectedLanguages.length > 0
      ? campaign.expectedLanguages
      : campaign.briefGrid && campaign.briefGrid.languages.length > 0
        ? campaign.briefGrid.languages
        : campaign.briefExtractions
          ? Object.keys(campaign.briefExtractions)
          : [];

  // 2. Buckets fusionnés par signature canonique (EN et EN|US-CA -> même bucket).
  const buckets = new Map<string, LangBucket>();
  for (const key of briefKeys) {
    const canons = canonGroup(key);
    if (canons.length === 0) continue;
    const sig = groupSignature(canons);
    const existing = buckets.get(sig);
    // Préférer la clé la plus riche (groupe) comme identifiant d'affichage.
    if (!existing || key.length > existing.lang.length) {
      buckets.set(sig, { lang: key, canons, fromBrief: true });
    }
  }

  // 3. Versions attachées, groupées par langue canonique.
  const versionsByCanon = new Map<string, EmailVersion[]>();
  for (const version of campaign.versions) {
    if (!version.language) continue;
    const canon = canonLang(version.language);
    if (canon.length === 0) continue;
    const list = versionsByCanon.get(canon);
    if (list) list.push(version);
    else versionsByCanon.set(canon, [version]);

    // Langue absente du brief : créer un bucket pour ne rien perdre.
    const sig = groupSignature([canon]);
    const inBrief = Array.from(buckets.values()).some((b) => b.canons.includes(canon));
    if (!inBrief && !buckets.has(sig)) {
      buckets.set(sig, { lang: canon, canons: [canon], fromBrief: false });
    }
  }

  // 4. Verdict par bucket : AGRÉGÉ sur TOUTES les versions du groupe (chaque
  //    mail compte via son dernier report) — représenter une langue par le seul
  //    report le plus récent masquait les NO_GO des autres marchés de la même
  //    langue (4 mails EN ≠ 1 mail EN).
  const verdicts: LanguageVerdict[] = [];
  for (const bucket of buckets.values()) {
    const versions = bucket.canons.flatMap((c) => versionsByCanon.get(c) ?? []);
    const bucketReports = versions
      .map((v) => latestReportFor(v, reports))
      .filter((r): r is AnalysisReport => Boolean(r));

    // Verdict du GROUPE = le pire de ses mails, sur les trois états :
    // un NO_GO l'emporte sur tout, sinon une réserve l'emporte sur un GO franc.
    // Un groupe n'est déclaré GO que si CHACUN de ses mails l'est — agréger vers
    // le haut masquerait la réserve du seul mail qui en porte une.
    const verdict: LanguageVerdict["verdict"] =
      bucketReports.length === 0
        ? "—"
        : bucketReports.some((r) => r.verdict === "NO_GO")
          ? "NO_GO"
          : bucketReports.some((r) => r.verdict === "GO_AVEC_RESERVES")
            ? "GO_AVEC_RESERVES"
            : "GO";
    const counters = bucketReports.reduce(
      (acc, r) => ({
        critiques: acc.critiques + r.counters.critiques,
        majeurs: acc.majeurs + r.counters.majeurs,
        mineurs: acc.mineurs + r.counters.mineurs,
      }),
      { critiques: 0, majeurs: 0, mineurs: 0 }
    );
    const criterionCounts = bucketReports.reduce(
      (acc, r) => {
        const c = countByCriterion(r.findings);
        acc.total += c.total;
        for (const k of Object.keys(c.byCriterion)) {
          acc.byCriterion[k] = (acc.byCriterion[k] ?? 0) + c.byCriterion[k];
        }
        return acc;
      },
      { total: 0, byCriterion: Object.fromEntries(CRITERIA.map((c) => [c.key, 0])) as Record<string, number> }
    );

    // Version de référence : le mail NO_GO le plus récent (à corriger en premier),
    // sinon le mail à report le plus récent, sinon la version la plus récente.
    const worstReport =
      bucketReports.filter((r) => r.verdict === "NO_GO").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
      bucketReports.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const reportVersion = worstReport
      ? versions.find((v) => v.id === worstReport.versionId)
      : undefined;
    const latestVersion =
      reportVersion ??
      (versions.length > 0
        ? versions.reduce((best, v) => (v.receivedAt > best.receivedAt ? v : best))
        : undefined);

    verdicts.push({
      lang: bucket.lang,
      label: displayLang(bucket.canons[0]),
      verdict,
      counters,
      total: criterionCounts.total,
      byCriterion: criterionCounts.byCriterion,
      versionId: latestVersion?.id,
      reportId: worstReport?.id,
    });
  }

  // 5. Tri par libellé (localeCompare), stable pour l'UI et l'export.
  verdicts.sort((a, b) => a.label.localeCompare(b.label, "fr"));
  return verdicts;
}
