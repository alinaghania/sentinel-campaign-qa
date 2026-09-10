// « Par défaut le template, c'est le DERNIER QUI A ÉTÉ CRÉÉ. »
//
// La phrase a l'air d'avoir une seule lecture. Elle en a deux, et le stockage
// ne connaissait que la mauvaise : jusqu'ici un template n'avait que
// `updatedAt`. Trier dessus répond « le dernier MODIFIÉ » — c'est-à-dire
// qu'ouvrir un vieux template pour corriger une faute de frappe le ferait
// devenir le référentiel par défaut de toutes les campagnes suivantes, sans que
// personne n'ait rien créé et sans qu'aucun écran ne le dise.
//
// Ces cas tournent sur le VRAI store dans un répertoire jetable. Un store mocké
// aurait testé le tri et rien d'autre ; ce qui se casse ici est la DONNÉE
// (`createdAt` posé ou non, repris ou non à l'édition), et elle ne se mesure que
// sur le chemin d'écriture réel.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_ID } from "../brief-template";
import type { StoredBriefTemplate } from "../brief-template";

let dir: string;
let prevDir: string | undefined;
let prevConn: string | undefined;

/** Charge store + résolveur APRÈS avoir posé DATA_DIR : `lib/store` lit la
 *  variable au chargement du module, donc un import statique en tête de fichier
 *  écrirait dans `.data` — le test passerait en polluant le dépôt. */
async function freshModules() {
  vi.resetModules();
  const store = await import("../store");
  const resolve = await import("../template-resolve");
  return { Templates: store.Templates, latestTemplateId: resolve.latestTemplateId };
}

/** Un template stocké minimal : la géométrie du livré, un id et des dates. */
function storedAt(id: string, createdAt: string | null, updatedAt: string): StoredBriefTemplate {
  return {
    ...DEFAULT_TEMPLATE,
    id,
    label: `Template ${id}`,
    updatedAt,
    ...(createdAt === null ? {} : { createdAt }),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinel-default-"));
  prevDir = process.env.DATA_DIR;
  prevConn = process.env.AZURE_TABLES_CONNECTION_STRING;
  process.env.DATA_DIR = dir;
  delete process.env.AZURE_TABLES_CONNECTION_STRING;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDir;
  if (prevConn !== undefined) process.env.AZURE_TABLES_CONNECTION_STRING = prevConn;
  rmSync(dir, { recursive: true, force: true });
});

describe("latestTemplateId — le défaut d'une nouvelle campagne", () => {
  it("rien de créé → le template LIVRÉ", async () => {
    const { latestTemplateId } = await freshModules();
    expect(await latestTemplateId()).toBe(DEFAULT_TEMPLATE_ID);
  });

  it("deux créés → le plus RÉCENT", async () => {
    const { Templates, latestTemplateId } = await freshModules();
    await Templates.put(storedAt("tpl-vieux", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"));
    await Templates.put(storedAt("tpl-neuf", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"));
    expect(await latestTemplateId()).toBe("tpl-neuf");
  });

  it("MODIFIER le plus ancien ne le rend pas défaut — c'est la création qui compte", async () => {
    // Le défaut que ce fichier existe pour empêcher. Le vieux template est
    // rouvert et réenregistré aujourd'hui : son `updatedAt` dépasse celui du
    // neuf, sa date de CRÉATION non.
    const { Templates, latestTemplateId } = await freshModules();
    await Templates.put(storedAt("tpl-vieux", "2026-01-01T00:00:00.000Z", "2026-09-04T12:00:00.000Z"));
    await Templates.put(storedAt("tpl-neuf", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"));
    expect(await latestTemplateId()).toBe("tpl-neuf");
  });

  it("l'ÉDITION du template livré ne remporte jamais le défaut", async () => {
    // `default` est le REPLI, pas une création : c'est l'édition du template du
    // code. S'il pouvait gagner, corriger un libellé du livré déplacerait le
    // référentiel de toutes les campagnes à venir.
    const { Templates, latestTemplateId } = await freshModules();
    await Templates.put(storedAt("tpl-neuf", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"));
    await Templates.put(storedAt(DEFAULT_TEMPLATE_ID, "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"));
    expect(await latestTemplateId()).toBe("tpl-neuf");
  });

  it("un template SANS date de création compte comme le plus ancien, jamais comme neuf", async () => {
    // Troisième état : « je ne sais pas quand il est né » n'est pas
    // « il est né maintenant ». Se tromper vers l'ancien laisse le défaut où il
    // est ; se tromper vers le récent déplacerait la mesure de tout le monde.
    const { Templates, latestTemplateId } = await freshModules();
    await Templates.put(storedAt("tpl-sans-date", null, "2026-09-04T23:00:00.000Z"));
    await Templates.put(storedAt("tpl-date", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"));
    expect(await latestTemplateId()).toBe("tpl-date");
  });

  it("ex æquo à la milliseconde → départage DÉTERMINISTE par id", async () => {
    // Sans départage, le défaut dépendrait de l'ordre de listage du système de
    // fichiers. Un mauvais défaut se corrige ; un défaut non reproductible ne
    // se diagnostique pas.
    const { Templates, latestTemplateId } = await freshModules();
    const t = "2026-06-01T00:00:00.000Z";
    await Templates.put(storedAt("tpl-aaa", t, t));
    await Templates.put(storedAt("tpl-zzz", t, t));
    const runs = [await latestTemplateId(), await latestTemplateId(), await latestTemplateId()];
    expect(new Set(runs).size, "trois appels, trois réponses possibles").toBe(1);
    expect(runs[0]).toBe("tpl-zzz");
  });
});

describe("buildStoredTemplate — la date de création survit à l'édition", () => {
  it("réenregistrer un template garde sa date de CRÉATION et bouge sa date de modification", async () => {
    const { buildStoredTemplate } = await import("../template-edit");
    const write = {
      label: "T",
      channel: DEFAULT_TEMPLATE.channel,
      headerRow: DEFAULT_TEMPLATE.headerRow,
      fieldCol: DEFAULT_TEMPLATE.fieldCol,
      descCol: DEFAULT_TEMPLATE.descCol,
      valueCol: DEFAULT_TEMPLATE.valueCol,
      firstLangCol: DEFAULT_TEMPLATE.firstLangCol,
      languageColumns: [...DEFAULT_TEMPLATE.languageColumns],
      languages: DEFAULT_TEMPLATE.languages.map((l) => ({ code: l.code, name: l.name })),
      fields: DEFAULT_TEMPLATE.fields.map((f) => ({ ...f, aliases: [...(f.aliases ?? [])] })),
    };

    const cree = buildStoredTemplate("tpl-x", write, null);
    expect(cree.createdAt, "une création doit dater").toBeTruthy();

    const edite = buildStoredTemplate("tpl-x", { ...write, label: "T bis" }, cree);
    expect(edite.createdAt, "une édition n'est pas une naissance").toBe(cree.createdAt);
    expect(edite.version).toBe(cree.version + 1);
  });

  it("l'édition du template LIVRÉ ne reçoit pas de date de création", async () => {
    const { buildStoredTemplate } = await import("../template-edit");
    const write = {
      label: "Kering EMAIL brief",
      channel: DEFAULT_TEMPLATE.channel,
      headerRow: DEFAULT_TEMPLATE.headerRow,
      fieldCol: DEFAULT_TEMPLATE.fieldCol,
      descCol: DEFAULT_TEMPLATE.descCol,
      valueCol: DEFAULT_TEMPLATE.valueCol,
      firstLangCol: DEFAULT_TEMPLATE.firstLangCol,
      languageColumns: [...DEFAULT_TEMPLATE.languageColumns],
      languages: DEFAULT_TEMPLATE.languages.map((l) => ({ code: l.code, name: l.name })),
      fields: DEFAULT_TEMPLATE.fields.map((f) => ({ ...f, aliases: [...(f.aliases ?? [])] })),
    };
    expect(buildStoredTemplate(DEFAULT_TEMPLATE_ID, write, null).createdAt).toBeUndefined();
  });
});
