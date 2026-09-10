// POST : nouvelle version d'email — HTML collé, fichier .html ou .eml.
import { NextRequest, NextResponse } from "next/server";
import { Campaigns, uid } from "@/lib/store";
import { parseMime } from "@/lib/parse-mime";
import type { EmailVersion } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  if (!campaign) return NextResponse.json({ error: "introuvable" }, { status: 404 });

  let version: EmailVersion | null = null;
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "fichier manquant" }, { status: 400 });
    const buf = Buffer.from(await file.arrayBuffer());
    if (/\.eml$/i.test(file.name)) {
      const parsed = await parseMime(buf);
      version = {
        id: uid(),
        label: `v${campaign.versions.length + 1}`,
        ...(parsed.subject ? { name: parsed.subject } : {}),
        receivedAt: new Date().toISOString(),
        source: "upload",
        html: parsed.html,
        rawMime: parsed.rawMime,
        headerChecks: parsed.headerChecks,
      };
    } else {
      version = {
        id: uid(),
        label: `v${campaign.versions.length + 1}`,
        name: file.name,
        receivedAt: new Date().toISOString(),
        source: "upload",
        html: buf.toString("utf-8"),
      };
    }
  } else {
    const body = await req.json();
    if (!body.html) return NextResponse.json({ error: "html requis" }, { status: 400 });
    version = {
      id: uid(),
      label: `v${campaign.versions.length + 1}`,
      receivedAt: new Date().toISOString(),
      source: "colle",
      html: body.html,
    };
  }

  campaign.versions.push(version);
  if (campaign.status === "EMAIL_ATTENDU" || campaign.status === "BRIEF_RECU") {
    campaign.status = "EN_ANALYSE";
  }
  campaign.updatedAt = new Date().toISOString();
  await Campaigns.put(campaign);
  return NextResponse.json({ campaign, versionId: version.id }, { status: 201 });
}
