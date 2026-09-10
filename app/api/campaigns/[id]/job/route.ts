// GET : job d'analyse ACTIF d'une campagne (lancé par "Analyze all" OU
// automatiquement au rattachement inbox). Permet à la fiche campagne de
// raccrocher la progression live sans dépendre du localStorage.
import { NextRequest, NextResponse } from "next/server";
import { activeJobForCampaign } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await activeJobForCampaign(id);
  return NextResponse.json(
    job ? { jobId: job.id, versionIds: job.versionIds } : { jobId: null }
  );
}
