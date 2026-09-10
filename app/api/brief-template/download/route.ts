// GET : le classeur vierge à remplir, GÉNÉRÉ depuis la déclaration.
//
// Ce n'est délibérément pas le renvoi du .xlsm d'origine. Le fichier distribué
// et la page de doc doivent décrire le même objet : les faire sortir tous deux
// du template EFFECTIF rend l'écart impossible, alors que servir le classeur
// source laisserait les deux dériver l'un de l'autre sans que rien ne le dise.
//
// « Effectif » et non `DEFAULT_TEMPLATE` depuis que le template est éditable :
// continuer à générer depuis le code aurait distribué aux marques un vierge
// décrivant un référentiel qui n'est plus celui qui juge — et le défaut se
// serait vu non pas ici, mais dans des briefs remplis de bonne foi aux
// mauvaises cellules, un mois plus tard.
// Le test de boucle fermée (générer → reparser → comparer à la déclaration) ne
// garde que ce chemin-ci.
//
// Le .xlsm source vit dans lib/__tests__/fixtures/ et contient de vrais briefs
// client : il ne doit pas être servi par une route HTTP.
import { NextResponse } from "next/server";
import { buildTemplateWorkbook } from "@/lib/brief-template";
import { resolveTemplate } from "@/lib/template-resolve";

export const dynamic = "force-dynamic";
// exceljs est une dépendance Node : la route ne peut pas tourner sur Edge.
export const runtime = "nodejs";

export async function GET() {
  const { template: tpl } = await resolveTemplate();
  let buf: Buffer;
  try {
    buf = await buildTemplateWorkbook(tpl);
  } catch (err) {
    // Une génération qui échoue rend une ERREUR, jamais un classeur partiel :
    // un fichier tronqué s'ouvre parfois dans Excel et se remplit quand même.
    console.warn("[brief-template] génération du classeur vierge échouée :", err);
    return NextResponse.json({ error: "template generation failed" }, { status: 500 });
  }

  // Nom porteur de la version : deux vierges de versions différentes ne doivent
  // pas se ranger sous le même nom dans le dossier Téléchargements du métier.
  const filename = `kering-brief-template-${tpl.channel.toLowerCase()}-v${tpl.version}.xlsx`;
  return new NextResponse(buf as unknown as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
