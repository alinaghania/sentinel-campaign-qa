import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { Campaigns, Reports, updateCampaign } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  if (!campaign) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const reports = (await Reports.list()).filter((r) => r.campaignId === id);
  return NextResponse.json({ campaign, reports });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const allowed = [
    "name",
    "brandId",
    "period",
    "status",
    "sendDate",
    "briefExtraction",
    "rules",
    // Éditeur de brief (preview/correction manuelle après import) :
    "briefGrid",
    "salesforceCampaignName",
    "expectedLanguages",
  ] as const;
  // Écriture sérialisée : ne pas écraser ce que les jobs d'analyse ou
  // l'extraction LLM de fond posent entre le get et le put.
  const campaign = await updateCampaign(id, (c) => {
    for (const k of allowed) {
      if (body[k] !== undefined)
        (c as unknown as Record<string, unknown>)[k] = body[k];
    }
    // Édition manuelle de la grille : le badge "AI-assisted" ne doit plus
    // prétendre que la grille vient du scout (et une proposition périmée
    // ne doit plus être applicable telle quelle).
    if (body.briefGrid !== undefined && c.briefScout &&
        (c.briefScout.status === "applied" || c.briefScout.status === "proposed")) {
      c.briefScout = { ...c.briefScout, status: "user_edited", proposedGrid: undefined };
    }
  });
  if (!campaign) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  return NextResponse.json(campaign);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Fichier brief local (.data/briefs/…) : supprimé avec la campagne (sinon
  // fuite de fichiers orphelins à chaque campagne de test effacée).
  const campaign = await Campaigns.get(id);
  if (campaign?.briefFilePath) {
    await fs.unlink(campaign.briefFilePath).catch(() => {});
  }
  await Campaigns.del(id);
  return NextResponse.json({ ok: true });
}
