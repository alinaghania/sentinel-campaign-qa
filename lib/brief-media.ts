// Extraction des images embarquées dans un brief Excel (xlsx/xlsm — même format zip,
// exceljs les lit de la même façon via workbook.xlsx.load).
// Les mockups BAL sont des PNG en portrait très allongé (~166x830) insérés
// dans la feuille BRIEF : on les remonte en tête de liste via une heuristique
// de ratio, mais on retourne TOUTES les images (le tri final reste humain).
// Cette fonction ne throw JAMAIS : toute erreur (fichier corrompu, image
// illisible, API exceljs manquante) produit au pire une liste vide.

import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { BriefMockup } from "./types";

export const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

/** Détection du format par magic bytes — l'extension déclarée dans le zip
 *  peut manquer ou mentir (ex: .png contenant du JPEG).
 *  Exporté pour la route d'upload manuel : elle doit trancher sur les MÊMES
 *  octets que l'extraction Excel, sinon deux chemins d'entrée acceptent deux
 *  ensembles de fichiers différents pour le même champ. */
export function sniffImageExtension(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined;
  // PNG : 89 50 4E 47 0D 0A 1A 0A
  if (buffer.readUInt32BE(0) === 0x89504e47) return "png";
  // JPEG : FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  // GIF : "GIF87a" / "GIF89a"
  if (buffer.toString("latin1", 0, 4) === "GIF8") return "gif";
  // BMP : "BM"
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "bmp";
  // WEBP : "RIFF"...."WEBP"
  if (
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

/** Dimensions lues directement dans les octets de l'image (PNG IHDR / JPEG SOFn / GIF / BMP). */
export function readImageDimensions(
  buffer: Buffer,
  extension: string
): { width: number; height: number } | undefined {
  try {
    const ext = extension.toLowerCase();
    if (ext === "png" && buffer.length >= 24) {
      // Signature PNG (8) + chunk IHDR : width/height en big-endian aux offsets 16/20
      if (buffer.readUInt32BE(0) === 0x89504e47) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      }
      return undefined;
    }
    if ((ext === "jpg" || ext === "jpeg") && buffer.length >= 4) {
      if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        // SOF0..SOF15 (hors DHT 0xc4, DAC 0xcc, RST...) portent les dimensions
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        if (segmentLength < 2) return undefined;
        offset += 2 + segmentLength;
      }
      return undefined;
    }
    if (ext === "gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (ext === "bmp" && buffer.length >= 26) {
      // BITMAPINFOHEADER : width int32 LE @18, height int32 LE @22 (signé, peut être négatif = top-down)
      return {
        width: Math.abs(buffer.readInt32LE(18)),
        height: Math.abs(buffer.readInt32LE(22)),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Heuristique mockup : image en portrait très allongé (ratio h/l > 1.5) et grande.
 *  Les vrais mockups BAL font ~166x830 (ratio ≈ 5). Heuristique incertaine :
 *  sert uniquement au TRI (mockups probables en tête), jamais à exclure une image. */
function isLikelyMockup(mockup: BriefMockup): boolean {
  if (!mockup.width || !mockup.height) return false;
  return mockup.height / mockup.width > 1.5 && mockup.height >= 400;
}

/** Buffer d'image (exceljs Media/Image) → BriefMockup, ou undefined si inutilisable. */
function toMockup(
  rawBuffer: unknown,
  declaredExtension: string | undefined,
  name: string | undefined,
  fallbackName: string
): BriefMockup | undefined {
  try {
    if (!rawBuffer) return undefined;
    // exceljs type ses buffers avec son propre alias `Buffer` ; à l'exécution
    // c'est un Buffer Node (ou un ArrayBuffer selon le chemin de lecture).
    const data = Buffer.isBuffer(rawBuffer)
      ? rawBuffer
      : Buffer.from(rawBuffer as unknown as Uint8Array);
    if (data.length === 0) return undefined;

    // Le format réel (magic bytes) prime sur l'extension déclarée dans le zip.
    const sniffed = sniffImageExtension(data);
    const declared = (declaredExtension || "").toLowerCase().replace(/^\./, "");
    const extension = sniffed ?? declared;
    const mimeType = MIME_BY_EXTENSION[extension];
    if (!mimeType) return undefined; // format non image (emf, wmf...) : ignoré

    const dims = readImageDimensions(data, extension);
    return {
      name: name || fallbackName,
      mimeType,
      dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
      source: "xlsx",
    };
  } catch {
    return undefined;
  }
}

/** Clé de dédup : hash du contenu (le même média peut apparaître via
 *  workbook.model.media ET via worksheet.getImages). */
function contentKey(dataUrl: string): string {
  return createHash("sha1").update(dataUrl).digest("hex");
}

/** Extrait toutes les images embarquées d'un fichier Excel (buffer xlsx/xlsm).
 *  Retourne [] si le fichier ne contient aucune image ou n'est pas lisible.
 *  Ne throw jamais. */
export async function extractXlsxImages(buffer: Buffer): Promise<BriefMockup[]> {
  try {
    const workbook = new ExcelJS.Workbook();
    try {
      // .xlsm = même conteneur OOXML que .xlsx : exceljs le lit tel quel.
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      return [];
    }

    const mockups: BriefMockup[] = [];
    const seen = new Set<string>();

    const push = (mockup: BriefMockup | undefined) => {
      if (!mockup) return;
      const key = contentKey(mockup.dataUrl);
      if (seen.has(key)) return;
      seen.add(key);
      mockups.push(mockup);
    };

    // Source principale : tous les médias du classeur (y compris images non ancrées).
    const media: ExcelJS.Media[] = workbook.model?.media ?? [];
    for (const item of media) {
      if (item.type !== "image") continue;
      push(toMockup(item.buffer, item.extension, item.name, `image-${mockups.length + 1}`));
    }

    // Filet de sécurité : images ancrées dans les feuilles (worksheet.getImages
    // + workbook.getImage). Dédupliquées par contenu avec la passe précédente.
    try {
      workbook.eachSheet((worksheet) => {
        let anchored: Array<{ type: "image"; imageId: string }> = [];
        try {
          anchored = worksheet.getImages();
        } catch {
          return; // feuille sans dessins / API indisponible : on passe
        }
        for (const placed of anchored) {
          try {
            const image = workbook.getImage(Number(placed.imageId));
            if (!image) continue;
            const raw =
              image.buffer ??
              (image.base64
                ? Buffer.from(image.base64.replace(/^data:[^;]+;base64,/, ""), "base64")
                : undefined);
            push(
              toMockup(raw, image.extension, image.filename, `image-${mockups.length + 1}`)
            );
          } catch {
            // image individuelle illisible : on continue avec les suivantes
          }
        }
      });
    } catch {
      // eachSheet peut échouer sur un classeur partiellement corrompu : les
      // images de workbook.model.media sont déjà collectées.
    }

    // Mockups probables en tête (les plus grands d'abord), ordre d'origine
    // préservé pour les autres images.
    const likely = mockups
      .filter(isLikelyMockup)
      .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
    const rest = mockups.filter((m) => !isLikelyMockup(m));
    return [...likely, ...rest];
  } catch {
    return [];
  }
}
