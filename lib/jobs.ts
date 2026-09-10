// Jobs d'analyse persistés — survivent aux déconnexions SSE et aux
// changements de page. L'analyse écrit ses events dans le job (appendEvent) ;
// un client reconnecté rejoue events.slice(cursor) puis taile les nouveaux.

import type { AnalyzeEvent } from "./analyze";
import { Jobs, uid } from "./store";
import type { AnalysisJob } from "./types";

// File d'attente d'écriture PAR job : les workers LLM émettent en parallèle, donc
// appendEvent/finishJob d'un même job doivent être sérialisés — sinon deux
// read-modify-write concurrents se battent sur le .tmp du FileStore (ENOENT au
// rename) et des events sont perdus. Chaîne de promesses par jobId.
const writeChains = new Map<string, Promise<unknown>>();
function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(jobId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // enchaîne même si la précédente a échoué
  writeChains.set(jobId, next.then(() => undefined, () => undefined));
  return next;
}

/** Crée et persiste un nouveau job d'analyse (status "running"). */
export async function createJob(input: {
  campaignId: string;
  versionIds: string[];
}): Promise<AnalysisJob> {
  const now = new Date().toISOString();
  const job: AnalysisJob = {
    id: uid(),
    campaignId: input.campaignId,
    versionIds: input.versionIds,
    status: "running",
    events: [],
    createdAt: now,
    updatedAt: now,
  };
  await Jobs.put(job);
  return job;
}

/** Ajoute un event au journal du job. No-op si le job n'existe plus.
 *  Sérialisé par job (withJobLock) : sûr sous émission parallèle des workers. */
export async function appendEvent(jobId: string, ev: AnalyzeEvent): Promise<void> {
  await withJobLock(jobId, async () => {
    const job = await Jobs.get(jobId);
    if (!job) return;
    job.events.push(ev);
    job.updatedAt = new Date().toISOString();
    await Jobs.put(job);
  });
}

/** Relit le job depuis le store (null si absent). */
export async function getJob(jobId: string): Promise<AnalysisJob | null> {
  return Jobs.get(jobId);
}

/** Clôt le job avec le statut final. No-op si le job n'existe plus. */
export async function finishJob(
  jobId: string,
  status: "done" | "error"
): Promise<void> {
  await withJobLock(jobId, async () => {
    const job = await Jobs.get(jobId);
    if (!job) return;
    job.status = status;
    job.updatedAt = new Date().toISOString();
    await Jobs.put(job);
  });
}

/** Job "running" le plus récent pour une campagne (null s'il n'y en a pas). */
export async function activeJobForCampaign(
  campaignId: string
): Promise<AnalysisJob | null> {
  const jobs = await Jobs.list();
  const running = jobs
    .filter((j) => j.campaignId === campaignId && j.status === "running")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return running[0] ?? null;
}
