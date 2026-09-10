// Jobs d'arrière-plan de l'import de brief (pattern extractLanguagesInBackground :
// garde briefImportId, écriture sérialisée via updateCampaign, ne throw jamais).
// Partagés entre POST /brief (import) et POST /rescout (bouton "Re-parse with AI").

import { updateCampaign } from "./store";
import { runStructureScout } from "./brief-scout";
import { auditBriefCompleteness } from "./brief-audit";
import type { BriefParseTelemetry } from "./brief-grid";
import type { BriefGrid } from "./types";

/** Structure scout LLM. Auto-apply UNIQUEMENT si aucune grille n'existe ;
 *  sinon "proposed" (bouton "Apply AI parse" dans l'éditeur) — le scout
 *  n'écrase jamais une grille existante. */
export async function runScoutInBackground(
  id: string,
  buffer: Buffer,
  importId: string,
  telemetry?: BriefParseTelemetry
) {
  try {
    const res = await runStructureScout(buffer, telemetry);
    await updateCampaign(id, (fresh) => {
      if (fresh.briefImportId !== importId) return; // brief remplacé entre-temps
      const prev = fresh.briefScout ?? { status: "running" as const, fileHash: "" };
      const finishedAt = new Date().toISOString();
      if (!res.ok) {
        fresh.briefScout = { ...prev, status: "error", finishedAt };
        const msg = `AI structure scout unavailable or plan rejected — review the grid manually (${res.error.slice(0, 120)})`;
        fresh.briefParseWarnings = [...new Set([...(fresh.briefParseWarnings ?? []), ...res.warnings, msg])];
        return;
      }
      if (!fresh.briefGrid) {
        fresh.briefGrid = res.grid;
        fresh.expectedLanguages = res.grid.languages;
        fresh.briefScout = { ...prev, status: "applied", confidence: res.confidence, plan: res.plan, finishedAt };
      } else {
        fresh.briefScout = {
          ...prev,
          status: "proposed",
          confidence: res.confidence,
          plan: res.plan,
          proposedGrid: res.grid,
          finishedAt,
        };
      }
      if (res.warnings.length > 0) {
        fresh.briefParseWarnings = [...new Set([...(fresh.briefParseWarnings ?? []), ...res.warnings])];
      }
    });
  } catch (err) {
    console.warn("[brief] structure scout (arrière-plan) échoué :", err);
    // Ne jamais laisser un statut "running" éternel (badge bloqué, bouton
    // "Re-parse with AI" masqué) : best-effort vers "error", même garde.
    try {
      await updateCampaign(id, (fresh) => {
        if (fresh.briefImportId !== importId) return;
        if (fresh.briefScout?.status === "running") {
          fresh.briefScout = { ...fresh.briefScout, status: "error", finishedAt: new Date().toISOString() };
        }
      });
    } catch { /* le watchdog startedAt (UI) couvre le pire cas */ }
  }
}

/** Audit LLM de complétude (code auparavant dormant, branché ici) : compare le
 *  brief brut à ce que le parseur a capté, merge les manques dans
 *  briefParseWarnings — plus jamais de perte silencieuse. Non bloquant. */
export async function runAuditInBackground(
  id: string,
  markdown: string,
  grid: BriefGrid | null,
  importId: string
) {
  try {
    const warnings = await auditBriefCompleteness(markdown, {
      languages: grid?.languages,
      blocks: grid?.blocks.map((b) => b.name),
      salesforceCampaignName: grid?.salesforceCampaignName ?? null,
    });
    if (warnings.length === 0) return;
    await updateCampaign(id, (fresh) => {
      if (fresh.briefImportId !== importId) return;
      const prefixed = warnings.map((w) => `AI audit: ${w.slice(0, 200)}`);
      fresh.briefParseWarnings = [...new Set([...(fresh.briefParseWarnings ?? []), ...prefixed])];
    });
  } catch (err) {
    console.warn("[brief] audit complétude (arrière-plan) échoué :", err);
    // TROISIÈME ÉTAT, et il manquait. Sans cette écriture, un audit TOMBÉ et un
    // brief SANS PERTE rendaient le même écran : pas de bandeau,
    // `briefParseWarnings` undefined. Le silence de l'instrument prenait donc
    // l'apparence d'un feu vert — et c'est le pire endroit où le laisser faire,
    // parce que cet audit est aujourd'hui le SEUL témoin d'une perte de colonne
    // de langue : le parseur déterministe ne remonte que `unmappedFields`, des
    // CHAMPS non mappés, jamais une colonne MX/ZHT/TH tombée.
    //
    // Même canal que l'échec du scout ci-dessus (`briefParseWarnings`) : il est
    // déjà lu, déjà affiché, et un troisième canal ne serait pas regardé. On
    // n'écrit rien sur la complétude — on écrit qu'elle n'a pas été mesurée.
    try {
      await updateCampaign(id, (fresh) => {
        if (fresh.briefImportId !== importId) return; // brief remplacé entre-temps
        const msg = `AI completeness audit unavailable — the grid was NOT cross-checked against the raw brief, so a missing language column or block would not be reported here (${String(err).slice(0, 120)})`;
        fresh.briefParseWarnings = [...new Set([...(fresh.briefParseWarnings ?? []), msg])];
      });
    } catch {
      // Best-effort : si le store lui-même est tombé, le console.warn ci-dessus
      // reste la seule trace. Ne pas laisser cette seconde panne masquer la
      // première en jetant depuis un job d'arrière-plan non attendu.
    }
  }
}
