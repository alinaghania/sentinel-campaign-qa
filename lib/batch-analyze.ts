// Lancement d'une analyse EN LOT (job détaché) — partagé entre :
// - POST /api/campaigns/[id]/analyze-batch (bouton "Analyze all") ;
// - les routes d'ATTACH inbox (analyse AUTOMATIQUE dès que les mails sont
//   rattachés à la campagne — zéro clic).
// Contrat job : createJob → événements taggés versionId/lang → finishJob ;
// la déconnexion du client n'interrompt rien, l'UI streame via
// GET /api/campaigns/[id]/analyze?jobId=X (replay + tail).

import { Brands, Campaigns, Reports, Settings, updateCampaign } from "./store";
import { resolveRuleConfig } from "./rule-config";
import { analyze, type AnalyzeEvent } from "./analyze";
import { appendEvent, createJob, finishJob } from "./jobs";
import { parseEmailFacts } from "./parse-email";
import { detectEmailLanguage } from "./detect-language";
import { canonLang } from "./lang-codes";
import { latestReportFor } from "./lang-report";
import type { Campaign, EmailVersion, LinkCheckResult } from "./types";

/** Event du job tagué avec la version et la langue dont il provient. */
type TaggedEvent = AnalyzeEvent & { versionId: string; lang?: string };

/** Langue canonique d'une version : déclarée à l'attache, sinon détectée
 *  dans le contenu (même logique que analyze). Null si indéterminable.
 *  Une détection NON sûre (confidence ≠ high ou ambiguë) n'est PAS retournée :
 *  elle serait persistée sur la version puis traitée comme certaine par
 *  l'analyse (sévérité CRITIQUE sur les blocs) — faux NO-GO possibles. */
function versionLang(version: EmailVersion, campaign: Campaign): string | null {
  if (version.language) return canonLang(version.language) || version.language;
  const detected = detectEmailLanguage(
    parseEmailFacts(version.html),
    campaign.briefGrid ?? null
  );
  if (detected.confidence !== "high" || (detected.ambiguous?.length ?? 0) > 1) return null;
  return detected.lang ?? null;
}

/** Crée le job et lance l'analyse détachée des versions demandées (toutes si
 *  versionIds absent). Retourne le jobId immédiatement, ou une erreur. */
export async function startBatchAnalysis(
  campaignId: string,
  versionIds?: string[]
): Promise<{ jobId: string } | { error: string }> {
  const campaign = await Campaigns.get(campaignId);
  if (!campaign) return { error: "campagne introuvable" };

  // Versions ciblées : celles demandées (dans l'ordre, ids inconnus ignorés),
  // sinon TOUTES les versions de la campagne.
  const requestedIds =
    Array.isArray(versionIds) && versionIds.length > 0
      ? versionIds
      : campaign.versions.map((v) => v.id);
  const seen = new Set<string>();
  const versions: EmailVersion[] = [];
  for (const vid of requestedIds) {
    if (seen.has(vid)) continue;
    seen.add(vid);
    const v = campaign.versions.find((x) => x.id === vid);
    if (v) versions.push(v);
  }
  if (versions.length === 0) return { error: "aucune version d'email à analyser" };

  const brand = campaign.brandId ? await Brands.get(campaign.brandId) : null;
  // Config lue UNE fois pour tout le lot : les déclinaisons d'une même campagne
  // sont jugées avec la même configuration, même si quelqu'un sauvegarde /rules
  // pendant l'exécution (sinon deux mails du même lot deviennent incomparables).
  const ruleConfig = resolveRuleConfig(await Settings.get());
  const job = await createJob({
    campaignId: campaign.id,
    versionIds: versions.map((v) => v.id),
  });

  // ── Tâche de fond DÉTACHÉE (contrat job) : le jobId part tout de suite,
  // l'analyse continue et écrit ses events dans le job persisté. ──
  void (async () => {
    // Cache HTTP partagé entre versions : une URL (clé normalisée) n'est
    // testée qu'une fois pour tout le batch.
    const linkCache = new Map<string, LinkCheckResult>();
    let succeeded = 0;

    // ⚠️ CONCURRENCE : plusieurs jobs (attach successifs) + routes peuvent
    // écrire la même campagne. On ne PUT JAMAIS notre snapshot : toutes les
    // écritures passent par updateCampaign (sérialisé par id, merge ciblé).
    try {
      // Pré-passe : langue de chaque version (calculée sur le snapshot — le
      // HTML d'une version est immuable), posée par merge ciblé.
      const langs = new Map<string, string | null>();
      for (const version of versions) {
        const lang = versionLang(version, campaign);
        if (lang && !version.language) version.language = lang; // snapshot local (utilisé par analyze)
        langs.set(version.id, lang);
      }
      await updateCampaign(campaign.id, (c) => {
        if (!c.humanDecision) c.status = "EN_ANALYSE";
        for (const [vid, lang] of langs) {
          const v = c.versions.find((x) => x.id === vid);
          if (v && lang && !v.language) v.language = lang;
        }
      });

      const runOne = async (version: EmailVersion, i: number) => {
        const lang = langs.get(version.id) ?? null;
        const emit = async (e: AnalyzeEvent) => {
          const tagged: TaggedEvent = {
            ...e,
            versionId: version.id,
            ...(lang ? { lang } : {}),
          };
          await appendEvent(job.id, tagged);
        };

        await emit({
          type: "log",
          line: `[batch] ${i + 1}/${versions.length} — analyse de ${version.label}${lang ? ` (${lang})` : ""}`,
        });

        try {
          // noCache : batch = vraie analyse fraîche (le cache contentHash
          // donnait l'impression que rien ne tournait : replay express).
          const report = await analyze({
            campaign,
            version,
            brand,
            emit,
            linkCache,
            noCache: true,
            ruleConfig,
          });
          succeeded++;
          // Persistance progressive par MERGE CIBLÉ : seul le reportId de
          // CETTE version est posé — les versions attachées par un autre
          // job/route entre-temps sont préservées.
          await updateCampaign(campaign.id, (c) => {
            const v = c.versions.find((x) => x.id === version.id);
            if (v) v.reportId = report.id;
          });
        } catch (e) {
          await emit({
            type: "error",
            message: `${version.label} : ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      };

      // Pool de workers : toutes les versions en parallèle, plafonné à
      // BATCH_CONCURRENCY analyses simultanées (défaut 6) pour ne pas
      // saturer le quota TPM Foundry (le retry 429 lisse le reste).
      const concurrency = Math.min(
        versions.length,
        Math.max(1, Number(process.env.BATCH_CONCURRENCY) || 6)
      );
      let cursor = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (cursor < versions.length) {
            const i = cursor++;
            await runOne(versions[i], i);
          }
        })
      );

      // Statut final = agrégat de TOUTES les versions de la campagne (pas du
      // seul sous-ensemble analysé par ce job — un job partiel ne doit pas
      // poser GO alors qu'un autre mail est NO-GO).
      const allReports = await Reports.list();
      await updateCampaign(campaign.id, (c) => {
        if (c.humanDecision) return;
        const latest = c.versions.map((v) => latestReportFor(v, allReports));
        const anyNoGo = latest.some((r) => r?.verdict === "NO_GO");
        const anyReserves = latest.some((r) => r?.verdict === "GO_AVEC_RESERVES");
        const allAnalyzed = c.versions.length > 0 && latest.every((r) => Boolean(r));
        // Même agrégat à trois états que /api/reports/[id]/review : le pire mail
        // l'emporte. Sans la branche `anyReserves`, un batch reposerait GO franc
        // sur une campagne que l'arbitrage unitaire venait de mettre à réserves.
        c.status = anyNoGo
          ? "NO_GO"
          : allAnalyzed
            ? anyReserves
              ? "GO_AVEC_RESERVES"
              : "GO"
            : c.status;
      });
      await finishJob(job.id, succeeded > 0 ? "done" : "error");
    } catch (e) {
      // Panne inattendue hors boucle (store...) : clore le job proprement.
      await appendEvent(job.id, {
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      await finishJob(job.id, "error");
    }
  })();

  return { jobId: job.id };
}
