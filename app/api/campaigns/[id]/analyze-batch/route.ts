// POST : analyse EN LOT des versions d'une campagne ("Analyze all").
// Toute la mécanique (job détaché, pool parallèle, langues, noCache) vit dans
// lib/batch-analyze.ts — partagée avec l'analyse AUTO au rattachement inbox.
import { NextRequest, NextResponse } from "next/server";
import { startBatchAnalysis } from "@/lib/batch-analyze";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { versionIds?: string[] };
  const result = await startBatchAnalysis(id, body.versionIds);
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "campagne introuvable" ? 404 : 400 }
    );
  }
  return NextResponse.json({ jobId: result.jobId });
}
