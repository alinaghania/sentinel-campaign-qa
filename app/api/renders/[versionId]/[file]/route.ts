// GET : sert le PNG d'un rendu réel (screenshot Gmail/Outlook Web).
import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { renderDir } from "@/lib/render-real";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ versionId: string; file: string }> }
) {
  const { versionId, file } = await params;
  // versionId strictement contraint (pas de traversal via le segment dynamique).
  if (!/^[a-z0-9-]+$/i.test(versionId)) {
    return NextResponse.json({ error: "version invalide" }, { status: 400 });
  }
  // Nom de fichier strictement contraint (pas de traversal).
  if (!/^(gmail|outlook)(-desktop|-mobile(-\d{3})?)?\.png$/.test(file)) {
    return NextResponse.json({ error: "fichier invalide" }, { status: 400 });
  }
  try {
    const buf = await fs.readFile(path.join(renderDir(versionId), file));
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-cache" },
    });
  } catch {
    return NextResponse.json({ error: "render introuvable" }, { status: 404 });
  }
}
