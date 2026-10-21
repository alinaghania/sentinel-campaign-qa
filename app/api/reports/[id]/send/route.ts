// POST : envoie par email une sélection de findings d'un rapport, depuis le
// compte Gmail du .env (SMTP). Corps : { to, findingIds, note? }.
import { NextRequest, NextResponse } from "next/server";
import { Campaigns, Reports } from "@/lib/store";
import {
  MAX_RECIPIENTS,
  buildFindingsEmail,
  parseRecipients,
  sendEmail,
  smtpConfigured,
} from "@/lib/send-findings";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const report = await Reports.get(id);
  if (!report) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  if (!smtpConfigured()) {
    return NextResponse.json(
      { error: "Envoi indisponible : IMAP_USER / IMAP_PASSWORD non configurés" },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { valid, invalid } = parseRecipients(typeof body.to === "string" ? body.to : "");
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Adresse invalide : ${invalid.join(", ")}` }, { status: 400 });
  }
  if (valid.length === 0 || valid.length > MAX_RECIPIENTS) {
    return NextResponse.json(
      { error: `Entre 1 et ${MAX_RECIPIENTS} destinataires attendus` },
      { status: 400 }
    );
  }
  const ids = new Set(Array.isArray(body.findingIds) ? body.findingIds : []);
  const findings = report.findings.filter((f) => ids.has(f.id));
  if (findings.length === 0) {
    return NextResponse.json({ error: "Aucun finding sélectionné" }, { status: 400 });
  }

  const campaign = await Campaigns.get(report.campaignId);
  const version = campaign?.versions.find((v) => v.id === report.versionId);
  const mail = buildFindingsEmail({
    report,
    findings,
    campaignName: campaign?.name ?? report.campaignId,
    emailName: version?.name ?? version?.label,
    note: typeof body.note === "string" ? body.note.slice(0, 2000) : undefined,
  });

  try {
    await sendEmail({ to: valid, ...mail });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Échec de l'envoi : ${msg.slice(0, 200)}` }, { status: 502 });
  }
  return NextResponse.json({ sent: findings.length, to: valid });
}
