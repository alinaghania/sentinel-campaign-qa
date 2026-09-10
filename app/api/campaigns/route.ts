import { NextRequest, NextResponse } from "next/server";
import { Brands, Campaigns, uid } from "@/lib/store";
import { latestTemplateId } from "@/lib/template-resolve";
import type { Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await Campaigns.list());
}

/** Marque associée automatiquement à la création : marque unique → elle,
 *  sinon match du nom de marque dans le nom de campagne (plein ou préfixe,
 *  ex "BAL Newsletter…" → "balenciaga"). */
async function autoBrandId(campaignName: string): Promise<string | undefined> {
  const brands = await Brands.list();
  if (brands.length === 0) return undefined;
  if (brands.length === 1) return brands[0].id;
  const lower = campaignName.toLowerCase();
  const full = brands.find((b) => lower.includes(b.name.toLowerCase()));
  if (full) return full.id;
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return brands.find((b) => tokens.some((t) => b.name.toLowerCase().startsWith(t)))?.id;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.name) return NextResponse.json({ error: "name requis" }, { status: 400 });
  const now = new Date().toISOString();
  const campaign: Campaign = {
    id: uid(),
    name: body.name,
    brandId: body.brandId || (await autoBrandId(body.name)),
    period: body.period || defaultPeriod(),
    status: "BRIEF_RECU",
    versions: [],
    // Référentiel ÉPINGLÉ à la création : le dernier template créé. Épingler
    // plutôt que résoudre à chaque analyse — sinon créer un template changerait
    // rétroactivement contre quoi les campagnes en cours ont été jugées.
    //
    // Le client ne peut pas le choisir depuis ce corps de requête : c'est le
    // champ qui décide de la mesure, il se pose ici et se change depuis l'écran
    // de la campagne, pas par un POST anonyme.
    templateId: await latestTemplateId(),
    createdAt: now,
    updatedAt: now,
  };
  await Campaigns.put(campaign);
  return NextResponse.json(campaign, { status: 201 });
}

function defaultPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-T${Math.floor(d.getMonth() / 3) + 1}`;
}
