// POST : décision humaine GO/NO-GO — distincte du verdict IA, horodatée.
import { NextRequest, NextResponse } from "next/server";
import { Campaigns } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  if (!campaign) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const { decision } = await req.json();
  if (decision !== "GO" && decision !== "NO_GO")
    return NextResponse.json({ error: "decision invalide" }, { status: 400 });
  campaign.humanDecision = decision;
  campaign.humanDecisionAt = new Date().toISOString();
  campaign.status = decision === "GO" ? "GO" : "CORRECTIONS";
  campaign.updatedAt = new Date().toISOString();
  await Campaigns.put(campaign);
  return NextResponse.json(campaign);
}
