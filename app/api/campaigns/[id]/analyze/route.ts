// GET SSE : analyse en direct — Response retournée immédiatement sur un
// ReadableStream, heartbeat 15s (timeout Envoy ACA 240s), pas de buffering.
//
// Contrat "job" (persistance cross-page) :
// - Sans ?jobId : crée un AnalysisJob, émet {type:"job",jobId} en premier, puis
//   lance analyze() en tâche de fond DÉTACHÉE du stream (l'analyse continue si
//   le client se déconnecte : chaque event est persisté via appendEvent, et
//   l'enqueue vers le client est gardé par try/catch).
// - Avec ?jobId=X&cursor=N : ne relance RIEN ; rejoue job.events.slice(N) puis
//   taile les nouveaux events (poll 400 ms) jusqu'à status !== "running".
import { NextRequest } from "next/server";
import { Brands, Campaigns } from "@/lib/store";
import { analyze, type AnalyzeEvent } from "@/lib/analyze";
import { appendEvent, createJob, finishJob, getJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type WireEvent = AnalyzeEvent | { type: "job"; jobId: string };

const encoder = new TextEncoder();

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
} as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const jobId = req.nextUrl.searchParams.get("jobId");

  // ── Reconnexion : replay + tail d'un job existant, sans relancer l'analyse ──
  if (jobId) {
    const job = await getJob(jobId);
    if (!job || job.campaignId !== id)
      return new Response("job introuvable", { status: 404 });

    const cursorRaw = req.nextUrl.searchParams.get("cursor");
    const cursor = Math.max(0, Number.parseInt(cursorRaw ?? "0", 10) || 0);

    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const send = (e: WireEvent) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            closed = true;
            clearInterval(heartbeat);
          }
        }, 15_000);

        (async () => {
          let idx = cursor;
          try {
            send({ type: "job", jobId });
            while (!closed) {
              const current = await getJob(jobId);
              if (!current) {
                send({ type: "error", message: "job introuvable" });
                break;
              }
              for (; idx < current.events.length; idx++) send(current.events[idx]);
              if (current.status !== "running") break;
              await sleep(400);
            }
          } catch {
            // client déconnecté (enqueue après close) : on arrête juste le tail
          } finally {
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              // déjà fermé
            }
          }
        })();
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  // ── Démarrage : nouveau job + analyse en tâche de fond détachée ──
  const versionId = req.nextUrl.searchParams.get("versionId");
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";

  const campaign = await Campaigns.get(id);
  if (!campaign) return new Response("introuvable", { status: 404 });
  const version = versionId
    ? campaign.versions.find((v) => v.id === versionId)
    : campaign.versions[campaign.versions.length - 1];
  if (!version) return new Response("aucune version d'email", { status: 400 });
  const brand = campaign.brandId ? await Brands.get(campaign.brandId) : null;

  const job = await createJob({ campaignId: id, versionIds: [version.id] });

  const stream = new ReadableStream({
    start(controller) {
      let open = true;
      const push = (e: WireEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false; // client parti : l'analyse continue via le job
        }
      };
      const heartbeat = setInterval(() => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          open = false;
        }
      }, 15_000);

      // Le client mémorise l'id du job avant tout autre event.
      push({ type: "job", jobId: job.id });

      // Tâche de fond DÉTACHÉE : ne dépend pas du contrôleur — persiste chaque
      // event dans le job, et pousse au client seulement s'il écoute encore.
      (async () => {
        const emit = async (e: AnalyzeEvent) => {
          await appendEvent(job.id, e);
          push(e);
        };
        try {
          campaign.status = "EN_ANALYSE";
          campaign.updatedAt = new Date().toISOString();
          await Campaigns.put(campaign);

          const report = await analyze({
            campaign,
            version,
            brand,
            emit,
            noCache: fresh,
          });

          version.reportId = report.id;
          // Table EXPLICITE verdict → statut. Les deux énumérations partagent
          // trois libellés aujourd'hui ; les assigner l'une à l'autre ferait
          // entrer en silence tout futur verdict dans le statut de campagne.
          campaign.status =
            report.verdict === "GO"
              ? "GO"
              : report.verdict === "GO_AVEC_RESERVES"
                ? "GO_AVEC_RESERVES"
                : "NO_GO";
          campaign.updatedAt = new Date().toISOString();
          await Campaigns.put(campaign);
          await finishJob(job.id, "done");
        } catch (e) {
          await emit({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          });
          await finishJob(job.id, "error");
        } finally {
          clearInterval(heartbeat);
          if (open) {
            open = false;
            try {
              controller.close();
            } catch {
              // déjà fermé
            }
          }
        }
      })();
    },
    cancel() {
      // Déconnexion client : on n'interrompt PAS l'analyse (contrat job).
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
