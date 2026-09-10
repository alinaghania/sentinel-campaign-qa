// UNE instance de store pour tout le process.
//
// Ce que ce fichier protège, et pourquoi il ne ressemble pas à ce qu'il
// protège. Next découpe le code serveur en bundles PAR ROUTE : `lib/store.ts`
// est évalué plusieurs fois dans un seul process. Mesuré sur le build de
// production — la route de login et la page /campaigns/[id]/brief/paste
// tenaient deux `FileStore` distincts, donc deux caches distincts.
//
// Le défaut qui en découlait ne se présentait pas comme un défaut de cache. La
// route qui enregistre un template écrivait le fichier ET son propre cache ; la
// page relisait le sien, intact depuis sa première lecture, et réaffichait
// l'ancien template. Réponse 200, révision neuve, fichier correct sur le
// disque, écran qui affirme le contraire. Une valeur qui « revient » au
// rechargement se lit comme un enregistrement perdu, jamais comme un cache — et
// personne ne va chercher le bogue dans un fichier qui contient la bonne
// donnée.
//
// `vi.resetModules()` reproduit exactement la condition : deux évaluations du
// même module dans le même process. C'est la seule façon de tester ici la
// duplication que fait le bundler ailleurs.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("le store est unique dans le process", () => {
  // DATA_DIR temporaire, posé AVANT le premier import : `lib/store` le lit au
  // chargement du module, et un test qui l'oublie écrit dans le `.data` du
  // dépôt — il passerait, en polluant les données de développement.
  let dir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as { __sentinelStore?: unknown }).__sentinelStore;
    dir = mkdtempSync(join(tmpdir(), "sentinel-store-"));
    prevDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("deux évaluations du module partagent LE MÊME store", async () => {
    const a = await import("../store");
    vi.resetModules(); // second bundle : le module est réévalué de zéro
    const b = await import("../store");

    // Contrôle positif : sans cette assertion, un `resetModules` sans effet
    // ferait passer le test en comparant un module à lui-même.
    expect(b.Campaigns).not.toBe(a.Campaigns);

    // Le cache, lui, doit être commun : c'est le seul point qui compte.
    await a.Campaigns.put({
      id: "__store-singleton",
      name: "sonde",
      updatedAt: new Date().toISOString(),
    } as Parameters<typeof a.Campaigns.put>[0]);
    const relu = await b.Campaigns.get("__store-singleton");
    expect(relu?.name).toBe("sonde");
    await b.Campaigns.del("__store-singleton");
  });

  it("une MISE À JOUR traverse aussi — c'est le cas qui échouait", async () => {
    // Le cas facile (id jamais vu) passait déjà AVANT le correctif : `get` va au
    // disque pour un id absent de son cache. Ce qui échouait, c'est la relecture
    // d'un id que le lecteur avait DÉJÀ mis en cache. Sans cette première
    // lecture, ce test mesurerait le chemin qui n'a jamais été cassé.
    const ecrivain = await import("../store");
    const id = "__store-singleton-maj";
    const base = {
      id,
      name: "v1",
      updatedAt: new Date().toISOString(),
    } as Parameters<typeof ecrivain.Campaigns.put>[0];
    await ecrivain.Campaigns.put(base);

    vi.resetModules();
    const lecteur = await import("../store");
    expect((await lecteur.Campaigns.get(id))?.name).toBe("v1"); // met en cache

    await ecrivain.Campaigns.put({ ...base, name: "v2" });
    expect((await lecteur.Campaigns.get(id))?.name).toBe("v2");

    await lecteur.Campaigns.del(id);
  });

  it("un AUTRE répertoire de données ne partage PAS l'instance", async () => {
    // Le partage est conditionné à l'identité de la source. Sans cette
    // condition, un module chargé sous un second `DATA_DIR` recevrait le store
    // du premier : il rendrait les données du mauvais répertoire, avec un cache
    // qui a l'air chaud et des lectures qui ont l'air de réussir.
    const a = await import("../store");
    await a.Campaigns.put({
      id: "__ailleurs",
      name: "dans le premier répertoire",
      updatedAt: new Date().toISOString(),
    } as Parameters<typeof a.Campaigns.put>[0]);

    const autre = mkdtempSync(join(tmpdir(), "sentinel-store-bis-"));
    process.env.DATA_DIR = autre;
    vi.resetModules();
    const b = await import("../store");
    expect(await b.Campaigns.get("__ailleurs")).toBeNull();
    rmSync(autre, { recursive: true, force: true });
    process.env.DATA_DIR = dir;
  });
});
