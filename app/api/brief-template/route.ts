// GET : le référentiel de brief, sous la forme que consomment la page de doc et
// le wizard « + New campaign ». Rend les ADRESSES A1 calculées par layout(),
// jamais des numéros de ligne écrits à la main : la page qui dit au métier « le
// sujet va en C7 » et le fichier qu'il télécharge sortent du même calcul.
//
// POST : crée un NOUVEAU template.
//
// Le commentaire qui vivait ici disait « aucune écriture […] rendre le template
// éditable par HTTP demanderait un versionnement et une invalidation de cache de
// rapports qui n'existent pas encore ». C'était vrai et ça ne l'est plus : la
// condition qu'il posait a été remplie avant d'ouvrir l'écriture, pas après.
// `templateRevision()` est une empreinte DÉRIVÉE de la déclaration, le sel de
// cache de lib/analyze.ts la consomme, et chaque rapport enregistre la révision
// qui l'a jugé. La phrase est remplacée plutôt que raturée : laissée en place,
// elle aurait décrit une interdiction qui ne protège plus rien et aurait fait
// croire au prochain lecteur que le verrou tient encore.
import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_TEMPLATE_ID, templateRevision } from "@/lib/brief-template";
import { Templates, uid } from "@/lib/store";
import {
  TemplateWriteSchema,
  buildStoredTemplate,
  checkTemplateCoherence,
  isBlocking,
} from "@/lib/template-edit";
import { templatePayload } from "@/lib/template-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") || DEFAULT_TEMPLATE_ID;
  const stored = await Templates.list();
  // La liste inclut TOUJOURS le template livré, même quand rien n'est
  // enregistré sous son id : sans ça, l'écran s'ouvrirait sur une liste vide
  // alors qu'un référentiel est bel et bien en train de juger.
  const known = [
    ...(stored.some((t) => t.id === DEFAULT_TEMPLATE_ID)
      ? []
      : [{ id: DEFAULT_TEMPLATE_ID, label: "Kering EMAIL brief", editedYet: false }]),
    ...stored.map((t) => ({ id: t.id, label: t.label, editedYet: true })),
  ];
  return NextResponse.json({ ...(await templatePayload(id)), templates: known });
}

export async function POST(req: NextRequest) {
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

  // Contrôles de COHÉRENCE côté serveur, et pas seulement dans l'écran : un
  // contrôle qui ne vit que dans la page se contourne par un appel direct, et
  // ce qu'il laisserait passer ici n'est pas une faute de frappe — c'est un
  // instrument de mesure faussé qui rendra des verdicts d'allure normale.
  //
  // Pas de `prev` : une création n'a pas d'histoire, donc pas de clé à renommer.
  const check = checkTemplateCoherence(parsed.data, null);
  if (isBlocking(check)) {
    return NextResponse.json(
      { error: "This template cannot measure anything yet.", problems: check.problems },
      { status: 400 }
    );
  }

  const id = `tpl-${uid()}`;
  const tpl = buildStoredTemplate(id, parsed.data, null);
  await Templates.put(tpl);
  // Archivée APRÈS l'écriture : archiver d'abord laisserait, en cas d'échec du
  // put, une révision citable qui n'a jamais rien jugé.
  await Templates.archive(tpl, id);
  return NextResponse.json(
    { id, version: tpl.version, revision: templateRevision(tpl), warnings: check.problems },
    { status: 201 }
  );
}
