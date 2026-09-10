// « Pour chaque campagne tu crées le template. »
//
// La phrase déplace l'édition du référentiel dans l'écran de la campagne, et
// elle ouvre au passage une question que l'écran d'administration n'avait pas :
// DEUX campagnes peuvent être épinglées sur le même template. Ajouter une
// colonne depuis la campagne A changerait alors ce contre quoi la campagne B est
// jugée — sans que personne n'ouvre B, sans qu'aucun écran ne le dise. Ses
// rapports déjà rendus ne deviendraient pas faux : ils deviendraient
// ININTERPRÉTABLES, ce qui se remarque bien plus tard.
//
// Ce que ces cas mesurent n'est donc pas « la sauvegarde a marché » — ça se voit
// à l'œil. C'est l'INVARIANT SUR LE VOISIN : après un enregistrement depuis A,
// la révision qui juge B est-elle exactement celle d'avant ? Cette question se
// pose sur l'AUTRE campagne, jamais sur celle qu'on vient d'éditer, et c'est
// pour ça qu'elle ne se vérifie pas à l'écran.
//
// Les cas tournent sur le VRAI store dans un répertoire jetable : ce qui se
// casse ici est le chemin d'écriture (copie ou pas, épinglage, archivage), pas
// une pure fonction.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_ID, templateRevision } from "../brief-template";
import type { Campaign } from "../types";
import type { TemplateWrite } from "../template-edit";

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
  return {
    Campaigns: store.Campaigns,
    Templates: store.Templates,
    campaignTemplateOwnership: resolve.campaignTemplateOwnership,
    saveTemplateForCampaign: resolve.saveTemplateForCampaign,
    resolveTemplate: resolve.resolveTemplate,
  };
}

function campaign(id: string, templateId?: string): Campaign {
  return {
    id,
    name: `Campagne ${id}`,
    period: "2026-T3",
    status: "BRIEF_RECU",
    versions: [],
    ...(templateId === undefined ? {} : { templateId }),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  } as Campaign;
}

/** Une requête d'écriture VALIDE, dérivée du template livré. On part du livré
 *  et non d'une déclaration écrite à la main : une déclaration inventée ne
 *  déclencherait pas les mêmes contrôles que ce que l'écran envoie réellement. */
function write(patch: Partial<TemplateWrite> = {}): TemplateWrite {
  return {
    label: DEFAULT_TEMPLATE.label,
    channel: DEFAULT_TEMPLATE.channel,
    headerRow: DEFAULT_TEMPLATE.headerRow,
    fieldCol: DEFAULT_TEMPLATE.fieldCol,
    descCol: DEFAULT_TEMPLATE.descCol,
    valueCol: DEFAULT_TEMPLATE.valueCol,
    firstLangCol: DEFAULT_TEMPLATE.firstLangCol,
    languageColumns: [...DEFAULT_TEMPLATE.languageColumns],
    languages: DEFAULT_TEMPLATE.languages.map((l) => ({ ...l })),
    fields: DEFAULT_TEMPLATE.fields.map((f) => ({ ...f })),
    ...patch,
  } as TemplateWrite;
}

/** Les champs du template livré sont `readonly` — c'est voulu : personne ne doit
 *  muter le référentiel du code en place. Une requête d'écriture, elle, est une
 *  structure neuve et mutable. Ce clone est la frontière entre les deux, et il
 *  recopie `aliases` au lieu de partager le tableau : un `[...f]` de surface
 *  laisserait le test écrire dans le livré par le tableau d'alias. */
function champs(source: readonly (typeof DEFAULT_TEMPLATE.fields)[number][]) {
  return source.map((f) => ({
    ...f,
    aliases: f.aliases ? [...f.aliases] : undefined,
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinel-camptpl-"));
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

describe("campaignTemplateOwnership — ce qu'un enregistrement FERA", () => {
  it("une campagne sur le template LIVRÉ : copie", async () => {
    const { Campaigns, campaignTemplateOwnership } = await freshModules();
    await Campaigns.put(campaign("c1"));
    const own = await campaignTemplateOwnership((await Campaigns.get("c1"))!);
    expect(own.mode).toBe("copy");
    expect(own.templateId).toBe(DEFAULT_TEMPLATE_ID);
  });

  it("deux campagnes sur le MÊME template : copie, et la phrase nomme le nombre", async () => {
    const { Campaigns, Templates, campaignTemplateOwnership } = await freshModules();
    await Templates.put({ ...DEFAULT_TEMPLATE, id: "tpl-a", createdAt: "2026-09-01T00:00:00.000Z" });
    await Campaigns.put(campaign("c1", "tpl-a"));
    await Campaigns.put(campaign("c2", "tpl-a"));
    const own = await campaignTemplateOwnership((await Campaigns.get("c1"))!);
    expect(own.mode).toBe("copy");
    expect(own.campaignsPinned).toBe(2);
    // Le nombre est DIT. « Une copie sera créée » sans dire pourquoi se lit
    // comme une lourdeur de l'outil, pas comme une protection d'un voisin.
    expect(own.reason).toContain("1 other campaign");
  });

  it("seule sur son template : édition sur place", async () => {
    const { Campaigns, Templates, campaignTemplateOwnership } = await freshModules();
    await Templates.put({ ...DEFAULT_TEMPLATE, id: "tpl-a", createdAt: "2026-09-01T00:00:00.000Z" });
    await Campaigns.put(campaign("c1", "tpl-a"));
    const own = await campaignTemplateOwnership((await Campaigns.get("c1"))!);
    expect(own.mode).toBe("in-place");
    expect(own.campaignsPinned).toBe(1);
  });
});

describe("saveTemplateForCampaign — l'invariant sur le VOISIN", () => {
  it("éditer depuis une campagne sur le LIVRÉ ne touche pas le livré", async () => {
    const { Campaigns, Templates, saveTemplateForCampaign, resolveTemplate } =
      await freshModules();
    await Campaigns.put(campaign("c1"));
    await Campaigns.put(campaign("c2"));
    const avant = (await resolveTemplate(DEFAULT_TEMPLATE_ID)).revision;

    const res = await saveTemplateForCampaign(
      "c1",
      write({ languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "DE"] })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.saved.created).toBe(true);
    expect(res.saved.templateId).not.toBe(DEFAULT_TEMPLATE_ID);

    // c1 est épinglée sur le neuf…
    expect((await Campaigns.get("c1"))!.templateId).toBe(res.saved.templateId);
    // …et RIEN n'a été enregistré sous l'id du livré.
    expect(await Templates.get(DEFAULT_TEMPLATE_ID)).toBeNull();
    // c2, elle, est jugée par exactement la même révision qu'avant.
    expect((await resolveTemplate(DEFAULT_TEMPLATE_ID)).revision).toBe(avant);
    expect((await Campaigns.get("c2"))!.templateId).toBeUndefined();
  });

  it("éditer un template PARTAGÉ le copie — le voisin garde sa révision", async () => {
    const { Campaigns, Templates, saveTemplateForCampaign, resolveTemplate } =
      await freshModules();
    const partage = { ...DEFAULT_TEMPLATE, id: "tpl-a", createdAt: "2026-09-01T00:00:00.000Z" };
    await Templates.put(partage);
    await Campaigns.put(campaign("c1", "tpl-a"));
    await Campaigns.put(campaign("c2", "tpl-a"));
    const revisionDeC2 = templateRevision(partage);

    const res = await saveTemplateForCampaign(
      "c1",
      write({ languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "DE"] })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.saved.created).toBe(true);

    // LA question. Pas « c1 a-t-elle sa colonne ? » mais « c2 est-elle encore
    // jugée par ce qu'elle était jugée hier ? »
    expect((await Campaigns.get("c2"))!.templateId).toBe("tpl-a");
    expect((await resolveTemplate("tpl-a")).revision).toBe(revisionDeC2);
    expect((await Templates.get("tpl-a"))!.languageColumns).not.toContain("DE");
    // Et c1, elle, a bien bougé.
    expect((await resolveTemplate(res.saved.templateId)).template.languageColumns).toContain("DE");
    expect(res.saved.revision).not.toBe(revisionDeC2);
  });

  it("une fois SEULE sur son template, la campagne l'édite sur place", async () => {
    const { Campaigns, saveTemplateForCampaign } = await freshModules();
    await Campaigns.put(campaign("c1"));
    const premier = await saveTemplateForCampaign(
      "c1",
      write({ languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "DE"] })
    );
    expect(premier.ok).toBe(true);
    if (!premier.ok) return;

    const second = await saveTemplateForCampaign(
      "c1",
      write({
        languageColumns: [...DEFAULT_TEMPLATE.languageColumns, "DE", "NL"],
        baseVersion: premier.saved.version,
      })
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Même id : pas de prolifération d'un template par sauvegarde.
    expect(second.saved.templateId).toBe(premier.saved.templateId);
    expect(second.saved.created).toBe(false);
    expect(second.saved.version).toBe(premier.saved.version + 1);
    expect(second.saved.previousRevision).toBe(premier.saved.revision);
  });

  it("une copie est une NAISSANCE : version 1, date à elle, préambule conservé", async () => {
    // Reprendre le `createdAt` de l'original ferait désigner par « le dernier
    // template créé » — la règle qui décide du référentiel de toute campagne
    // suivante — un template plus vieux que sa propre copie. Le préambule, lui,
    // n'est éditable nulle part : perdu à la copie, il est perdu pour de bon.
    const { Campaigns, Templates, saveTemplateForCampaign } = await freshModules();
    const origine = {
      ...DEFAULT_TEMPLATE,
      id: "tpl-a",
      version: 7,
      createdAt: "2026-01-01T00:00:00.000Z",
      preamble: [{ row: 1, cells: [{ col: 0, value: "Kering EMAIL brief" }] }],
    };
    await Templates.put(origine);
    await Campaigns.put(campaign("c1", "tpl-a"));
    await Campaigns.put(campaign("c2", "tpl-a"));

    const res = await saveTemplateForCampaign("c1", write());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const copie = (await Templates.get(res.saved.templateId))!;
    expect(copie.version).toBe(1);
    expect(copie.createdAt! > origine.createdAt).toBe(true);
    expect(copie.preamble).toEqual(origine.preamble);
    // La provenance des FAITS traverse : un référentiel copié ne se présente
    // pas comme né de rien.
    expect(copie.source).toBe(DEFAULT_TEMPLATE.source);
  });

  it("verrou de version : deux onglets, le second est refusé et non écrasé", async () => {
    const { Campaigns, saveTemplateForCampaign } = await freshModules();
    await Campaigns.put(campaign("c1"));
    const premier = await saveTemplateForCampaign("c1", write());
    expect(premier.ok).toBe(true);
    if (!premier.ok) return;
    await saveTemplateForCampaign("c1", write({ baseVersion: premier.saved.version }));

    const perime = await saveTemplateForCampaign(
      "c1",
      write({ label: "Écrasé", baseVersion: premier.saved.version })
    );
    expect(perime.ok).toBe(false);
    if (perime.ok) return;
    expect(perime.status).toBe(409);
    expect(perime.currentVersion).toBe(premier.saved.version + 1);
  });

  it("une campagne introuvable est DITE, elle ne crée pas de template orphelin", async () => {
    const { Templates, saveTemplateForCampaign } = await freshModules();
    const res = await saveTemplateForCampaign("jamais-vue", write());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(await Templates.list()).toHaveLength(0);
  });
});

/** Le contrôle 9 cite la clé ENTRE GUILLEMETS. Chercher la clé nue ferait
 *  matcher `subject-line` dans un message qui parle de
 *  `subject-line-default-optional` — deux champs bien réels du template livré,
 *  dont l'un est le préfixe de l'autre. Un test qui se trompe de sens comme
 *  celui-là passe au vert précisément quand il devrait échouer. */
const citeLaCle = (problems: readonly { message: string }[], key: string) =>
  problems.some((p) => p.message.includes(`"${key}"`));

describe("la disparition d'une clé de champ", () => {
  it("non nommée : refusée, et RIEN n'est écrit", async () => {
    const { Campaigns, Templates, saveTemplateForCampaign } = await freshModules();
    await Campaigns.put(campaign("c1"));
    const sansPremier = champs(DEFAULT_TEMPLATE.fields.slice(1));
    const res = await saveTemplateForCampaign("c1", write({ fields: sansPremier }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(citeLaCle(res.problems!, DEFAULT_TEMPLATE.fields[0].key)).toBe(true);
    // Un refus qui aurait quand même écrit serait pire qu'une absence de refus :
    // l'écran dirait « bloqué » sur un stockage déjà modifié.
    expect(await Templates.list()).toHaveLength(0);
    expect((await Campaigns.get("c1"))!.templateId).toBeUndefined();
  });

  it("NOMMÉE dans removedFieldKeys : acceptée", async () => {
    const { Campaigns, saveTemplateForCampaign, resolveTemplate } = await freshModules();
    await Campaigns.put(campaign("c1"));
    const parti = DEFAULT_TEMPLATE.fields[0].key;
    const res = await saveTemplateForCampaign(
      "c1",
      write({
        fields: champs(DEFAULT_TEMPLATE.fields.slice(1)),
        removedFieldKeys: [parti],
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const apres = await resolveTemplate(res.saved.templateId);
    expect(apres.template.fields.some((f) => f.key === parti)).toBe(false);
  });

  it("CONTRÔLE POSITIF — nommer UNE clé ne dispense pas des autres", async () => {
    // Sans ce cas, `removedFieldKeys` pourrait désarmer le contrôle en bloc dès
    // qu'il est non vide : le garde-fou aurait l'air de tenir en ne tenant plus.
    const { Campaigns, saveTemplateForCampaign } = await freshModules();
    await Campaigns.put(campaign("c1"));
    const res = await saveTemplateForCampaign(
      "c1",
      write({
        fields: champs(DEFAULT_TEMPLATE.fields.slice(2)),
        removedFieldKeys: [DEFAULT_TEMPLATE.fields[0].key],
      })
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(citeLaCle(res.problems!, DEFAULT_TEMPLATE.fields[1].key)).toBe(true);
    expect(citeLaCle(res.problems!, DEFAULT_TEMPLATE.fields[0].key)).toBe(false);
  });
});
