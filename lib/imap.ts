// Lecture de la boîte Gmail par IMAP + mot de passe d'application, en
// remplacement de l'API Gmail + OAuth (cf. lib/gmail.ts) : en mode Testing
// Google le refresh token meurt tous les ~7 jours, un mot de passe
// d'application ne dépend d'aucun consentement et ne se révoque que si le mot
// de passe du COMPTE change.
//
// Les entrées écrites gardent provider "gmail" et l'id "gm-<id>" : ce module
// change le TRANSPORT, pas le modèle de données (lib/types.ts ne connaît pas
// de provider "imap"). La continuité avec les mails déjà en base tient
// entièrement à gmMsgIdToApiId() ci-dessous.

import { ImapFlow, type FetchMessageObject, type SearchObject } from "imapflow";
import { Connections, Inbox } from "./store";
import { parseMime } from "./parse-mime";
import type { InboxEmail } from "./types";

const DEFAULT_HOST = "imap.gmail.com";
const DEFAULT_PORT = 993;

export function imapConfigured(): boolean {
  return Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

/** Google affiche le mot de passe d'application en 4 blocs de 4 séparés par des
 *  espaces : ces espaces sont un artefact d'AFFICHAGE, ils ne font pas partie
 *  du secret. Collés tels quels ils donnent un AUTHENTICATIONFAILED sans cause
 *  visible. On retire aussi l'insécable, que la copie depuis une page web
 *  glisse régulièrement à la place de l'espace. */
export function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/gu, "");
}

/** X-GM-MSGID (IMAP) et l'id de message de l'API Gmail sont LE MÊME entier 64
 *  bits écrit dans deux bases : décimal côté IMAP, hexadécimal minuscule côté
 *  API. Les mails déjà stockés portent la forme API dans providerMessageId →
 *  sans cette conversion la première synchro IMAP ne reconnaît AUCUN mail
 *  existant et ré-ajoute toute la boîte en doublon.
 *  toString(16) donne du minuscule, sans padding : exactement la forme rendue
 *  par l'API Gmail — ne pas "normaliser" avec un padStart. */
export function gmMsgIdToApiId(msgId: bigint | string): string {
  // BigInt("0x1f") vaut 31 : une chaîne DÉJÀ hexadécimale passerait en silence
  // et ressortirait convertie de travers. Seul le décimal pur est accepté.
  if (typeof msgId === "string" && !/^\d+$/.test(msgId)) {
    throw new Error(`X-GM-MSGID non décimal : ${msgId.slice(0, 40)}`);
  }
  return BigInt(msgId).toString(16);
}

function gmailQuery(): string {
  return process.env.GMAIL_QUERY || "newer_than:30d";
}

function maxMessages(): number {
  return Number(process.env.GMAIL_MAX_MESSAGES) || 200;
}

/** Repli utilisé quand le serveur n'annonce pas X-GM-EXT-1 (donc pas de
 *  X-GM-RAW) : de toute la syntaxe Gmail, seul "newer_than:Nd|Nm|Ny" a un
 *  équivalent IMAP standard (SINCE). Tout le reste de la requête (label:,
 *  from:, has:…) est PERDU — d'où l'avertissement chez l'appelant. */
function sinceFromGmailQuery(q: string): Date {
  const m = /newer_than:(\d+)([dmy])/i.exec(q);
  const days = m
    ? Number(m[1]) * (m[2].toLowerCase() === "y" ? 365 : m[2].toLowerCase() === "m" ? 30 : 1)
    : 30;
  return new Date(Date.now() - days * 86_400_000);
}

function newClient(): ImapFlow {
  // Timeouts serrés : une sonde liveness frappe /api/health toutes les 30 s et
  // redémarre le conteneur après 3 échecs. Les défauts de la lib (90 s de
  // connexion, 5 min d'inactivité socket) mangeraient tout le budget.
  // disableAutoIdle : cette connexion est jetable, un IDLE automatique ne
  // ferait qu'ajouter deux aller-retours à chaque commande.
  return new ImapFlow({
    host: process.env.IMAP_HOST || DEFAULT_HOST,
    port: Number(process.env.IMAP_PORT) || DEFAULT_PORT,
    secure: true, // TLS implicite sur 993 — pas de STARTTLS à négocier
    auth: {
      user: process.env.IMAP_USER ?? "",
      pass: normalizeAppPassword(process.env.IMAP_PASSWORD ?? ""),
    },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });
}

/** Trouve "All Mail" par son attribut SPECIAL-USE \All, JAMAIS par son nom :
 *  le préfixe est "[Gmail]" ou "[GoogleMail]" selon le compte et le libellé
 *  est traduit ("Tous les messages", "Alle Nachrichten"…). Repli sur INBOX,
 *  qui existe toujours mais ne contient pas les mails archivés. */
async function allMailPath(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  const all = boxes.find((b) => b.specialUse === "\\All");
  if (all) return all.path;
  console.warn("[imap] dossier \\All introuvable — repli sur INBOX (les archivés seront ignorés)");
  return "INBOX";
}

/** Recherche des UID à considérer. X-GM-RAW transporte GMAIL_QUERY tel quel
 *  (même sémantique que l'API), mais il exige la capacité X-GM-EXT-1 : sur un
 *  serveur qui ne l'annonce pas, la lib jette avant même d'émettre la commande. */
async function searchUids(client: ImapFlow): Promise<number[]> {
  const q = gmailQuery();
  const gmail = client.capabilities.has("X-GM-EXT-1");
  const query: SearchObject = gmail ? { gmraw: q } : { since: sinceFromGmailQuery(q) };
  if (!gmail) {
    console.warn(`[imap] X-GM-EXT-1 absent — GMAIL_QUERY dégradée en SINCE, "${q}" partiellement ignorée`);
  }
  // { uid: true } ici ET au fetch : sans lui les nombres renvoyés sont des
  // numéros de SÉQUENCE, réinterprétés ensuite comme des UID → on télécharge
  // silencieusement les mauvais messages.
  const found = await client.search(query, { uid: true });
  // false = commande REFUSÉE par le serveur, ce n'est pas "aucun résultat".
  // Confondre les deux ferait passer un refus pour une boîte vide.
  if (found === false) {
    throw new Error("Recherche IMAP refusée par le serveur (UID SEARCH a répondu NO/BAD)");
  }
  return found;
}

/** Identifiant de dédup d'un message. Priorité à X-GM-MSGID (exposé par la lib
 *  sous emailId, toujours demandé quand X-GM-EXT-1 est là) converti en id API ;
 *  sinon un serveur OBJECTID renvoie un emailId opaque, non décimal, inutile
 *  pour la continuité → on retombe sur le Message-ID de l'en-tête. */
function apiIdOf(msg: FetchMessageObject): string | null {
  const raw = msg.emailId;
  if (!raw || !/^\d+$/.test(raw)) return null;
  return gmMsgIdToApiId(raw);
}

/** Message-ID lu dans le BLOC D'EN-TÊTES uniquement (le corps d'un mail
 *  marketing contient volontiers du texte qui ressemble à un en-tête). */
function messageIdFromRaw(source: Buffer): string | null {
  const head = source.subarray(0, 64 * 1024).toString("utf-8").split(/\r?\n\r?\n/)[0];
  const m = /^message-id:\s*<([^>\r\n]+)>/im.exec(head);
  return m ? m[1] : null;
}

/** Une connexion par appel, refermée dans tous les cas : sur un réplica unique
 *  et long-running, une socket TLS oubliée par synchro finit par saturer la
 *  limite Gmail (15 connexions IMAP simultanées par compte). */
async function withMailbox<T>(
  run: (client: ImapFlow, path: string) => Promise<T>
): Promise<T> {
  const client = newClient();
  await client.connect();
  try {
    const path = await allMailPath(client);
    // readOnly : on ne modifie jamais la vraie boîte de l'utilisateur.
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      return await run(client, path);
    } finally {
      lock.release();
    }
  } finally {
    // logout() est la fermeture polie (BYE) ; si elle échoue la socket est
    // encore ouverte, close() la coupe sans négocier.
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

async function runSync(): Promise<number> {
  return withMailbox(async (client) => {
    const uids = await searchUids(client);
    // Les UID croissent dans l'ordre d'arrivée : la FIN de la liste est la
    // tranche la plus récente. Un slice(0, MAX) prendrait les plus VIEUX.
    const kept = uids.slice(-maxMessages());
    let added = 0;
    if (kept.length === 0) return added;

    const existing = new Set((await Inbox.list()).map((e) => e.providerMessageId));

    // Passe 1 — MÉTADONNÉES SEULES. La lib ajoute X-GM-MSGID d'office à tout
    // FETCH quand la capacité est là, donc cette passe coûte un aller-retour
    // et zéro octet de corps. Sans elle on téléchargerait les ~200 mails
    // complets (des dizaines de Mo) à chaque synchro pour n'en garder aucun.
    const toFetch: number[] = [];
    const apiIds = new Map<number, string>();
    for await (const msg of client.fetch(kept, { uid: true }, { uid: true })) {
      const apiId = apiIdOf(msg);
      if (apiId === null) {
        toFetch.push(msg.uid); // id de dédup indisponible : tranché après lecture
        continue;
      }
      apiIds.set(msg.uid, apiId);
      if (!existing.has(apiId)) toFetch.push(msg.uid);
    }
    if (toFetch.length === 0) return added;

    // Passe 2 — corps complet. source:true compile en BODY.PEEK[] côté lib
    // (lib/commands/fetch.js), donc le flag \Seen n'est pas armé : la boîte
    // réelle de l'utilisateur ne se retrouve pas marquée comme lue.
    for await (const msg of client.fetch(toFetch, { uid: true, source: true }, { uid: true })) {
      if (!msg.source) continue;
      const providerMessageId =
        apiIds.get(msg.uid) ??
        messageIdFromRaw(msg.source) ??
        `uid-${client.mailbox ? client.mailbox.uidValidity : "0"}-${msg.uid}`;
      if (existing.has(providerMessageId)) continue;
      const parsed = await parseMime(msg.source);
      const entry: InboxEmail = {
        // Id DÉTERMINISTE (dérivé du message provider) : deux syncs concurrents
        // écrasent la même entrée au lieu de créer un doublon.
        id: `gm-${providerMessageId}`,
        provider: "gmail",
        providerMessageId,
        subject: parsed.subject,
        from: parsed.from,
        receivedAt: parsed.receivedAt,
        html: parsed.html,
        rawMime: parsed.rawMime,
        headerChecks: parsed.headerChecks,
      };
      await Inbox.put(entry);
      existing.add(providerMessageId);
      added++;
    }
    return added;
  });
}

/** Lit un champ d'une erreur inconnue sans cast : Reflect.get accepte n'importe
 *  quel objet, on ne garde que les scalaires et on les rend en texte. */
function errField(e: unknown, key: string): string {
  if (typeof e !== "object" || e === null) return "";
  const v: unknown = Reflect.get(e, key);
  return typeof v === "string" || typeof v === "boolean" ? String(v) : "";
}

/** Traduction des échecs IMAP en message ACTIONNABLE. Le motif d'erreur de
 *  gmailSync (/invalid_grant|unauthorized|invalid_client/) est propre à OAuth :
 *  il ne reconnaîtrait jamais un échec IMAP, qui parle en codes de réponse
 *  serveur (AUTHENTICATIONFAILED) et en texte anglais libre. */
function describeError(e: unknown): { message: string; display: string } {
  const message = e instanceof Error ? e.message : String(e);
  // Champs posés par imapflow sur ses erreurs (lib/commands/login.js :
  // authenticationFailed, serverResponseCode, response).
  // NB : la classe AuthenticationFailure existe dans le .d.ts mais N'EST PAS
  // exportée à l'exécution en 1.7.6 (`require("imapflow")` ne rend que
  // ImapFlow) — un `instanceof` planterait. D'où la lecture par champ.
  const code = errField(e, "serverResponseCode");
  const response = errField(e, "response");
  const authFailed = errField(e, "authenticationFailed") === "true";
  const hay = `${message} ${code} ${response}`;

  if (/too many simultaneous connections|maximum number of connections/i.test(hay)) {
    return {
      message,
      display:
        "Gmail refuse la connexion IMAP : trop de sessions simultanées (limite 15) — attendre quelques minutes, fermer les autres clients",
    };
  }
  if (/application-specific password required|web login required/i.test(hay)) {
    return {
      message,
      display:
        "Gmail exige un mot de passe d'application : la validation en 2 étapes doit être active, puis générer un mot de passe et le mettre dans IMAP_PASSWORD",
    };
  }
  if (
    authFailed ||
    /AUTHENTICATIONFAILED|invalid credentials|authentication fail/i.test(hay)
  ) {
    return {
      message,
      display:
        "Authentification IMAP refusée — un changement du mot de passe du compte Google RÉVOQUE tous les mots de passe d'application : en régénérer un et mettre à jour IMAP_PASSWORD",
    };
  }
  if (/UNAVAILABLE|expired|not connected|connection closed|socket|ETIMEDOUT|CONNECT_TIMEOUT/i.test(hay)) {
    return {
      message,
      display: "Session IMAP interrompue (réseau ou expiration) — relancer la synchronisation",
    };
  }
  return { message, display: message.slice(0, 200) };
}

// Synchronise les mails récents. Même sémantique que gmailSync() : lire la
// connexion, plafonner à GMAIL_MAX_MESSAGES, dédupliquer sur
// providerMessageId, écrire dans Inbox, mettre à jour Connections.
export async function imapSync(): Promise<{ added: number; error?: string }> {
  if (!imapConfigured()) return { added: 0 };
  const conn = await Connections.get("gmail");
  // Une entrée "disconnected" est un choix EXPLICITE de l'utilisateur
  // (bouton Déconnecter) : on le respecte. En revanche l'ABSENCE d'entrée n'a
  // pas le même sens qu'en OAuth : ici il n'y a pas d'étape de consentement
  // qui la crée, les identifiants viennent de l'environnement — la première
  // synchro crée donc la connexion elle-même.
  if (conn?.status === "disconnected") return { added: 0 };
  const now = new Date().toISOString();
  try {
    const added = await runSync();
    await Connections.put({
      ...conn,
      provider: "gmail",
      email: conn?.email ?? process.env.IMAP_USER,
      connectedAt: conn?.connectedAt ?? now,
      status: "connected",
      lastSyncAt: new Date().toISOString(),
      // Le spread de `conn` retransporte l'erreur du passage précédent : sans
      // cette remise à zéro, une relève réussie laisse à l'écran un message
      // périmé — en l'occurrence « Session Gmail expirée, cliquer sur
      // Reconnecter », qui envoie vers un flux OAuth abandonné.
      error: undefined,
    });
    return { added };
  } catch (e) {
    const { message, display } = describeError(e);
    await Connections.put({
      ...(conn ?? { provider: "gmail" as const }),
      status: "error",
      error: display,
    });
    return { added: 0, error: message };
  }
}

/** Diagnostic : vérifie identifiants + accès au dossier, sans rien écrire.
 *  count = nombre de messages retournés par la recherche GMAIL_QUERY (avant
 *  plafonnement), ce qui vaut réponse à "ma requête vise-t-elle les bons mails". */
export async function imapTest(): Promise<{
  ok: boolean;
  mailbox?: string;
  count?: number;
  error?: string;
}> {
  if (!imapConfigured()) return { ok: false, error: "IMAP_USER / IMAP_PASSWORD non configurés" };
  try {
    const res = await withMailbox(async (client, path) => ({
      mailbox: path,
      count: (await searchUids(client)).length,
    }));
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: describeError(e).display };
  }
}
