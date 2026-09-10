// POST multipart : un fichier (PDF/Excel/Word/PPT/texte) → texte + images extraits.
// Sert à préremplir un champ éditable (guidelines de marque) EN PRÉSERVANT la
// structure : les Excel deviennent des tableaux markdown, et les images/visuels
// embarqués sont renvoyés (data-URL) pour affichage/review.
import { NextRequest, NextResponse } from "next/server";
import { briefToMarkdown, extractFileText, xlsxToMarkdown } from "@/lib/brief";
import { extractXlsxImages } from "@/lib/brief-media";
import type { BriefMockup } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart attendu" }, { status: 400 });
  }
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "fichier manquant" }, { status: 400 });

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const lower = file.name.toLowerCase();
    const isXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls");

    // Excel → tableaux markdown (structure préservée) ; sinon texte brut nettoyé.
    const text = isXlsx
      ? (await xlsxToMarkdown(buf)).slice(0, 160_000)
      : briefToMarkdown(await extractFileText(file.name, buf));

    // Images/visuels embarqués (Excel) — renvoyés pour affichage dans la review.
    let images: BriefMockup[] = [];
    if (isXlsx) {
      try {
        images = await extractXlsxImages(buf);
      } catch {
        // pas d'images — non bloquant
      }
    }

    if (!text.trim() && images.length === 0) {
      return NextResponse.json({ error: "aucun contenu extrait" }, { status: 422 });
    }
    return NextResponse.json({ text, images });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "extraction échouée" },
      { status: 502 }
    );
  }
}
