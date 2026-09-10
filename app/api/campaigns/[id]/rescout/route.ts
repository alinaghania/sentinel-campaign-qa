// POST /api/campaigns/:id/rescout
//  - {} : force le structure scout LLM sur le fichier Excel du brief (bouton
//    "Re-parse with AI" — couvre aussi le faux négatif de shouldScout : une
//    grille plausible mais fausse). Tourne en fond, l'éditeur poll le statut.
//  - { apply: true } : applique la grille "proposed" du scout à la campagne.
import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { Campaigns, uid, updateCampaign } from "@/lib/store";
import { runScoutInBackground } from "@/lib/brief-scout-job";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  if (!campaign) return NextResponse.json({ error: "introuvable" }, { status: 404 });

  const body = await req.json().catch(() => ({}));

  if (body?.apply === true) {
    const updated = await updateCampaign(id, (c) => {
      const proposed = c.briefScout?.proposedGrid;
      if (c.briefScout?.status !== "proposed" || !proposed) return;
      // Le scout ne re-extrait pas le nom SF : celui du parse précédent reste valable.
      proposed.salesforceCampaignName =
        proposed.salesforceCampaignName ?? c.briefGrid?.salesforceCampaignName ?? c.salesforceCampaignName;
      c.briefGrid = proposed;
      c.expectedLanguages = proposed.languages;
      c.briefScout = { ...c.briefScout, status: "applied", proposedGrid: undefined };
    });
    if (updated?.briefScout?.status !== "applied") {
      return NextResponse.json({ error: "no proposed grid to apply" }, { status: 409 });
    }
    return NextResponse.json({ campaign: updated });
  }

  if (!campaign.briefFilePath) {
    return NextResponse.json(
      { error: "no Excel brief file stored for this campaign — re-import the brief first" },
      { status: 400 }
    );
  }

  // ORDRE ANTI-COURSE : capturer l'importId AVANT de lire le fichier. Si un
  // "Replace brief file" s'intercale (nouveau briefImportId + fichier réécrit
  // au même chemin), le buffer lu ici correspond à un importId PÉRIMÉ et la
  // garde de runScoutInBackground bloque l'écriture — jamais l'inverse.
  let importId: string | undefined;
  const updated = await updateCampaign(id, (c) => {
    if (!c.briefImportId) c.briefImportId = uid();
    importId = c.briefImportId;
    c.briefScout = { ...(c.briefScout ?? { fileHash: "" }), status: "running", startedAt: new Date().toISOString() };
  });
  if (!updated || !importId) return NextResponse.json({ error: "introuvable" }, { status: 404 });

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(campaign.briefFilePath);
  } catch {
    await updateCampaign(id, (c) => {
      if (c.briefScout?.status === "running") c.briefScout = { ...c.briefScout, status: "error" };
    });
    return NextResponse.json({ error: "stored brief file unreadable — re-import the brief" }, { status: 410 });
  }

  void runScoutInBackground(id, buffer, importId);
  return NextResponse.json({ campaign: updated });
}
