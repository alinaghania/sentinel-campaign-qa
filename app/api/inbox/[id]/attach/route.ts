// POST : rattacher un mail reçu à une campagne → devient une version d'email.
import { NextRequest, NextResponse } from "next/server";
import { Campaigns, Inbox, uid, updateCampaign } from "@/lib/store";
import { startBatchAnalysis } from "@/lib/batch-analyze";
import type { EmailVersion } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const email = await Inbox.get(id);
  if (!email) return NextResponse.json({ error: "mail introuvable" }, { status: 404 });
  const { campaignId } = await req.json();
  const campaign = await Campaigns.get(campaignId ?? email.campaignId);
  if (!campaign) return NextResponse.json({ error: "campagne introuvable" }, { status: 404 });
  if (!email.html) return NextResponse.json({ error: "mail sans HTML" }, { status: 400 });

  const version: EmailVersion = {
    id: uid(),
    label: "v?", // renuméroté dans le mutator
    ...(email.subject ? { name: email.subject } : {}),
    providerMessageId: email.providerMessageId,
    receivedAt: email.receivedAt,
    source: email.provider,
    html: email.html,
    rawMime: email.rawMime,
    headerChecks: email.headerChecks,
  };
  // Écriture sérialisée (updateCampaign) : un job d'analyse concurrent ne peut
  // pas effacer cette version, ni l'inverse.
  await updateCampaign(campaign.id, (c) => {
    version.label = `v${c.versions.length + 1}`;
    c.versions.push(version);
    if (c.status === "EMAIL_ATTENDU" || c.status === "BRIEF_RECU") {
      c.status = "EN_ANALYSE";
    }
  });

  email.campaignId = campaign.id;
  email.matchConfirmed = true;
  await Inbox.put(email);

  // ANALYSE AUTOMATIQUE du mail rattaché (zéro clic) — l'analyse capture
  // aussi les screenshots via son étape "rendu réel".
  const started = await startBatchAnalysis(campaign.id, [version.id]);

  return NextResponse.json({
    campaignId: campaign.id,
    versionId: version.id,
    jobId: "jobId" in started ? started.jobId : null,
  });
}
