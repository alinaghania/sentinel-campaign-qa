import { NextRequest, NextResponse } from "next/server";
import { Brands, uid } from "@/lib/store";
import type { Brand } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await Brands.list());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.name) return NextResponse.json({ error: "name requis" }, { status: 400 });
  const brand: Brand = {
    id: uid(),
    name: body.name,
    allowedLinkDomains: body.allowedLinkDomains ?? [],
    guidelinesSourceText: body.guidelinesSourceText ?? "",
    compiledRules: [],
    version: 1,
  };
  await Brands.put(brand);
  return NextResponse.json(brand, { status: 201 });
}
