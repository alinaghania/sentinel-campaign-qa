// Persistance : JSON local (.data/) en dev, Azure Table Storage en prod
// (AZURE_TABLES_CONNECTION_STRING présent → adapter Table).
// Une entité JSON par objet, interface commune minimale.

import { promises as fs } from "fs";
import path from "path";
import { templateRevision } from "./brief-template";
import type {
  ArchivedTemplateRevision,
  BriefTemplate,
  StoredBriefTemplate,
} from "./brief-template";
import type { RuleConfig } from "./rule-config";
import type {
  AnalysisJob,
  AnalysisReport,
  Brand,
  Campaign,
  InboxEmail,
  MailboxConnection,
} from "./types";

const DATA_DIR = process.env.DATA_DIR || ".data";
let tmpSeq = 0; // compteur pour des noms de fichiers .tmp uniques (écritures concurrentes)

// ⚠️ Un `Kind` devient un NOM DE TABLE Azure (`cq${kind}`, cf. TableStore).
// Les noms de tables Azure sont ALPHANUMÉRIQUES : pas de tiret, pas d'underscore,
// et ils commencent par une lettre. Un kind nommé `template-revisions` passerait
// tous les tests (FileStore n'en fait qu'un nom de dossier) et ne casserait qu'en
// production, à la première écriture. D'où `templaterevisions`, sans tiret.
type Kind =
  | "campaigns"
  | "brands"
  | "reports"
  | "inbox"
  | "connections"
  | "tokens"
  | "jobs"
  | "settings"
  | "templates"
  | "templaterevisions";

interface Store {
  get<T>(kind: Kind, id: string): Promise<T | null>;
  put<T>(kind: Kind, id: string, value: T): Promise<void>;
  list<T>(kind: Kind): Promise<T[]>;
  del(kind: Kind, id: string): Promise<void>;
}

// --- adapter fichiers locaux ---
// Cache mémoire read-through : sur Azure Files (SMB), lire 800+ JSON à chaque
// listing coûtait 12-16 s. SÛR ici car l'app tourne en SINGLE REPLICA
// (maxReplicas=1, cf. infra Azure) : ce process est le seul écrivain, le cache
// ne peut pas devenir périmé par une autre instance. put/del le tiennent à jour.
//
// « Le seul écrivain » est vrai du PROCESS et faux du MODULE — cf. la note sur
// `store` en bas de fichier. C'est de là que venait la péremption réelle.
class FileStore implements Store {
  private cache = new Map<Kind, Map<string, unknown>>();
  private fullyListed = new Set<Kind>();

  private kc(kind: Kind): Map<string, unknown> {
    let m = this.cache.get(kind);
    if (!m) {
      m = new Map();
      this.cache.set(kind, m);
    }
    return m;
  }
  private dir(kind: Kind) {
    // `resolve`, pas `join` : `join` COLLE un `DATA_DIR` absolu derrière le cwd
    // (`/var/folders/…/tmp` devenait `<repo>/var/folders/…/tmp`) au lieu de
    // l'honorer. En prod `DATA_DIR` est relatif (`.data`, le mount Azure Files)
    // et les deux donnent le même chemin — le défaut ne se voyait que sur un
    // chemin absolu, donc uniquement dans les tests, qui écrivaient dans le
    // dépôt un dossier `var/` que leur nettoyage (visant le vrai /var) ratait.
    return path.resolve(process.cwd(), DATA_DIR, kind);
  }
  private file(kind: Kind, id: string) {
    return path.join(this.dir(kind), `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }
  async get<T>(kind: Kind, id: string): Promise<T | null> {
    const m = this.kc(kind);
    if (m.has(id)) {
      const v = m.get(id);
      // clone : le get→mutate→put des appelants ne doit pas muter le cache en place.
      return v === null ? null : (structuredClone(v) as T);
    }
    try {
      const v = JSON.parse(await fs.readFile(this.file(kind, id), "utf-8")) as T;
      m.set(id, v);
      return structuredClone(v);
    } catch {
      return null;
    }
  }
  async put<T>(kind: Kind, id: string, value: T): Promise<void> {
    await fs.mkdir(this.dir(kind), { recursive: true });
    // tmp UNIQUE (pid + compteur) : deux écritures concurrentes de la même clé
    // ne se battent plus sur le même fichier .tmp (évite ENOENT au rename).
    const tmp = `${this.file(kind, id)}.${process.pid}.${tmpSeq++}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, this.file(kind, id));
    // Copie défensive : l'appelant peut muter `value` après le put.
    this.kc(kind).set(id, structuredClone(value));
  }
  async list<T>(kind: Kind): Promise<T[]> {
    const m = this.kc(kind);
    if (!this.fullyListed.has(kind)) {
      try {
        const files = await fs.readdir(this.dir(kind));
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          const id = f.slice(0, -5);
          if (m.has(id)) continue; // déjà en cache (put récent)
          try {
            m.set(id, JSON.parse(await fs.readFile(path.join(this.dir(kind), f), "utf-8")));
          } catch {
            // fichier corrompu — ignoré
          }
        }
        this.fullyListed.add(kind);
      } catch {
        return [];
      }
    }
    // Références directes (PAS de clone) : cloner 130 Mo d'inbox à chaque appel
    // tuerait le gain. Contrat : les consommateurs de list() sont en LECTURE
    // SEULE (filtre/tri/DTO) — toute écriture passe par get→mutate→put (get
    // clone). Le tri des wrappers (Campaigns/Inbox.list) copie déjà le tableau.
    const out: T[] = [];
    for (const v of m.values()) if (v !== null) out.push(v as T);
    return out;
  }
  async del(kind: Kind, id: string): Promise<void> {
    this.kc(kind).delete(id);
    try {
      await fs.unlink(this.file(kind, id));
    } catch {
      // déjà absent
    }
  }
}

// --- adapter Azure Table Storage ---
class TableStore implements Store {
  private clients = new Map<string, import("@azure/data-tables").TableClient>();
  constructor(private conn: string) {}
  private async client(kind: Kind) {
    if (!this.clients.has(kind)) {
      const { TableClient } = await import("@azure/data-tables");
      const c = TableClient.fromConnectionString(this.conn, `cq${kind}`);
      await c.createTable().catch(() => {});
      this.clients.set(kind, c);
    }
    return this.clients.get(kind)!;
  }
  async get<T>(kind: Kind, id: string): Promise<T | null> {
    try {
      const c = await this.client(kind);
      const e = await c.getEntity<{ payload: string }>("main", id);
      return JSON.parse(e.payload) as T;
    } catch {
      return null;
    }
  }
  async put<T>(kind: Kind, id: string, value: T): Promise<void> {
    const c = await this.client(kind);
    await c.upsertEntity(
      { partitionKey: "main", rowKey: id, payload: JSON.stringify(value) },
      "Replace"
    );
  }
  async list<T>(kind: Kind): Promise<T[]> {
    const c = await this.client(kind);
    const out: T[] = [];
    for await (const e of c.listEntities<{ payload: string }>()) {
      try {
        out.push(JSON.parse(e.payload));
      } catch {
        // entité corrompue — ignorée
      }
    }
    return out;
  }
  async del(kind: Kind, id: string): Promise<void> {
    const c = await this.client(kind);
    await c.deleteEntity("main", id).catch(() => {});
  }
}

// UNE instance pour tout le process, portée par `globalThis`.
//
// Ce n'est pas une précaution de style : `const store = new FileStore()` au
// niveau module donne une instance par INSTANCE DE MODULE, et Next découpe le
// code serveur en bundles par route. `lib/store.ts` est donc évalué plusieurs
// fois dans le même process — mesuré sur le build de production : la route de
// login et la page /campaigns/[id]/brief/paste tenaient deux FileStore
// distincts, avec deux caches distincts.
//
// Le défaut que cela produisait ne ressemblait pas à un défaut de cache. La
// route POST .../template écrivait le fichier ET son propre cache ; la page
// relisait le sien, intact depuis sa première lecture, et réaffichait l'ancien
// template — indéfiniment, puisque `get` ne retourne au disque que pour un id
// qu'il n'a jamais vu. Enregistrement en 200, révision neuve, fichier correct
// sur le disque, et un écran qui affirme le contraire sans rien signaler. Une
// version qui recharge « proprement » l'ancienne valeur se lit comme un
// enregistrement perdu, jamais comme un cache.
//
// Le cache lui-même reste ce qu'il était : légitime en single replica. C'est
// « le process est le seul écrivain » qui était vrai, et « le module est unique »
// qui ne l'était pas.
declare global {
  var __sentinelStore: { readonly config: string; readonly store: Store } | undefined;
}

// L'instance est retenue AVEC la configuration qui l'a produite, et non seule.
// Un store porte un cache et, pour FileStore, un RÉPERTOIRE : le partager avec
// un module qui a été chargé sous un autre `DATA_DIR` rendrait les données du
// premier répertoire en croyant lire le second. Le cas se produit à chaque
// exécution des tests, qui déplacent `DATA_DIR` vers un dossier temporaire par
// cas — mais l'invariant ne leur appartient pas : c'est le partage qui est
// conditionné à l'identité de la source, pas au fait d'être en test.
const storeConfig = `${process.env.AZURE_TABLES_CONNECTION_STRING ? "table" : "file"}:${DATA_DIR}`;

// Lecture et écriture dans la même expression, et l'évaluation d'un module Node
// est synchrone : deux bundles ne peuvent pas s'intercaler entre le test et
// l'affectation.
if (globalThis.__sentinelStore?.config !== storeConfig) {
  globalThis.__sentinelStore = {
    config: storeConfig,
    store: process.env.AZURE_TABLES_CONNECTION_STRING
      ? new TableStore(process.env.AZURE_TABLES_CONNECTION_STRING)
      : new FileStore(),
  };
}
const store: Store = globalThis.__sentinelStore.store;

export const uid = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// --- API typée ---
export const Campaigns = {
  get: (id: string) => store.get<Campaign>("campaigns", id),
  put: (c: Campaign) => store.put("campaigns", c.id, c),
  list: async () =>
    (await store.list<Campaign>("campaigns")).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    ),
  del: (id: string) => store.del("campaigns", id),
};

// Écritures Campaign SÉRIALISÉES par id : get → mutate → put atomiques entre
// eux dans ce process. Obligatoire dès que plusieurs écrivains coexistent
// (jobs d'analyse détachés, routes attach, PATCH, extraction LLM de fond) :
// un put de snapshot périmé effacerait les versions/rapports posés entre-temps.
const campaignWriteChains = new Map<string, Promise<unknown>>();
export async function updateCampaign(
  id: string,
  mutate: (c: Campaign) => void | Promise<void>
): Promise<Campaign | null> {
  const prev = campaignWriteChains.get(id) ?? Promise.resolve();
  const next = prev.then(
    async () => {
      const c = await Campaigns.get(id);
      if (!c) return null;
      await mutate(c);
      c.updatedAt = new Date().toISOString();
      await Campaigns.put(c);
      return c;
    },
    async () => {
      const c = await Campaigns.get(id);
      if (!c) return null;
      await mutate(c);
      c.updatedAt = new Date().toISOString();
      await Campaigns.put(c);
      return c;
    }
  );
  campaignWriteChains.set(
    id,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

export const Brands = {
  get: (id: string) => store.get<Brand>("brands", id),
  put: (b: Brand) => store.put("brands", b.id, b),
  list: () => store.list<Brand>("brands"),
  del: (id: string) => store.del("brands", id),
};

// Configuration des règles éditée depuis /rules — SINGLETON (une seule entrée
// "default"). Absente tant que personne n'a rien modifié : les appelants
// traitent null comme "tous les défauts du code" (cf. resolveRuleConfig).
export const Settings = {
  get: () => store.get<RuleConfig>("settings", "default"),
  put: (c: RuleConfig) => store.put("settings", "default", { ...c, id: "default" as const }),
};

// Écritures Settings SÉRIALISÉES, même raison que updateCampaign ci-dessus.
// Le verrou de version de /api/rules ne protège que du "quelqu'un a sauvegardé
// pendant que tu éditais" ; il ne protège PAS de deux requêtes qui lisent la
// même version au même instant : les deux passent le contrôle, la seconde
// écrase la première, et la version n'avance que d'un cran. En enfermant
// lecture → contrôle → écriture dans cette chaîne, la seconde relit la version
// déjà incrémentée et repart en 409 comme prévu.
//
// Portée : ce process. Sentinel tourne sur un seul réplica (cf. README) —
// passer à plusieurs demanderait un verrou côté stockage, pas une Map.
let settingsWriteChain: Promise<unknown> = Promise.resolve();
export function updateSettings<T>(
  apply: (prev: RuleConfig | null) => Promise<T>
): Promise<T> {
  const run = async () => apply(await Settings.get());
  const next = settingsWriteChain.then(run, run);
  settingsWriteChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// Templates de brief éditables/créables. PAS un singleton, contrairement à
// Settings : Alina veut pouvoir en créer de nouveaux, pas seulement modifier
// celui livré. L'entrée d'id `default` est l'ÉDITION du template du code ; son
// absence signifie « personne n'a rien modifié », et les appelants retombent
// alors sur DEFAULT_TEMPLATE (cf. resolveTemplate).
export const Templates = {
  get: (id: string) => store.get<StoredBriefTemplate>("templates", id),
  put: (t: StoredBriefTemplate) => store.put("templates", t.id, t),
  list: () => store.list<StoredBriefTemplate>("templates"),
  del: (id: string) => store.del("templates", id),

  /** Archive une révision sous SON EMPREINTE, sans jamais écraser.
   *
   *  Deux invariants tenus ici plutôt que promis en commentaire :
   *  1. La clé est recalculée par `templateRevision(t)` au moment de l'écriture.
   *     Passer l'empreinte en paramètre aurait laissé archiver un contenu sous
   *     la clé d'un autre — une archive falsifiée est pire qu'une archive
   *     absente, parce qu'elle se cite.
   *  2. Si la clé existe déjà, on NE RÉÉCRIT PAS. Le contenu serait identique
   *     (la clé est son hash), mais réécrire écraserait `firstSeenAt` et une
   *     révision restaurée à l'identique paraîtrait née aujourd'hui. */
  archive: async (t: BriefTemplate, templateId: string): Promise<string> => {
    const id = templateRevision(t);
    const existing = await store.get<ArchivedTemplateRevision>("templaterevisions", id);
    if (existing) return id;
    await store.put<ArchivedTemplateRevision>("templaterevisions", id, {
      id,
      templateId,
      firstSeenAt: new Date().toISOString(),
      template: t,
    });
    return id;
  },

  /** Que valait la révision qui a rendu CE verdict ? Répond `null` pour une
   *  révision jamais archivée — un rapport antérieur à l'archive, typiquement.
   *  Ce `null` est un TROISIÈME ÉTAT, pas une absence de template : « je ne sais
   *  pas ce que cette empreinte contenait », jamais « elle ne contenait rien ». */
  revision: (rev: string) => store.get<ArchivedTemplateRevision>("templaterevisions", rev),
  revisions: () => store.list<ArchivedTemplateRevision>("templaterevisions"),
};

// Écritures Templates SÉRIALISÉES, même raison exactement que updateSettings
// ci-dessus : le contrôle de version de la route ne protège pas de deux requêtes
// qui LISENT la même version au même instant. Chaîne par id — deux templates
// différents n'ont aucune raison de s'attendre l'un l'autre, et les sérialiser
// ensemble ferait payer à chaque édition le temps de toutes les autres.
const templateWriteChains = new Map<string, Promise<unknown>>();
export function updateTemplate<T>(
  id: string,
  apply: (prev: StoredBriefTemplate | null) => Promise<T>
): Promise<T> {
  const run = async () => apply(await Templates.get(id));
  const prev = templateWriteChains.get(id) ?? Promise.resolve();
  const next = prev.then(run, run);
  // La chaîne retient la DERNIÈRE écriture, jamais son résultat ni son erreur :
  // une rejection non neutralisée ferait échouer l'édition suivante pour une
  // faute qui n'est pas la sienne.
  templateWriteChains.set(
    id,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

export const Reports = {
  get: (id: string) => store.get<AnalysisReport>("reports", id),
  put: (r: AnalysisReport) => store.put("reports", r.id, r),
  list: () => store.list<AnalysisReport>("reports"),
};

export const Jobs = {
  get: (id: string) => store.get<AnalysisJob>("jobs", id),
  put: (j: AnalysisJob) => store.put("jobs", j.id, j),
  list: () => store.list<AnalysisJob>("jobs"),
  del: (id: string) => store.del("jobs", id),
};

export const Inbox = {
  get: (id: string) => store.get<InboxEmail>("inbox", id),
  put: (e: InboxEmail) => store.put("inbox", e.id, e),
  del: (id: string) => store.del("inbox", id),
  list: async () =>
    (await store.list<InboxEmail>("inbox")).sort((a, b) =>
      b.receivedAt.localeCompare(a.receivedAt)
    ),
};

export const Connections = {
  get: (provider: string) => store.get<MailboxConnection>("connections", provider),
  put: (c: MailboxConnection) => store.put("connections", c.provider, c),
  list: () => store.list<MailboxConnection>("connections"),
};

// Tokens OAuth (refresh tokens) — en prod : Key Vault ; ici store chiffrable.
export const Tokens = {
  get: (provider: string) =>
    store.get<{ id: string; refreshToken: string; email?: string }>("tokens", provider),
  put: (provider: string, refreshToken: string, email?: string) =>
    store.put("tokens", provider, { id: provider, refreshToken, email }),
  del: (provider: string) => store.del("tokens", provider),
};
