// Le référentiel de brief D'UNE CAMPAGNE.
//
// Pourquoi une route de plus alors que /api/brief-template/[id] enregistre déjà
// des templates : parce que la question posée n'est pas la même. Là-bas, on
// édite un référentiel qu'on a choisi dans une liste, et on assume qu'il est
// partagé. Ici, on compose le référentiel d'une campagne pendant qu'on colle son
// brief, et l'effet sur les AUTRES campagnes ne doit pas dépendre de la
// vigilance de qui clique. La décision « éditer ou copier » est donc prise par
// le serveur, à partir de l'état réel du stockage, et jamais envoyée par le
// client — un client qui se tromperait de mode changerait ce contre quoi une
// campagne qu'il n'a pas ouverte est jugée.
//
// Toute la logique vit dans lib/template-resolve.ts, testable sans HTTP. Cette
// route ne fait que traduire son résultat en codes de statut.
import { NextRequest, NextResponse } from "next/server";
import { TemplateWriteSchema } from "@/lib/template-edit";
import { saveTemplateForCampaign } from "@/lib/template-resolve";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const parsed = TemplateWriteSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Some values are not valid.", details: parsed.error.issues.map((i) => i.message) },
      { status: 400 }
    );
  }

  const result = await saveTemplateForCampaign(id, parsed.data);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.problems ? { problems: result.problems } : {}),
        ...(result.currentVersion !== undefined ? { currentVersion: result.currentVersion } : {}),
      },
      { status: result.status }
    );
  }
  return NextResponse.json(result.saved, { status: result.saved.created ? 201 : 200 });
}
