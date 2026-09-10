import { NextRequest, NextResponse } from "next/server";
import { Reports } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const report = await Reports.get(id);
  if (!report) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  return NextResponse.json(report);
}
