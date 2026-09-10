// POST multipart : upload MANUEL d'un mockup (image PJ) → ajouté à campaign.briefMockups.
// Complète l'extraction auto depuis l'Excel (quand le mockup n'est pas dans le fichier).
//
// Les mockups sont stockés en base64 DANS le document campagne, relu et réécrit
// entier à chaque analyse : ce qui entre ici pèse sur toutes les lectures
// suivantes. D'où trois bornes explicites plutôt qu'aucune.
import { NextRequest, NextResponse } from "next/server";
import { updateCampaign, Campaigns } from "@/lib/store";
import { MIME_BY_EXTENSION, sniffImageExtension, readImageDimensions } from "@/lib/brief-media";
import type { BriefMockup } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Taille d'UN fichier, après décodage. Choisie STRICTEMENT sous le seuil de
 *  `proxyClientMaxBodySize` de Next (10 Mo par défaut, et `proxy.ts` existe dans
 *  ce dépôt donc la limite s'applique) : au-delà de ce seuil, Next ne rejette
 *  pas la requête — il bufferise partiellement, journalise un avertissement et
 *  laisse passer. Un corps tronqué arriverait ici comme une image valide mais
 *  amputée. La borne basse garantit qu'aucun corps tronqué ne peut être stocké. */
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
/** Nombre de mockups par campagne. Le brief Balenciaga en compte 2 à 3 ; 12
 *  laisse la marge d'un brief multi-marchés sans permettre un dépôt de fichiers. */
const MAX_MOCKUPS_PER_CAMPAIGN = 12;
/** Poids cumulé des mockups d'une campagne, décodé. */
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** Poids décodé d'une dataUrl base64, sans la décoder (la longueur suffit). */
function decodedBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** Taille lisible, ARRONDIE AU-DESSUS et à deux décimales.
 *  MESURÉ sur le déployé le 04/09/2026 : à une décimale et arrondi au plus
 *  proche, un fichier de 4 Mio + 1 octet produisait « image trop lourde
 *  (4.0 Mo) — maximum 4.0 Mo », c'est-à-dire un refus qui affiche deux nombres
 *  ÉGAUX. Un message de borne doit rendre le dépassement visible : arrondir
 *  vers le haut garantit que la valeur refusée s'affiche toujours strictement
 *  au-dessus du plafond. « Mio » et non « Mo » : le calcul est en base 1024. */
const humanMB = (bytes: number) =>
  `${(Math.ceil((bytes / (1024 * 1024)) * 100) / 100).toFixed(2)} Mio`;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  if (!campaign) return NextResponse.json({ error: "introuvable" }, { status: 404 });

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data"))
    return NextResponse.json({ error: "multipart attendu" }, { status: 400 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "fichier manquant" }, { status: 400 });

  // Le type déclaré a TROIS états, pas deux — et l'état "absent" ne ressemble
  // pas à ce qu'on croit. MESURÉ (lib/__tests__/mockup-upload.test.ts) : un
  // File sans `type` traverse le multipart en "application/octet-stream", pas
  // en chaîne vide. Une garde écrite contre `""` n'aurait jamais été atteinte.
  //
  // Ces deux états ne sont pas une déclaration : on ne les remplace donc par
  // AUCUNE étiquette (l'ancien `|| "image/png"` en inventait une, et c'est
  // cette étiquette que l'agent vision lit ensuite). On laisse les octets
  // trancher, quelques lignes plus bas. En revanche un type déclaré et
  // franchement non-image dit que l'utilisateur s'est trompé de fichier :
  // le lui dire tout de suite vaut mieux qu'un "format non reconnu".
  const declared = (file.type || "").toLowerCase().split(";")[0].trim();
  const undeclared = declared === "" || declared === "application/octet-stream";
  if (!undeclared && !declared.startsWith("image/"))
    return NextResponse.json({ error: "une image est attendue (PNG/JPG)" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0)
    return NextResponse.json({ error: "fichier vide" }, { status: 400 });
  if (buf.length > MAX_BYTES_PER_FILE)
    return NextResponse.json(
      { error: `image trop lourde (${humanMB(buf.length)}) — maximum ${humanMB(MAX_BYTES_PER_FILE)}` },
      { status: 413 }
    );

  // Les octets priment sur le type déclaré : un .png contenant du HTML ou du
  // PDF passe la vérification d'en-tête et échoue plus tard, chez l'agent
  // vision, sous une forme qui ne désigne plus l'upload.
  const extension = sniffImageExtension(buf);
  const mimeType = extension ? MIME_BY_EXTENSION[extension] : undefined;
  if (!mimeType)
    return NextResponse.json(
      { error: "format d'image non reconnu — PNG, JPEG, GIF, BMP ou WEBP attendus" },
      { status: 400 }
    );

  const dims = readImageDimensions(buf, extension!);
  const mockup: BriefMockup = {
    name: file.name,
    mimeType,
    dataUrl: `data:${mimeType};base64,${buf.toString("base64")}`,
    ...(dims ? { width: dims.width, height: dims.height } : {}),
    source: "upload",
  };

  // `updateCampaign` et non `Campaigns.put` : l'écriture est sérialisée par id,
  // et surtout elle repart du document courant. Un put depuis le snapshot lu en
  // haut de la route effacerait les versions ou rapports écrits entre-temps —
  // une analyse dure plusieurs minutes, l'upload d'un mockup quelques secondes.
  //
  // Les deux bornes de COLLECTION sont vérifiées ICI, dans le mutateur, et pas
  // sur le snapshot du haut : ce sont des bornes sur un état partagé, et deux
  // uploads simultanés les franchiraient tous les deux si chacun comptait sur
  // sa propre lecture. Le refus remonte par `rejected`, le mutateur ne pouvant
  // pas répondre en HTTP.
  let rejected: { status: number; error: string } | null = null;
  const updated = await updateCampaign(id, (c) => {
    const existing = c.briefMockups ?? [];
    if (existing.length >= MAX_MOCKUPS_PER_CAMPAIGN) {
      rejected = {
        status: 409,
        error: `maximum ${MAX_MOCKUPS_PER_CAMPAIGN} mockups par campagne — supprime-en un avant d'en ajouter`,
      };
      return;
    }
    const totalAfter = existing.reduce((n, m) => n + decodedBytes(m.dataUrl), 0) + buf.length;
    if (totalAfter > MAX_TOTAL_BYTES) {
      rejected = {
        status: 413,
        error: `poids total des mockups dépassé (${humanMB(totalAfter)}) — maximum ${humanMB(MAX_TOTAL_BYTES)} par campagne`,
      };
      return;
    }
    c.briefMockups = [...existing, mockup];
  });
  if (rejected)
    return NextResponse.json(
      { error: (rejected as { error: string }).error },
      { status: (rejected as { status: number }).status }
    );
  return NextResponse.json({ campaign: updated ?? campaign });
}
