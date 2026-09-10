import { NextRequest, NextResponse } from "next/server";
import { Brands } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const brand = await Brands.get(id);
  if (!brand) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  return NextResponse.json(brand);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const brand = await Brands.get(id);
  if (!brand) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  const body = await req.json();
  const allowed = [
    "name",
    "allowedLinkDomains",
    "referenceLogoUrl",
    "brandColors",
    "guidelinesSourceText",
    "compiledRules",
  ] as const;
  let bump = false;
  for (const k of allowed) {
    if (body[k] !== undefined) {
      (brand as unknown as Record<string, unknown>)[k] = body[k];
      if (k === "compiledRules" || k === "guidelinesSourceText") bump = true;
    }
  }
  if (bump) brand.version += 1;
  await Brands.put(brand);
  return NextResponse.json(brand);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await Brands.del(id);
  return NextResponse.json({ ok: true });
}
