// GET : rendus réels capturés pour une version (liste pour l'UI).
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { listRenders } from "@/lib/render-real";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  const { versionId } = await params;
  const renders = await listRenders(versionId);
  return NextResponse.json(
    renders.map((r) => ({
      provider: r.provider,
      device: r.device,
      capturedAt: r.capturedAt,
      url: `/api/renders/${versionId}/${path.basename(r.file)}`,
    }))
  );
}
