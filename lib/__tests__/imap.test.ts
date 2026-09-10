// Migration Gmail API → IMAP (lib/imap.ts).
// `imapflow`, le store et parse-mime sont mockés : ces tests n'ouvrent jamais
// de socket TLS et n'écrivent jamais dans .data/.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEmail, MailboxConnection } from "../types";

// --- mocks hoistés (vi.mock est remonté au-dessus des imports) ---
const mocks = vi.hoisted(() => ({
  inboxList: vi.fn(async (): Promise<unknown[]> => []),
  inboxPut: vi.fn(async (): Promise<void> => undefined),
  connGet: vi.fn(async (): Promise<unknown> => null),
  connPut: vi.fn(async (): Promise<void> => undefined),
  parseMime: vi.fn(async () => ({
    subject: "Sujet",
    from: "expediteur@exemple.fr",
    receivedAt: "2026-08-01T10:00:00.000Z",
    html: "<p>corps</p>",
    rawMime: "raw",
    headerChecks: undefined,
  })),
  ImapFlowCtor: vi.fn(),
}));

// importOriginal : lib/imap.ts peut importer d'autres symboles du store
// (uid, Tokens…) — on ne remplace que les deux collections qui touchent le disque.
vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  return {
    ...actual,
    Inbox: { ...actual.Inbox, list: mocks.inboxList, put: mocks.inboxPut },
    Connections: { ...actual.Connections, get: mocks.connGet, put: mocks.connPut },
  };
});

vi.mock("../parse-mime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parse-mime")>();
  return { ...actual, parseMime: mocks.parseMime };
});

vi.mock("imapflow", () => ({ ImapFlow: mocks.ImapFlowCtor }));

import { gmMsgIdToApiId, imapConfigured, imapSync, normalizeAppPassword } from "../imap";

// ---------------------------------------------------------------------------
// 1. gmMsgIdToApiId — le pont de continuité avec la base existante.
// ---------------------------------------------------------------------------
// Les mails déjà stockés portent l'id de l'API Gmail, en HEXADÉCIMAL.
// X-GM-MSGID (extension IMAP, exposé par imapflow via `emailId`) renvoie le
// MÊME identifiant en DÉCIMAL. Une conversion fausse ⇒ aucun id ne matche
// l'existant ⇒ la première synchro ré-ajoute TOUTE la boîte en doublon, sans
// le moindre message d'erreur.
//
// 🔴 PIÈGE DU MIROIR — à ne jamais reproduire ici :
//     expect(gmMsgIdToApiId(x)).toBe(BigInt(x).toString(16))   // ← INTERDIT
// L'attendu serait recalculé depuis la même entrée par la même formule : le
// test passerait même si la fonction était fausse (il comparerait `x == x`).
// Les attendus ci-dessous sont donc des LITTÉRAUX écrits à la main, vérifiés
// hors de ce fichier et hors du module testé, par trois implémentations
// indépendantes (CPython `hex()`, `bc` obase=16, Node `BigInt.toString(16)`).
//
// ⚠️ Le couple d'ancrage fourni dans la spec de cette tâche
// (`1278455344230334865` → `"11bd1ea6a4b0e451"`) est arithmétiquement FAUX :
// ces deux nombres ne sont pas le même entier. Les deux valeurs sont
// néanmoins réutilisées ci-dessous, chacune correctement appariée, ce qui
// donne DEUX ancrages indépendants au lieu d'un.
describe("gmMsgIdToApiId — conversion X-GM-MSGID (décimal) → id API Gmail (hex)", () => {
  // Ancrage A : le décimal de la doc IMAP de Google (X-GM-MSGID).
  const ANCRAGE_A_DEC = "1278455344230334865";
  const ANCRAGE_A_HEX = "11bdfc5cae0c8191";
  // Ancrage B : l'hexadécimal, apparié à son vrai décimal.
  const ANCRAGE_B_DEC = "1278211570319549521";
  const ANCRAGE_B_HEX = "11bd1ea6a4b0e451";

  it("ancrage A : le décimal documenté donne exactement l'id API attendu", () => {
    const recu = gmMsgIdToApiId(ANCRAGE_A_DEC);
    expect(
      recu,
      `gmMsgIdToApiId("${ANCRAGE_A_DEC}") a rendu "${recu}", attendu "${ANCRAGE_A_HEX}"`
    ).toBe(ANCRAGE_A_HEX);
  });

  it("ancrage B : second couple indépendant, même exigence", () => {
    const recu = gmMsgIdToApiId(ANCRAGE_B_DEC);
    expect(
      recu,
      `gmMsgIdToApiId("${ANCRAGE_B_DEC}") a rendu "${recu}", attendu "${ANCRAGE_B_HEX}"`
    ).toBe(ANCRAGE_B_HEX);
  });

  it("entrée bigint et entrée string donnent le même id", () => {
    // imapflow rend `emailId` en string ; un appelant peut passer un bigint.
    const depuisBigint = gmMsgIdToApiId(1278455344230334865n);
    const depuisString = gmMsgIdToApiId(ANCRAGE_A_DEC);
    expect(
      depuisBigint,
      `bigint 1278455344230334865n a rendu "${depuisBigint}", attendu "${ANCRAGE_A_HEX}"`
    ).toBe(ANCRAGE_A_HEX);
    expect(
      depuisString,
      `string "${ANCRAGE_A_DEC}" a rendu "${depuisString}", bigint a rendu "${depuisBigint}"`
    ).toBe(depuisBigint);
  });

  it("sortie en minuscules — l'API Gmail ne renvoie jamais de majuscule", () => {
    // "11BDFC5CAE0C8191" !== "11bdfc5cae0c8191" pour un Set<string> : une
    // sortie en majuscules casse la déduplication aussi sûrement qu'une
    // conversion fausse.
    const recu = gmMsgIdToApiId(ANCRAGE_A_DEC);
    expect(recu, `"${recu}" contient des majuscules`).toBe(recu.toLowerCase());
    expect(recu, `"${recu}" ne doit pas matcher /[A-F]/`).not.toMatch(/[A-F]/);
  });

  it("petits ids : pas de padding, pas de préfixe 0x", () => {
    const c255 = gmMsgIdToApiId("255");
    expect(c255, `gmMsgIdToApiId("255") a rendu "${c255}", attendu "ff"`).toBe("ff");
    const c16 = gmMsgIdToApiId(16n);
    expect(c16, `gmMsgIdToApiId(16n) a rendu "${c16}", attendu "10"`).toBe("10");
    const c1 = gmMsgIdToApiId("1");
    expect(c1, `gmMsgIdToApiId("1") a rendu "${c1}", attendu "1"`).toBe("1");
    // Un padding à 16 chiffres ("00000000000000ff") serait aussi un id faux.
    expect(c255, `"${c255}" ne doit être ni padé ni préfixé`).not.toMatch(/^0[x0]/);
  });

  it("zéro", () => {
    const c0 = gmMsgIdToApiId("0");
    expect(c0, `gmMsgIdToApiId("0") a rendu "${c0}", attendu "0"`).toBe("0");
    const c0b = gmMsgIdToApiId(0n);
    expect(c0b, `gmMsgIdToApiId(0n) a rendu "${c0b}", attendu "0"`).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// 2. normalizeAppPassword
// ---------------------------------------------------------------------------
// Google affiche le mot de passe d'application en 4 blocs de 4 séparés par des
// espaces. Les espaces NE FONT PAS partie du secret : les laisser passer donne
// un AUTHENTICATIONFAILED que l'utilisateur ne sait pas diagnostiquer.
// (Aucun vrai secret ici — les chaînes ci-dessous sont inventées.)
describe("normalizeAppPassword — les espaces d'affichage ne sont pas le secret", () => {
  it("retire les espaces internes des 4 blocs de 4 et rend 16 caractères", () => {
    const affiche = "abcd efgh ijkl mnop";
    const recu = normalizeAppPassword(affiche);
    expect(recu, `normalizeAppPassword("${affiche}") a rendu "${recu}"`).toBe("abcdefghijklmnop");
    expect(recu.length, `longueur ${recu.length} pour "${recu}", attendu 16`).toBe(16);
  });

  it("retire les espaces en tête et en fin (copier-coller)", () => {
    const affiche = "  wxyz abcd efgh ijkl  ";
    const recu = normalizeAppPassword(affiche);
    expect(recu, `normalizeAppPassword("${affiche}") a rendu "${recu}"`).toBe("wxyzabcdefghijkl");
  });

  it("retire tabulations et espaces insécables (U+00A0)", () => {
    // L'espace insécable (U+00A0) est ce que rend un copier-coller depuis la
    // page Google. Il est écrit en séquence d'échappement \u00a0 et NON collé
    // littéralement : dans le source un insécable est indiscernable d'un espace
    // normal, un "nettoyage" bien intentionné le remplacerait et ce test
    // cesserait silencieusement de tester ce que son nom annonce.
    // \s (avec le flag u) couvre l'insécable ; une classe [ ] ne le couvrirait pas.
    const affiche = "abcd\tefgh\u00a0ijkl\u00a0mnop";
    // Contrôle positif : on vérifie que l'entrée contient bien ce qu'on prétend
    // lui faire subir, sinon l'assertion suivante ne prouverait rien sur U+00A0.
    expect(affiche, "l'entrée de test ne contient aucun U+00A0").toMatch(/\u00a0/);
    const recu = normalizeAppPassword(affiche);
    expect(recu, `normalizeAppPassword(${JSON.stringify(affiche)}) a rendu "${recu}"`).toBe(
      "abcdefghijklmnop"
    );
  });

  it("une chaîne déjà propre est rendue inchangée", () => {
    const propre = "abcdefghijklmnop";
    const recu = normalizeAppPassword(propre);
    expect(recu, `normalizeAppPassword("${propre}") a rendu "${recu}"`).toBe(propre);
  });
});

// ---------------------------------------------------------------------------
// 3. imapConfigured
// ---------------------------------------------------------------------------
describe("imapConfigured — les deux variables d'environnement sont requises", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("aucune des deux → false", () => {
    vi.stubEnv("IMAP_USER", undefined);
    vi.stubEnv("IMAP_PASSWORD", undefined);
    expect(imapConfigured(), "sans IMAP_USER ni IMAP_PASSWORD").toBe(false);
  });

  it("IMAP_USER seul → false", () => {
    vi.stubEnv("IMAP_USER", "qa@exemple.fr");
    vi.stubEnv("IMAP_PASSWORD", undefined);
    expect(imapConfigured(), "avec IMAP_USER seul").toBe(false);
  });

  it("IMAP_PASSWORD seul → false", () => {
    vi.stubEnv("IMAP_USER", undefined);
    vi.stubEnv("IMAP_PASSWORD", "abcdefghijklmnop");
    expect(imapConfigured(), "avec IMAP_PASSWORD seul").toBe(false);
  });

  it("les deux → true", () => {
    vi.stubEnv("IMAP_USER", "qa@exemple.fr");
    vi.stubEnv("IMAP_PASSWORD", "abcdefghijklmnop");
    expect(imapConfigured(), "avec IMAP_USER et IMAP_PASSWORD").toBe(true);
  });

  it("chaîne vide = absente (une var déclarée vide en prod n'est pas une config)", () => {
    vi.stubEnv("IMAP_USER", "");
    vi.stubEnv("IMAP_PASSWORD", "abcdefghijklmnop");
    expect(imapConfigured(), 'IMAP_USER="" doit compter comme absent').toBe(false);
    vi.stubEnv("IMAP_USER", "qa@exemple.fr");
    vi.stubEnv("IMAP_PASSWORD", "");
    expect(imapConfigured(), 'IMAP_PASSWORD="" doit compter comme absent').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. imapSync — gestion d'erreurs, sans réseau
// ---------------------------------------------------------------------------
/** Client ImapFlow simulé. Expose les deux styles d'ouverture (getMailboxLock
 *  et mailboxOpen) et les deux styles de fermeture (logout et close). */
interface ClientSimule {
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  mailboxOpen: ReturnType<typeof vi.fn>;
  getMailboxLock: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchOne: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  capabilities: Map<string, boolean>;
  mailbox: { path: string; exists: number; uidValidity: bigint };
}

let client: ClientSimule;

/** Message IMAP simulé, tel qu'imapflow le rend (emailId = X-GM-MSGID décimal). */
function messageSimule(emailIdDecimal: string, seq = 1) {
  return {
    seq,
    uid: seq,
    emailId: emailIdDecimal,
    source: Buffer.from("From: a@b.fr\r\nSubject: test\r\n\r\ncorps"),
  };
}

function nouveauClient(): ClientSimule {
  const release = vi.fn();
  const c: ClientSimule = {
    connect: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    // allMailPath() cherche le dossier par son attribut SPECIAL-USE \All.
    list: vi.fn(async () => [
      { path: "INBOX", specialUse: undefined },
      { path: "[Gmail]/All Mail", specialUse: "\\All" },
    ]),
    mailboxOpen: vi.fn(async () => ({ path: "[Gmail]/All Mail", exists: 1 })),
    getMailboxLock: vi.fn(async () => ({ path: "[Gmail]/All Mail", release })),
    search: vi.fn(async () => [1]),
    fetch: vi.fn(async function* () {
      yield messageSimule("1278455344230334865");
    }),
    fetchOne: vi.fn(async () => messageSimule("1278455344230334865")),
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    release,
    // searchUids() lit capabilities.has("X-GM-EXT-1") pour choisir X-GM-RAW.
    capabilities: new Map([["X-GM-EXT-1", true]]),
    mailbox: { path: "[Gmail]/All Mail", exists: 1, uidValidity: 1n },
  };
  return c;
}

/** Vrai si la connexion a été refermée par l'un ou l'autre des deux moyens. */
function connexionFermee(c: ClientSimule): boolean {
  return c.logout.mock.calls.length > 0 || c.close.mock.calls.length > 0;
}

const CONNEXION_OK: MailboxConnection = {
  provider: "gmail",
  email: "qa@exemple.fr",
  status: "connected",
  connectedAt: "2026-08-01T09:00:00.000Z",
};

/** Toutes les MailboxConnection persistées pendant le test. */
function connexionsPersistees(): MailboxConnection[] {
  return mocks.connPut.mock.calls.map((c) => (c as unknown[])[0] as MailboxConnection);
}

describe("imapSync — jamais de réseau, jamais de socket qui fuit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client = nouveauClient();
    // Fonction CLASSIQUE, pas une arrow : lib/imap.ts fait `new ImapFlow(...)`
    // et une arrow n'est pas constructible.
    mocks.ImapFlowCtor.mockImplementation(function () {
      return client;
    });
    mocks.inboxList.mockResolvedValue([]);
    mocks.connGet.mockResolvedValue(CONNEXION_OK);
    vi.stubEnv("IMAP_USER", "qa@exemple.fr");
    vi.stubEnv("IMAP_PASSWORD", "abcd efgh ijkl mnop");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("config absente : aucune connexion tentée, aucun crash", async () => {
    vi.stubEnv("IMAP_USER", undefined);
    vi.stubEnv("IMAP_PASSWORD", undefined);
    const r = await imapSync();
    expect(r.added, `added=${r.added} alors qu'aucune synchro n'est possible`).toBe(0);
    // Le point qui mord : sans identifiants, on ne doit même pas instancier
    // le client (sinon connexion réelle vers imap.gmail.com en production).
    expect(
      mocks.ImapFlowCtor.mock.calls.length,
      `ImapFlow instancié ${mocks.ImapFlowCtor.mock.calls.length} fois sans identifiants`
    ).toBe(0);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("AUTHENTICATIONFAILED : statut 'error' et message qui parle du mot de passe d'application", async () => {
    client.connect.mockRejectedValue(
      new Error("Command failed: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)")
    );
    const r = await imapSync();

    expect(r.error, `imapSync a rendu error=${JSON.stringify(r.error)}`).toBeTruthy();
    const persistees = connexionsPersistees();
    expect(
      persistees.length,
      `Connections.put appelé ${persistees.length} fois, attendu ≥1 pour marquer l'erreur`
    ).toBeGreaterThan(0);
    const derniere = persistees[persistees.length - 1];
    expect(derniere.status, `statut persisté "${derniere.status}", attendu "error"`).toBe("error");

    // Assertion sur le CONTENU : un message non vide mais opaque
    // ("Command failed") ne dit pas à l'utilisateur quoi faire. Le seul geste
    // qui répare est de régénérer un mot de passe d'application Google.
    const texte = `${derniere.error ?? ""} ${r.error ?? ""}`;
    // `d.application` tolère l'apostrophe typographique ; `mots?` le pluriel.
    expect(
      texte,
      `message d'erreur non actionnable : ${JSON.stringify(texte)} — doit mentionner le mot de passe d'application`
    ).toMatch(/mots? de passe d.application|app password/i);
  });

  it("search() === false (commande refusée) n'est PAS 'zéro message'", async () => {
    // imapflow type search() en `number[] | false`. Un `false` traité comme un
    // tableau vide fait passer une commande REFUSÉE pour une boîte VIDE :
    // synchro silencieusement inopérante, statut vert, zéro mail.
    client.search.mockResolvedValue(false);
    const r = await imapSync();
    expect(r.added, `added=${r.added}`).toBe(0);
    expect(
      r.error,
      `search()=false a rendu error=${JSON.stringify(r.error)} — une commande refusée doit remonter une erreur`
    ).toBeTruthy();
    const persistees = connexionsPersistees();
    const statuts = persistees.map((c) => c.status);
    expect(
      statuts,
      `statuts persistés ${JSON.stringify(statuts)} — aucun "error" alors que search() a été refusé`
    ).toContain("error");
  });

  it("la connexion est refermée même quand le fetch jette", async () => {
    // Une socket TLS qui fuit sur un réplica unique finit par épuiser le
    // process : la fermeture doit être dans un finally, pas après le succès.
    client.fetch.mockImplementation(async function* () {
      yield messageSimule("1278455344230334865");
      throw new Error("Connection closed unexpectedly pendant le fetch");
    });
    const r = await imapSync();
    expect(r.error, `imapSync a rendu error=${JSON.stringify(r.error)}`).toBeTruthy();
    expect(
      connexionFermee(client),
      `connexion NON refermée : logout appelé ${client.logout.mock.calls.length} fois, close ${client.close.mock.calls.length} fois`
    ).toBe(true);
    // Garde d'honnêteté : sans elle, ce test passerait au vert alors que
    // l'exécution a échoué AVANT d'atteindre le fetch — il ne testerait plus
    // "fermée quand le fetch jette" mais "fermée quand n'importe quoi jette".
    expect(
      client.fetch.mock.calls.length,
      `client.fetch n'a jamais été appelé : l'erreur testée n'est pas celle du fetch`
    ).toBeGreaterThan(0);
  });

  it("la connexion est refermée quelle que soit l'issue de la lecture", async () => {
    // Cible du sabotage : porte UNIQUEMENT sur le finally de fermeture, donc
    // indépendante de ce qui se passe en amont dans la lecture.
    await imapSync();
    expect(
      connexionFermee(client),
      `connexion NON refermée : logout ${client.logout.mock.calls.length}, close ${client.close.mock.calls.length}`
    ).toBe(true);
  });

  it("déduplication : un message déjà en base n'est pas réécrit", async () => {
    // C'est ici que se paie une conversion d'id fausse : l'existant porte
    // l'hexadécimal, X-GM-MSGID rend le décimal.
    const dejaEnBase: InboxEmail = {
      id: "gm-11bdfc5cae0c8191",
      provider: "gmail",
      providerMessageId: "11bdfc5cae0c8191",
      subject: "Déjà synchronisé",
      from: "expediteur@exemple.fr",
      receivedAt: "2026-08-01T10:00:00.000Z",
    };
    mocks.inboxList.mockResolvedValue([dejaEnBase]);
    client.search.mockResolvedValue([1]);
    client.fetch.mockImplementation(async function* () {
      yield messageSimule("1278455344230334865"); // = 11bdfc5cae0c8191
    });

    const r = await imapSync();
    // Garde d'honnêteté : "0 écriture" ne vaut preuve de déduplication que si
    // la synchro a effectivement abouti. Une synchro qui PLANTE écrit 0 aussi.
    expect(
      r.error,
      `la synchro a échoué (${JSON.stringify(r.error)}) — le zéro écriture ne prouve pas la déduplication`
    ).toBeFalsy();
    const ecrits = mocks.inboxPut.mock.calls.map(
      (c) => ((c as unknown[])[0] as InboxEmail).providerMessageId
    );
    expect(
      mocks.inboxPut.mock.calls.length,
      `Inbox.put appelé ${mocks.inboxPut.mock.calls.length} fois pour un message déjà en base (ids écrits : ${JSON.stringify(ecrits)})`
    ).toBe(0);
    expect(r.added, `added=${r.added} pour un message déjà en base`).toBe(0);
  });

  it("un message inconnu est bien ajouté sous son id hexadécimal", async () => {
    // Contre-épreuve du test précédent : sans elle, une dédup qui rejette TOUT
    // passerait aussi au vert.
    mocks.inboxList.mockResolvedValue([]);
    client.search.mockResolvedValue([1]);
    client.fetch.mockImplementation(async function* () {
      yield messageSimule("1278455344230334865");
    });
    const r = await imapSync();
    expect(
      mocks.inboxPut.mock.calls.length,
      `Inbox.put appelé ${mocks.inboxPut.mock.calls.length} fois pour un message inconnu, attendu 1`
    ).toBe(1);
    const ecrit = (mocks.inboxPut.mock.calls[0] as unknown[])[0] as InboxEmail;
    expect(
      ecrit.providerMessageId,
      `providerMessageId écrit "${ecrit.providerMessageId}", attendu "11bdfc5cae0c8191" (hex, pas le décimal IMAP)`
    ).toBe("11bdfc5cae0c8191");
    expect(r.added, `added=${r.added}, attendu 1`).toBe(1);
  });
});
