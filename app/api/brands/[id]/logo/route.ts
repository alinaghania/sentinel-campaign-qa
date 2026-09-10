// POST : scrape automatiquement le logo officiel de la marque depuis son domaine.
import { NextRequest, NextResponse } from "next/server";
import { Brands } from "@/lib/store";
import { fetchBrandLogo } from "@/lib/brand-logo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const brand = await Brands.get(id);
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });
  const domain = brand.allowedLinkDomains[0];
  if (!domain)
    return NextResponse.json(
      { error: "Add an allowed domain first (e.g. brand.com)" },
      { status: 400 }
    );
  const logo = await fetchBrandLogo(domain);
  if (!logo) return NextResponse.json({ error: "No logo found" }, { status: 404 });
  brand.referenceLogoUrl = logo;
  await Brands.put(brand);
  return NextResponse.json({ brand, logo });
}
