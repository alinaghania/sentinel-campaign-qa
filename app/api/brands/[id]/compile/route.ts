// POST : compile les guidelines texte libre → règles typées (revue humaine ensuite).
import { NextRequest, NextResponse } from "next/server";
import { Brands } from "@/lib/store";
import { compileGuidelines } from "@/lib/guidelines";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const brand = await Brands.get(id);
  if (!brand) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const source = body.guidelinesSourceText ?? brand.guidelinesSourceText;
  if (!source?.trim())
    return NextResponse.json({ error: "guidelines vides" }, { status: 400 });

  const res = await compileGuidelines(source, brand.name);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });

  brand.guidelinesSourceText = source;
  brand.compiledRules = res.rules;
  brand.compiledAt = new Date().toISOString();
  brand.version += 1;
  await Brands.put(brand);
  return NextResponse.json({ brand, contradictions: res.contradictions });
}
