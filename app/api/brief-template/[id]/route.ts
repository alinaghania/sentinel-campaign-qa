// Un template en particulier : le lire, l'enregistrer, revenir en arrière.
//
// PUT est verrouillé sur la VERSION lue par le client (409 en cas de décalage),
// comme /api/rules : l'accès à la plateforme est partagé sous un seul mot de
// passe, deux onglets ouverts sur le même écran sont la situation normale et
// non le cas tordu. Sans ce verrou, le second enregistrement écrase le premier
// sans que personne ne l'apprenne.
import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_ID, templateRevision } from "@/lib/brief-template";
import { Templates, updateTemplate } from "@/lib/store";
import {
  TemplateWriteSchema,
  buildStoredTemplate,
  checkTemplateCoherence,
  isBlocking,
  withAcknowledgedRemovals,
} from "@/lib/template-edit";
import { templatePayload } from "@/lib/template-resolve";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await templatePayload(id));
}

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
  const body = parsed.data;

  // Lecture → contrôle → écriture enfermés dans la chaîne sérialisée : le
  // verrou de version ne protège PAS de deux requêtes qui lisent la même
  // version au même instant, elles passeraient toutes les deux (cf. le
  // commentaire d'updateSettings dans lib/store.ts).
  return updateTemplate(id, async (prev) => {
    // Éditer le template LIVRÉ pour la première fois : il n'y a rien en base,
    // et pourtant il y a bien un état antérieur — celui du code. Le traiter
    // comme une création ferait sauter le contrôle de renommage de clé
    // exactement là où il est le plus utile, à la première édition.
    const base = prev ?? (id === DEFAULT_TEMPLATE_ID ? DEFAULT_TEMPLATE : null);
    if (!base) {
      return NextResponse.json({ error: `No template "${id}".` }, { status: 404 });
    }
    if (body.baseVersion !== undefined && body.baseVersion !== base.version) {
      return NextResponse.json(
        {
          error: `Someone else saved this template while you were editing (you started from v${body.baseVersion}, it is now v${base.version}). Reload to see their changes.`,
          currentVersion: base.version,
        },
        { status: 409 }
      );
    }

    // Les clés dont la suppression est ASSUMÉE sont retirées de l'état
    // antérieur avant le contrôle 9 — pas du contrôle. Une clé qui disparaît
    // sans être nommée bloque toujours ; c'est la disparition non voulue qu'on
    // veut voir, et elle ne se distingue de l'autre que par cette liste.
    const check = checkTemplateCoherence(
      body,
      withAcknowledgedRemovals(base, body.removedFieldKeys)
    );
    if (isBlocking(check)) {
      return NextResponse.json(
        { error: "This template cannot measure anything yet.", problems: check.problems },
        { status: 400 }
      );
    }

    const tpl = buildStoredTemplate(id, body, prev);
    await Templates.put(tpl);
    // On archive la révision SORTANTE aussi, et pas seulement la nouvelle :
    // c'est elle que citent les rapports déjà rendus, et c'est donc elle qui
    // deviendrait illisible. Archiver seulement l'entrante protégerait l'avenir
    // en laissant le passé se refermer — le contraire du but.
    await Templates.archive(base, id);
    await Templates.archive(tpl, id);
    return NextResponse.json({
      id,
      version: tpl.version,
      revision: templateRevision(tpl),
      previousRevision: templateRevision(base),
      warnings: check.problems,
    });
  });
}

/** Supprime l'ÉDITION, pas le référentiel.
 *
 *  Sur `default`, l'entrée stockée disparaît et le template du code redevient
 *  effectif : c'est un « revenir en arrière », pas une destruction, et c'est la
 *  seule sortie de secours quand une édition rend l'écran inutilisable.
 *  L'archive des révisions n'est PAS touchée — un rapport de juillet doit rester
 *  lisible après que son template a été supprimé, sinon supprimer un template
 *  effacerait rétroactivement le sens de tout ce qu'il a jugé. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = await Templates.get(id);
  if (!existing) return NextResponse.json({ error: `No template "${id}".` }, { status: 404 });
  await Templates.del(id);
  return NextResponse.json({
    id,
    restoredToCode: id === DEFAULT_TEMPLATE_ID,
    revision: templateRevision(id === DEFAULT_TEMPLATE_ID ? DEFAULT_TEMPLATE : existing),
  });
}
