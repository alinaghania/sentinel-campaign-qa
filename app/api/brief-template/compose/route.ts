// POST : un tableau collé par le métier → un classeur Kering conforme au
// template, renvoyé en .xlsx.
//
// C'est l'étape 2 du wizard « + New campaign ». Le client ne poste PAS ce
// contenu comme brief : il récupère le classeur et le renvoie à
// /api/campaigns/[id]/brief comme n'importe quel fichier Excel. Un second
// chemin d'import aurait sa propre grille, sa propre télémétrie et sa propre
// façon d'échouer ; ici le brief composé traverse exactement le parseur de
// production, donc il reçoit la même famille et les mêmes contrôles.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildTemplateWorkbook, type TemplateFill } from "@/lib/brief-template";
import { Campaigns } from "@/lib/store";
import { resolveTemplate } from "@/lib/template-resolve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Borne de taille : le corps vient d'un copier-coller depuis Excel, donc d'une
// source non maîtrisée. 200 000 caractères par cellule est déjà bien au-delà de
// tout brief réel (le plus gros du dépôt tient en ~290 Ko de classeur entier).
const MAX_CELL = 200_000;
/** Poids du CORPS, refusé avant d'être lu. `MAX_CELL` borne une cellule et ne
 *  borne rien d'autre : un corps de 120 champs × 41 colonnes × 200 000
 *  caractères respecte chaque borne individuelle et pèse ~2 Go, matérialisés au
 *  moins quatre fois (le JSON, l'objet zod, les cellules exceljs, le buffer de
 *  sortie). Sentinel tourne en réplique UNIQUE : cet OOM-là n'est pas une
 *  requête qui échoue, c'est la plateforme qui n'est plus là.
 *
 *  4 Mio, comme les mockups, et pour la même raison : STRICTEMENT sous les
 *  10 Mo de `proxyClientMaxBodySize`, au-delà desquels Next ne refuse pas — il
 *  bufferise partiellement, journalise un avertissement et laisse passer un
 *  corps TRONQUÉ. Ici la troncature ferait échouer `JSON.parse`, donc un 400 au
 *  lieu d'un 413 : un refus juste avec un motif faux. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Nombre de LIGNES et de COLONNES acceptées. Le plus gros template réel en
 *  déclare 33 et 11 ; ces bornes laissent une marge d'un ordre de grandeur sans
 *  laisser composer une feuille de calcul arbitraire. Vérifiées APRÈS parse
 *  parce qu'elles portent sur une structure, pas sur des octets — la borne
 *  d'octets ci-dessus est celle qui protège la mémoire. */
const MAX_FILL_ROWS = 400;
const MAX_FILL_COLS = 80;

const Body = z.object({
  /** { clé de champ → { code de colonne de langue → texte } }. La clé "" vise
   *  la colonne VALUE (contenu master, non traduit). */
  fill: z.record(z.string(), z.record(z.string(), z.string().max(MAX_CELL))),
  fileName: z.string().max(200).optional(),
  /** Campagne pour laquelle on compose. Décide du template : une campagne est
   *  épinglée à son référentiel, et composer contre un AUTRE produirait un
   *  classeur dont les cellules ne tombent pas là où le juge les lira.
   *  Absente = le repli, pour les appels qui n'ont pas de campagne en main. */
  campaignId: z.string().max(80).optional(),
});

export async function POST(req: NextRequest) {
  // Refus AVANT lecture : `req.json()` matérialise tout le corps. Un
  // Content-Length absent (chunked) ne passe pas à travers — le corps reste
  // borné par `proxyClientMaxBodySize`, et sa troncature fait échouer le parse.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return NextResponse.json(
      { error: "pasted brief too large", maxBytes: MAX_BODY_BYTES },
      { status: 413 }
    );

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const rowCount = Object.keys(parsed.fill).length;
  const colCount = new Set(Object.values(parsed.fill).flatMap((r) => Object.keys(r))).size;
  if (rowCount > MAX_FILL_ROWS || colCount > MAX_FILL_COLS)
    return NextResponse.json(
      { error: "pasted brief too large", rows: rowCount, columns: colCount },
      { status: 413 }
    );

  // Template EFFECTIF de la CAMPAGNE, comme la page de doc et le vierge
  // téléchargeable : le wizard écrit dans les cellules que ces deux-là
  // annoncent. Trois sources différentes ici et le classeur composé porterait
  // les valeurs ailleurs que là où la doc a dit de les lire.
  const campaign = parsed.campaignId ? await Campaigns.get(parsed.campaignId) : null;
  const { template: tpl } = await resolveTemplate(campaign?.templateId ?? undefined);
  const knownFields = new Set(tpl.fields.map((f) => f.key));
  const knownCols = new Set<string>(["", ...tpl.languageColumns]);

  // Les clés inconnues sont REFUSÉES, pas ignorées. Les ignorer ferait renvoyer
  // un classeur qui a l'air complet en ayant perdu une colonne en silence —
  // exactement la panne qu'on passe la journée à corriger ailleurs.
  const unknownFields = Object.keys(parsed.fill).filter((k) => !knownFields.has(k));
  const unknownCols = [
    ...new Set(Object.values(parsed.fill).flatMap((row) => Object.keys(row))),
  ].filter((c) => !knownCols.has(c));
  if (unknownFields.length > 0 || unknownCols.length > 0) {
    return NextResponse.json(
      {
        error: "unknown template keys",
        unknownFields,
        unknownColumns: unknownCols,
        templateVersion: tpl.version,
      },
      { status: 400 }
    );
  }

  let buf: Buffer;
  try {
    buf = await buildTemplateWorkbook(tpl, parsed.fill as TemplateFill);
  } catch (err) {
    console.warn("[brief-template] composition du classeur échouée :", err);
    return NextResponse.json({ error: "workbook composition failed" }, { status: 500 });
  }

  // Nom de fichier assaini : il est repris tel quel dans `briefFileName` et
  // s'affiche à l'écran. Le point et les séparateurs de chemin sortent.
  const safe = (parsed.fileName ?? "pasted-brief").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 80).trim();
  const filename = `${safe || "pasted-brief"}.xlsx`;
  return new NextResponse(buf as unknown as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
