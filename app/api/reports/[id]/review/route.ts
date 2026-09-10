// POST : arbitrage humain d'un finding (faux positif / accepté / corrigé)
// → recalcul déterministe du verdict.
import { NextRequest, NextResponse } from "next/server";
import { Reports, updateCampaign } from "@/lib/store";
import { computeVerdict } from "@/lib/aggregate";
import { latestReportFor } from "@/lib/lang-report";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const report = await Reports.get(id);
  if (!report) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const { findingId, review } = await req.json();
  const finding = report.findings.find((f) => f.id === findingId);
  if (!finding) return NextResponse.json({ error: "finding introuvable" }, { status: 404 });
  finding.review = ["faux_positif", "accepte", "corrige"].includes(review) ? review : undefined;

  const { verdict, counters } = computeVerdict(report.findings);
  counters.passed = report.passedChecks.length;
  report.verdict = verdict;
  report.counters = counters;
  await Reports.put(report);

  // Statut CAMPAGNE = agrégat de TOUS les mails (pas du seul report arbitré) :
  // GO seulement si chaque version analysée est GO et qu'aucune n'attend d'analyse.
  const allReports = await Reports.list();
  await updateCampaign(report.campaignId, (c) => {
    if (c.humanDecision) return;
    const latest = c.versions.map((v) => latestReportFor(v, allReports));
    const allAnalyzed = latest.length > 0 && latest.every((r) => Boolean(r));
    const anyNoGo = latest.some((r) => r?.verdict === "NO_GO");
    const anyReserves = latest.some((r) => r?.verdict === "GO_AVEC_RESERVES");
    // Le pire des mails l'emporte : un seul NO_GO bloque la campagne, et une
    // seule réserve empêche le GO franc. Tant qu'un mail n'est pas analysé, le
    // statut ne progresse pas — une campagne incomplète n'est pas une campagne
    // propre.
    c.status = anyNoGo
      ? "NO_GO"
      : allAnalyzed
        ? anyReserves
          ? "GO_AVEC_RESERVES"
          : "GO"
        : c.status;
  });
  return NextResponse.json(report);
}
