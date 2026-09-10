"use client";

// Fiche campagne : brief en rail gauche persistant + onglets Email / Rapport.
import { BarChart3, Check, ChevronLeft, FileSpreadsheet, Inbox, Loader2, Mail, Sparkles, Table2, Upload, X } from "lucide-react";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge, VerdictBadge } from "@/components/badges";
import EmailPreview from "@/components/EmailPreview";
import AnalysisView from "@/components/AnalysisView";
import { isBlocking } from "@/lib/aggregate";
import { buildMarketReport, CRITERIA, latestReportFor } from "@/lib/lang-report";
import type { AnalyzeEvent } from "@/lib/analyze";
import type { AnalysisReport, Brand, Campaign, EmailVersion } from "@/lib/types";

// Event SSE du flux job : AnalyzeEvent éventuellement tagué versionId/lang
// (batch), ou l'event d'amorçage {type:"job"} (hors job.events → hors cursor).
type BatchWireEvent =
  | (AnalyzeEvent & { versionId?: string; lang?: string })
  | { type: "job"; jobId: string };

interface BatchState {
  jobId: string;
  total: number;
  processed: number;
  label: string | null;
}

export default function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [reports, setReports] = useState<AnalysisReport[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [tab, setTab] = useState<"email" | "rapport">("email");
  const [versionIdx, setVersionIdx] = useState<number>(-1);
  const [previewMode, setPreviewMode] = useState<string>("gmail");
  const [briefImportBusy, setBriefImportBusy] = useState(false);
  const [realRenders, setRealRenders] = useState<
    Array<{ provider: "gmail" | "outlook"; device: string; url: string; capturedAt: string }>
  >([]);

  // ── Analyse en lot (Phase 4) : job persisté côté serveur, SSE replay+tail ──
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const batchEsRef = useRef<EventSource | null>(null);
  const currentJobIdRef = useRef<string | null>(null);
  // Compteurs mutables du run courant (hors re-render) ; finished=true au repos.
  const batchCtl = useRef({ received: 0, processed: 0, total: 0, gotNew: false, finished: true });
  const batchResumeTried = useRef(false);
  const openStreamRef = useRef<(jobId: string, cursor: number) => void>(() => {});
  // Reprend l'affichage live d'un job (nouveau ou en cours) — utilisé par le
  // chargement initial ET par finishBatch (jobs successifs : attach → attach).
  const resumeJobRef = useRef<(jobId: string, total: number) => void>(() => {});

  const load = useCallback(async () => {
    const [cRes, bRes] = await Promise.all([
      fetch(`/api/campaigns/${id}`),
      fetch("/api/brands"),
    ]);
    if (cRes.ok) {
      const { campaign: c, reports: r } = (await cRes.json()) as {
        campaign: Campaign;
        reports: AnalysisReport[];
      };
      setCampaign(c);
      setReports(r);
      setVersionIdx((prev) => (prev === -1 ? c.versions.length - 1 : prev));

      // Reprise cross-page (contrat job) : le job RUNNING côté serveur fait
      // foi (analyse AUTO au rattachement inbox comprise) — un jobId
      // localStorage périmé ("Analyze all" fini pendant qu'on était ailleurs)
      // ne doit pas masquer un job auto en cours. Fallback localStorage pour
      // rejouer/purger un job terminé.
      if (!batchResumeTried.current) {
        batchResumeTried.current = true;
        fetch(`/api/campaigns/${c.id}/job`)
          .then((jr) => (jr.ok ? jr.json() : { jobId: null }))
          .then((j: { jobId: string | null; versionIds?: string[] }) => {
            if (j.jobId) {
              resumeJobRef.current(j.jobId, j.versionIds?.length ?? c.versions.length);
              return;
            }
            const stored = localStorage.getItem(`analysis-batch:${c.id}`);
            if (stored) resumeJobRef.current(stored, c.versions.length);
          })
          .catch(() => {
            const stored = localStorage.getItem(`analysis-batch:${c.id}`);
            if (stored) resumeJobRef.current(stored, c.versions.length);
          });
      }
    }
    if (bRes.ok) setBrands(await bRes.json());
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const finishBatch = useCallback(() => {
    if (batchCtl.current.finished) return;
    batchCtl.current.finished = true;
    const finishedJobId = currentJobIdRef.current;
    batchEsRef.current?.close();
    batchEsRef.current = null;
    localStorage.removeItem(`analysis-batch:${id}`);
    setBatch(null);
    load(); // rafraîchit reports + matrice GO/NO-GO
    // Un AUTRE job peut encore tourner (attach en plusieurs fois) : le
    // raccrocher pour ne pas laisser une analyse invisible.
    fetch(`/api/campaigns/${id}/job`)
      .then((jr) => (jr.ok ? jr.json() : { jobId: null }))
      .then((j: { jobId: string | null; versionIds?: string[] }) => {
        if (j.jobId && j.jobId !== finishedJobId) {
          resumeJobRef.current(j.jobId, j.versionIds?.length ?? 0);
        }
      })
      .catch(() => {});
  }, [id, load]);

  const openBatchStream = useCallback(
    (jobId: string, cursor: number) => {
      batchEsRef.current?.close();
      currentJobIdRef.current = jobId;
      batchCtl.current.received = cursor;
      batchCtl.current.gotNew = false;
      const es = new EventSource(`/api/campaigns/${id}/analyze?jobId=${jobId}&cursor=${cursor}`);
      batchEsRef.current = es;
      es.onmessage = (m: MessageEvent<string>) => {
        let ev: BatchWireEvent;
        try {
          ev = JSON.parse(m.data) as BatchWireEvent;
        } catch {
          return;
        }
        if (ev.type === "job") return; // amorçage : pas dans job.events, hors cursor
        batchCtl.current.received++;
        batchCtl.current.gotNew = true;
        if (ev.type === "log") setBatchLogs((l) => [...l.slice(-400), ev.line]);
        if (ev.type === "done" || (ev.type === "error" && ev.versionId)) {
          batchCtl.current.processed++;
          const processed = batchCtl.current.processed;
          setBatch((b) => (b ? { ...b, processed } : b));
          if (ev.type === "done") load(); // la matrice se met à jour au fil de l'eau
          if (processed >= batchCtl.current.total) finishBatch();
        }
      };
      es.onerror = () => {
        es.close();
        if (batchCtl.current.finished) return;
        // Fermeture serveur sans nouvel event = job terminé (replay déjà à jour).
        if (!batchCtl.current.gotNew || batchCtl.current.processed >= batchCtl.current.total) {
          finishBatch();
        } else {
          // Coupure en cours de run : reprise au cursor (contrat job replay+tail).
          setTimeout(() => {
            if (!batchCtl.current.finished) openStreamRef.current(jobId, batchCtl.current.received);
          }, 800);
        }
      };
    },
    [id, load, finishBatch],
  );
  useEffect(() => {
    openStreamRef.current = openBatchStream;
    resumeJobRef.current = (jobId: string, total: number) => {
      batchCtl.current = { received: 0, processed: 0, total, gotNew: false, finished: false };
      setBatch({ jobId, total, processed: 0, label: "resuming the running analysis…" });
      openBatchStream(jobId, 0);
    };
  }, [openBatchStream]);

  // Démontage : on ferme le flux, l'analyse continue côté serveur (job).
  useEffect(
    () => () => {
      batchEsRef.current?.close();
    },
    [],
  );

  // Rendus réels (screenshots Gmail/Outlook Web) de la version affichée.
  const currentVersionId = campaign
    ? (campaign.versions[versionIdx] ?? campaign.versions[campaign.versions.length - 1])?.id
    : undefined;
  useEffect(() => {
    let alive = true;
    const fetched: Promise<Array<{ provider: "gmail" | "outlook"; device: string; url: string; capturedAt: string }>> =
      currentVersionId
        ? fetch(`/api/renders/${currentVersionId}`).then((r) => (r.ok ? r.json() : []))
        : Promise.resolve([]);
    fetched
      .then((rs) => {
        if (alive) setRealRenders(rs);
      })
      .catch(() => {
        if (alive) setRealRenders([]);
      });
    return () => {
      alive = false;
    };
  }, [currentVersionId, reports.length]);

  if (!campaign) return <div className="py-20 text-center text-dim">Loading…</div>;

  const version = campaign.versions[versionIdx] ?? campaign.versions[campaign.versions.length - 1];
  // Sélecteur UNIQUE (latestReportFor) : même report partout (liste, Focus,
  // matrice) — et jamais le report d'une autre version via un id épinglé périmé.
  const report = version ? (latestReportFor(version, reports) ?? null) : null;
  // Approve GO = décision CAMPAGNE : tous les mails doivent être analysés et
  // non bloquants (critiques traitées), pas seulement le mail affiché.
  // `isBlocking` et pas `=== "GO"` : un mail à réserves n'interdit pas d'approuver
  // — c'est exactement ce que le troisième verdict rend possible. Les réserves
  // restent visibles dans le rapport, l'humain les lit avant de cliquer.
  const marketRows = buildMarketReport(campaign, reports);
  const allTreated =
    marketRows.length > 0 &&
    marketRows.every((r) => r.verdict !== "—" && !isBlocking(r.verdict));

  async function importBriefFile(file: File) {
    setBriefImportBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/campaigns/${campaign!.id}/brief`, { method: "POST", body: form });
      if (res.ok) {
        // Même parcours qu'à la création : preview/édition du brief.
        router.push(`/campaigns/${campaign!.id}/brief`);
        return;
      }
      await load();
    } finally {
      setBriefImportBusy(false);
    }
  }

  async function decide(decision: "GO" | "NO_GO") {
    await fetch(`/api/campaigns/${campaign!.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    load();
  }

  async function startBatch() {
    if (batch || campaign!.versions.length === 0) return;
    const res = await fetch(`/api/campaigns/${campaign!.id}/analyze-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}), // toutes les versions de la campagne
    });
    if (!res.ok) return;
    const { jobId } = (await res.json()) as { jobId: string };
    localStorage.setItem(`analysis-batch:${campaign!.id}`, jobId);
    const total = campaign!.versions.length;
    batchCtl.current = { received: 0, processed: 0, total, gotNew: false, finished: false };
    setBatch({ jobId, total, processed: 0, label: `analyzing ${total} emails in parallel…` });
    setBatchLogs([]);
    openBatchStream(jobId, 0);
  }

  const brand = brands.find((b) => b.id === campaign.brandId);

  return (
    <div className="space-y-4">
      {/* En-tête */}
      <div className="flex flex-wrap items-center gap-3">
        <a href="/" className="text-dim hover:text-fg"><ChevronLeft size={18} /></a>
        <h1 className="text-[15px] font-black uppercase tracking-[0.14em]">{campaign.name}</h1>
        <StatusBadge status={campaign.status} />
        {brand && (
          <a
            href="/brands"
            className="text-[12px] font-semibold uppercase tracking-[0.1em] text-dim hover:text-fg"
            title="Brand associated with this campaign (guidelines applied to the analysis)"
          >
            {brand.name} · guidelines v{brand.version}
          </a>
        )}
        {/* Chemin de secours : campagne créée sans brief (ou import raté à la
            création) — sans ça, aucun moyen de poser le brief après coup. */}
        {!campaign.briefGrid && !campaign.briefRaw && (
          <label
            className="btn cursor-pointer"
            style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
            title="This campaign has no brief — the QA needs it (languages, copy, links, tracking)"
          >
            {briefImportBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {briefImportBusy ? "Importing brief…" : "Import brief"}
            <input
              type="file"
              className="hidden"
              accept=".xlsx,.xlsm,.xls,.pdf,.pptx,.ppt"
              disabled={briefImportBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importBriefFile(f);
              }}
            />
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {campaign.humanDecision ? (
            <span
              className="text-sm font-bold"
              
            >
              Decision: {campaign.humanDecision === "GO" ? "GO" : "NO-GO"}{" "}
              <span className="font-normal text-dim">
                ({campaign.humanDecisionAt?.slice(0, 16).replace("T", " ")})
              </span>
            </span>
          ) : (
            <>
              <button
                className="btn"
                style={{ borderColor: "#111" }}
                disabled={!allTreated}
                title={
                  !allTreated
                    ? "Every attached email must be analyzed and GO (resolve critical findings) before approving"
                    : "Approve the GO (human decision, timestamped)"
                }
                onClick={() => decide("GO")}
              >
                <Check size={15} style={{ color: "var(--gold)" }} /> Approve GO
              </button>
              <button
                className="btn"
                style={{ borderColor: "#111" }}
                disabled={!report}
                onClick={() => decide("NO_GO")}
              >
                <X size={15} style={{ color: "#b3261e" }} /> NO-GO
              </button>
            </>
          )}
        </div>
      </div>

      <div className={tab === "email" ? "grid grid-cols-[320px_1fr] gap-4" : ""}>
        {/* Rail mockup — onglet Email uniquement (inutile sur le Report) */}
        {tab === "email" && <MockupSidebar campaign={campaign} />}

        {/* Zone principale */}
        <div className="min-w-0 space-y-3">
          {/* Barre d'action : EMAIL · REPORT · ANALYZE ALL */}
          <div className="flex items-center gap-2">
            {(["email", "rapport"] as const).map((t) => (
              <button
                key={t}
                className="btn"
                style={
                  tab === t
                    ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" }
                    : undefined
                }
                onClick={() => setTab(t)}
              >
                {t === "email" ? <><Mail size={15} /> Email</> : <><BarChart3 size={15} /> Report</>}
              </button>
            ))}
            {campaign.versions.length > 0 && (
              <button
                className="btn"
                title="Analyze every attached email (runs in parallel — keeps running even if you leave the page)"
                disabled={batch != null}
                onClick={() => {
                  setTab("rapport");
                  startBatch();
                }}
                style={{ background: "#111", borderColor: "#111", color: "#fff" }}
              >
                {batch ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}{" "}
                Analyze all
              </button>
            )}
          </div>

          {/* Progression de l'analyse en lot (job serveur, survit à la navigation) */}
          {batch && (
            <div className="card flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <Loader2 size={15} className="shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
              <span className="shrink-0 font-bold">Batch analysis</span>
              <span className="min-w-0 truncate text-dim">{batch.label ?? "starting…"}</span>
              <span className="ml-auto shrink-0 font-semibold tabular-nums">
                {batch.processed}/{batch.total}
              </span>
              <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full" style={{ background: "var(--accent-soft)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${batch.total > 0 ? Math.round((batch.processed / batch.total) * 100) : 0}%`,
                    background: "var(--accent)",
                  }}
                />
              </div>
            </div>
          )}

          {/* Terminal live des actions LLM pendant le batch */}
          {batch && (
            <BatchTerminal logs={batchLogs} />
          )}

          {!version ? (
            <div className="card grid place-items-center gap-3 p-12 text-center text-dim">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/letter/wait.png" alt="" className="h-36 w-36" />
              <p>No email yet</p>
              <a className="btn" href="/inbox">
                <Inbox size={14} /> Open inbox
              </a>
            </div>
          ) : tab === "email" ? (
            <div className="grid grid-cols-[280px_1fr] items-start gap-3">
              {/* Liste des mails attachés — sélection = preview à droite */}
              <div className="card divide-y divide-bd overflow-hidden p-0">
                {campaign.versions.map((v, i) => {
                  const vr = latestReportFor(v, reports);
                  const selected = v.id === version.id;
                  return (
                    <button
                      key={v.id}
                      className="block w-full px-3 py-2.5 text-left transition-colors hover:bg-accent-soft"
                      style={selected ? { background: "var(--accent-soft)", boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}
                      onClick={() => setVersionIdx(i)}
                    >
                      <div className="truncate text-[12.5px] font-semibold" title={versionName(v, reports)}>
                        {versionName(v, reports)}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-dim">
                        {v.language && <span className="font-bold uppercase">{v.language}</span>}
                        <span>{v.receivedAt.slice(0, 10)}</span>
                        {vr ? (
                          <span
                            className="ml-auto font-bold"
                            style={{ color: isBlocking(vr.verdict) ? "var(--crit)" : "var(--ok)" }}
                          >
                            {vr.verdict === "GO"
                              ? "GO"
                              : vr.verdict === "GO_AVEC_RESERVES"
                                ? "GO (RES.)"
                                : "NO-GO"}
                          </span>
                        ) : (
                          <span className="ml-auto">not analyzed</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="min-w-0 space-y-2">
              {realRenders.length > 0 && (
                <div className="flex items-center gap-2">
                  {realRenders.map((r) => (
                    <button
                      key={`${r.provider}-${r.device}`}
                      className="btn"
                      title={`${r.provider === "gmail" ? "Gmail" : "Outlook"} Web ${r.device} — capturé ${r.capturedAt.slice(0, 16).replace("T", " ")}`}
                      style={
                        previewMode === `real:${r.provider}-${r.device}`
                          ? { borderColor: "var(--ok)", color: "var(--ok)", background: "var(--accent-soft)" }
                          : { borderColor: "var(--ok)" }
                      }
                      onClick={() => setPreviewMode(`real:${r.provider}-${r.device}`)}
                    >
                      {r.device === "desktop"
                        ? r.provider === "gmail" ? "Gmail" : "Outlook"
                        : `${r.device.replace("mobile-", "")}px`}
                    </button>
                  ))}
                </div>
              )}
              {(() => {
                // Screenshot sélectionné, sinon le premier disponible, sinon
                // fallback : HTML du mail rendu en direct (mail pas encore capturé).
                const activeReal =
                  realRenders.find((r) => `real:${r.provider}-${r.device}` === previewMode) ??
                  realRenders[0];
                return (
                  <div className="mx-auto">
                    {activeReal ? (
                      <div className="overflow-hidden rounded border border-bd bg-white">
                        <div className="flex items-center gap-2 border-b border-bd px-3 py-2 text-[12px] font-semibold text-dim">
                          <span className="h-2 w-2 rounded-full" style={{ background: "var(--ok)" }} />
                          {activeReal.provider === "gmail" ? "Gmail Web" : "Outlook Web"} — {activeReal.device === "desktop" ? "desktop" : `${activeReal.device.replace("mobile-", "")}px`}
                          <span className="ml-auto font-normal">
                            captured {activeReal.capturedAt.slice(0, 16).replace("T", " ")}
                          </span>
                        </div>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={activeReal.url}
                          alt="Rendering"
                          className={activeReal.device.startsWith("mobile") ? "mx-auto block max-w-[430px]" : "w-full"}
                        />
                      </div>
                    ) : (
                      <EmailPreview html={version.html} mode="desktop" scheme="light" />
                    )}
                  </div>
                );
              })()}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Vue d'ensemble : GO/NO-GO par marché (un mail = une ligne) + export */}
              <MarketMatrix
                campaign={campaign}
                reports={reports}
                selectedVersionId={version.id}
                onSelectVersion={(vid) => {
                  const i = campaign.versions.findIndex((v) => v.id === vid);
                  if (i >= 0) setVersionIdx(i);
                }}
              />
              {/* Focus par email : détail des problèmes (trad, liens, UTM…) */}
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-bold uppercase tracking-[0.1em] text-dim">Focus</span>
                <span className="truncate font-semibold">{versionName(version, reports)}</span>
                <span className="text-dim">— click a row above to switch email</span>
              </div>
              {/* key : changer de mail REMONTE le composant — sinon un run en
                  cours et son rapport final seraient attribués au mail
                  nouvellement sélectionné. */}
              <AnalysisView
                key={version.id}
                campaignId={campaign.id}
                versionId={version.id}
                existingReport={report}
                onDone={load}
              />
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

// Sidebar mockup uniquement : l'image du brief (Excel ou upload), zoomable.
function MockupSidebar({ campaign }: { campaign: Campaign }) {
  const [zoomed, setZoomed] = useState(false);
  const mockup = campaign.briefMockups?.[0] ?? null;

  return (
    <aside className="min-w-0 space-y-3 self-start">
      <div className="doc-title text-[26px] leading-tight">Mockup</div>

      {mockup ? (
        <>
          <button
            type="button"
            className="block w-full cursor-zoom-in overflow-hidden border border-bd bg-white"
            title="Click to zoom"
            onClick={() => setZoomed(true)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mockup.dataUrl} alt={mockup.name} className="w-full" />
          </button>
          {zoomed && (
            <div
              className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/75 p-6"
              role="dialog"
              aria-label={`Mockup — ${mockup.name}`}
              onClick={() => setZoomed(false)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mockup.dataUrl}
                alt={mockup.name}
                className="max-h-full max-w-full border border-bd bg-white object-contain"
              />
            </div>
          )}
        </>
      ) : (
        <div className="border border-bd px-4 py-10 text-center text-[12px] text-dim">
          No mockup — it comes with the brief uploaded at campaign creation
        </div>
      )}
    </aside>
  );
}

/** Nom affichable d'une version : nom réel du mail (sujet/fichier) posé à
 *  l'attache, sinon sujet extrait par l'analyse (facts), sinon label v1/v2. */
function versionName(v: EmailVersion | undefined, reports: AnalysisReport[]): string {
  if (!v) return "";
  if (v.name) return v.name;
  const report = latestReportFor(v, reports);
  return report?.facts?.subject || `${v.label} · ${v.source}`;
}

function MarketMatrix({
  campaign,
  reports,
  selectedVersionId,
  onSelectVersion,
}: {
  campaign: Campaign;
  reports: AnalysisReport[];
  selectedVersionId?: string;
  onSelectVersion?: (versionId: string) => void;
}) {
  const rows = buildMarketReport(campaign, reports);
  if (rows.length === 0) return null;
  const cell = (n: number, hasReport: boolean, key: string) => (
    <td key={key} className="py-1.5 pr-3 text-center tabular-nums">
      {!hasReport ? (
        <span className="text-dim">—</span>
      ) : n > 0 ? (
        <span style={{ color: "var(--crit)", fontWeight: 700 }}>{n}</span>
      ) : (
        <Check size={14} className="inline" style={{ color: "var(--ok)" }} />
      )}
    </td>
  );
  return (
    <div className="card space-y-2 px-4 py-2.5 text-[13px]">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 font-bold">
          <Table2 size={15} /> GO / NO-GO by market
        </span>
        <a
          className="btn ml-auto"
          href={`/api/campaigns/${campaign.id}/export`}
          title="Export the report to Excel (verdicts + findings)"
        >
          <FileSpreadsheet size={14} /> Export Excel
        </a>
      </div>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="text-[11px] uppercase tracking-[0.08em] text-dim">
            <th className="py-1 pr-3 font-bold">Market</th>
            <th className="py-1 pr-3 font-bold">Email</th>
            <th className="py-1 pr-3 font-bold">Verdict</th>
            <th className="py-1 pr-3 text-right font-bold">Errors</th>
            {CRITERIA.map((c) => (
              <th key={c.key} className="py-1 pr-3 text-center font-bold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const hasReport = r.verdict !== "—";
            const clickable = Boolean(onSelectVersion);
            return (
              <tr
                key={r.versionId}
                className={`border-t border-bd ${clickable ? "cursor-pointer hover:bg-accent-soft" : ""}`}
                style={
                  r.versionId === selectedVersionId
                    ? { background: "var(--accent-soft)" }
                    : undefined
                }
                title={clickable ? "Show this email's detailed report below" : undefined}
                onClick={clickable ? () => onSelectVersion!(r.versionId) : undefined}
              >
                <td className="py-1.5 pr-3 font-bold">
                  {r.market ?? <span className="font-normal text-dim">?</span>}
                  {r.language && (
                    <span className="ml-1 font-normal uppercase text-dim">· {r.language}</span>
                  )}
                </td>
                <td className="max-w-72 truncate py-1.5 pr-3 text-dim" title={r.name}>
                  {r.name}
                </td>
                <td className="py-1.5 pr-3">
                  {r.verdict === "—" ? (
                    <span className="text-dim" title="Not analyzed yet">—</span>
                  ) : (
                    <VerdictBadge verdict={r.verdict} />
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {!hasReport ? (
                    <span className="text-dim">—</span>
                  ) : (
                    <b style={{ color: r.total > 0 ? "var(--crit)" : "var(--ok)" }}>{r.total}</b>
                  )}
                </td>
                {CRITERIA.map((c) => cell(r.byCriterion[c.key] ?? 0, hasReport, c.key))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Terminal live des actions LLM pendant l'analyse groupée (batch).
function BatchTerminal({ logs }: { logs: string[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [logs]);
  const color = (l: string) =>
    l.includes(" ✗ ") || l.includes("ERREUR") || l.includes("CASSE") || l.includes("error")
      ? "#ff8080"
      : l.includes(" ↻ ")
        ? "#f5c451"
        : l.includes("↳")
          ? "#6ea882"
          : l.includes("[batch]") || l.includes("llm:") || l.includes("terminé:")
            ? "#5ee38f"
            : "#9dd8ae";
  return (
    <div className="overflow-hidden rounded-xl border border-bd bg-black">
      <div className="flex items-center gap-1.5 border-b border-bd px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 font-mono text-[11px] text-dim">sentinel — batch analysis (live)</span>
      </div>
      <div className="max-h-72 overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed">
        {logs.length === 0 ? (
          <span className="pulse" style={{ color: "#5ee38f" }}>$ starting batch…</span>
        ) : (
          logs.map((l, i) => (
            <div key={i} style={{ color: color(l) }}>
              {l}
            </div>
          ))
        )}
        <span className="pulse" style={{ color: "#5ee38f" }}>▍</span>
        <div ref={endRef} />
      </div>
    </div>
  );
}
