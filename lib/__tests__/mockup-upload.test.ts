// Bornes d'upload des mockups — testées SUR LA ROUTE, pas sur une copie de sa
// logique. Une borne recopiée dans un test ne teste que la copie : c'est la
// route qui décide, c'est elle qu'on appelle.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign } from "../types";

// Store en mémoire : le vrai `lib/store` écrit sur disque (FileStore) et n'a
// rien à faire dans un test de validation d'entrée.
const db = new Map<string, Campaign>();

vi.mock("@/lib/store", () => ({
  Campaigns: {
    get: async (id: string) => db.get(id) ?? null,
    put: async (c: Campaign) => {
      db.set(c.id, c);
    },
  },
  updateCampaign: async (id: string, mutate: (c: Campaign) => void | Promise<void>) => {
    const c = db.get(id);
    if (!c) return null;
    await mutate(c);
    c.updatedAt = new Date().toISOString();
    db.set(id, c);
    return c;
  },
}));

const { POST } = await import("../../app/api/campaigns/[id]/mockup/route");

const CAMPAIGN_ID = "camp-1";

/** PNG minimal VALIDE en magic bytes, de la taille demandée. */
function pngOf(bytes: number): Buffer {
  const buf = Buffer.alloc(Math.max(12, bytes), 0x00);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  return buf;
}

function post(file: File | null): Promise<Response> {
  const form = new FormData();
  if (file) form.append("file", file);
  const req = new Request(`http://localhost/api/campaigns/${CAMPAIGN_ID}/mockup`, {
    method: "POST",
    body: form,
  });
  // La route ne lit de `NextRequest` que `headers` et `formData()` : un Request
  // standard suffit, et évite d'avoir à construire un contexte Next complet.
  return POST(req as never, { params: Promise.resolve({ id: CAMPAIGN_ID }) });
}

/** Un File dont `type` est exactement ce qu'on veut tester (y compris ""). */
function fileOf(data: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(data)], name, ...(type ? [{ type }] : []));
}

beforeEach(() => {
  db.clear();
  db.set(CAMPAIGN_ID, {
    id: CAMPAIGN_ID,
    name: "test",
    period: "2026-09",
    status: "BRIEF_RECU",
    versions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Campaign);
});

describe("upload de mockup — bornes", () => {
  it("accepte un PNG normal et stocke ses dimensions", async () => {
    // PNG 1×1 réel : signature + IHDR renseigné, pour que les dimensions soient lisibles.
    const png = pngOf(64);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const res = await post(fileOf(png, "mockup.png", "image/png"));
    expect(res.status).toBe(200);
    const mockups = db.get(CAMPAIGN_ID)!.briefMockups!;
    expect(mockups).toHaveLength(1);
    expect(mockups[0].mimeType).toBe("image/png");
    expect(mockups[0].source).toBe("upload");
    expect(mockups[0].width).toBe(1);
  });

  it("sans type déclaré, ce sont les OCTETS qui étiquettent — jamais un défaut", async () => {
    // Le défaut corrigé : `file.type || "image/png"` collait une étiquette PNG
    // sur des octets dont personne n'avait rien dit. Ici le fichier est un JPEG
    // envoyé sans type : le mime stocké doit être image/jpeg, pas image/png.
    const jpeg = Buffer.alloc(64, 0);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(jpeg, 0);
    const res = await post(fileOf(jpeg, "mockup", ""));
    expect(res.status).toBe(200);
    expect(db.get(CAMPAIGN_ID)!.briefMockups![0].mimeType).toBe("image/jpeg");
  });

  it("un type déclaré MENTEUR ne l'emporte pas sur les octets", async () => {
    // Déclaré PNG, réellement GIF : c'est le GIF qui doit être enregistré.
    const gif = Buffer.alloc(64, 0);
    Buffer.from("GIF89a").copy(gif, 0);
    const res = await post(fileOf(gif, "menteur.png", "image/png"));
    expect(res.status).toBe(200);
    expect(db.get(CAMPAIGN_ID)!.briefMockups![0].mimeType).toBe("image/gif");
  });

  it("refuse un type déclaré non-image", async () => {
    const res = await post(fileOf(pngOf(64), "brief.pdf", "application/pdf"));
    expect(res.status).toBe(400);
  });

  it("refuse des octets qui ne sont pas une image, même déclarés image/png", async () => {
    const res = await post(fileOf(Buffer.from("<html>pas une image</html>"), "x.png", "image/png"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/format d'image non reconnu/);
  });

  it("refuse un fichier au-dessus de 4 Mio (413), sous le seuil de troncature de Next", async () => {
    const res = await post(fileOf(pngOf(4 * 1024 * 1024 + 1), "gros.png", "image/png"));
    expect(res.status).toBe(413);
    expect(db.get(CAMPAIGN_ID)!.briefMockups ?? []).toHaveLength(0);

    // Le message doit RENDRE VISIBLE le dépassement. Constaté sur le déployé
    // le 04/09/2026 : arrondi à une décimale, un octet de trop s'affichait
    // « (4.0 Mo) — maximum 4.0 Mo », deux nombres égaux pour justifier un refus.
    const { error } = (await res.json()) as { error: string };
    const [observed, limit] = [...error.matchAll(/(\d+\.\d+) Mio/g)].map((m) => Number(m[1]));
    expect(observed, error).toBeGreaterThan(limit);
  });

  it("refuse le 13e mockup (409) sans toucher aux 12 premiers", async () => {
    for (let i = 0; i < 12; i++) {
      const res = await post(fileOf(pngOf(64), `m${i}.png`, "image/png"));
      expect(res.status, `upload ${i}`).toBe(200);
    }
    const res = await post(fileOf(pngOf(64), "m12.png", "image/png"));
    expect(res.status).toBe(409);
    expect(db.get(CAMPAIGN_ID)!.briefMockups).toHaveLength(12);
  });

  it("refuse le dépassement du poids CUMULÉ (413) avant le plafond de nombre", async () => {
    // 4 × 4 Mio = 16 Mio pile (accepté), le 5e dépasse — et on est encore
    // loin des 12 mockups : les deux bornes sont bien indépendantes.
    for (let i = 0; i < 4; i++) {
      const res = await post(fileOf(pngOf(4 * 1024 * 1024), `m${i}.png`, "image/png"));
      expect(res.status, `upload ${i}`).toBe(200);
    }
    const res = await post(fileOf(pngOf(1024), "trop.png", "image/png"));
    expect(res.status).toBe(413);
    expect(db.get(CAMPAIGN_ID)!.briefMockups).toHaveLength(4);
  });

  it("refuse un fichier vide", async () => {
    const res = await post(fileOf(Buffer.alloc(0), "vide.png", "image/png"));
    expect(res.status).toBe(400);
  });

  it("404 sur une campagne inconnue", async () => {
    db.clear();
    const res = await post(fileOf(pngOf(64), "m.png", "image/png"));
    expect(res.status).toBe(404);
  });
});
