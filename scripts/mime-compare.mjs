// Comparateur MIME « API Gmail » vs « IMAP » — mesure l'hypothèse centrale de
// la migration : « le MIME est le même des deux côtés ».
//
// POURQUOI ce script existe : lib/auth-results.ts pose le verdict SPF/DKIM/DMARC
// en ne lisant QUE le bloc d'en-têtes de premier niveau du MIME brut, et ce
// verdict est consommé en dur ailleurs dans Sentinel. Si IMAP renvoie un bloc
// d'en-têtes différent de celui de l'API — un Authentication-Results en moins,
// des Received réordonnés — le verdict ne devient pas INDISPONIBLE, il devient
// FAUX : `trusted` retombe sur le premier en-tête venu, c'est-à-dire, sur un
// message spoofé, sur celui que l'expéditeur a forgé lui-même. Un anti-spoofing
// silencieusement désarmé est pire que pas d'anti-spoofing.
// Tant que ce n'est pas mesuré, « c'est le même MIME » est une hypothèse.
//
//   0 = les N messages sont identiques OCTET POUR OCTET
//   1 = au moins un message diffère (voir le tableau)
//   2 = configuration manquante
//   3 = refresh token OAuth absent ou expiré → comparaison IMPOSSIBLE
//   4 = échec réseau / IMAP
//   5 = appariement impossible (X-GM-MSGID introuvable)
//   6 = erreur inattendue
//   7 = la garde de conversion décimal↔hexadécimal a mordu
//
// Usage : node scripts/mime-compare.mjs [N]        (N = 5 par défaut)
// Ce script est VOLONTAIREMENT autonome : il n'importe ni lib/gmail.ts, ni
// lib/imap.ts, ni lib/auth-results.ts. Un harnais qui importe le code qu'il
// teste n'est plus une mesure indépendante, c'est un miroir.

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { ImapFlow } from "imapflow";
import { google } from "googleapis";

const HOST = "imap.gmail.com";
const PORT = 993;

const EXIT = {
  OK: 0,
  DIFFERENT: 1,
  CONFIG: 2,
  TOKEN: 3,
  NETWORK: 4,
  APPARIEMENT: 5,
  UNEXPECTED: 6,
  GARDE: 7,
};

function echec(exit, titre, detail) {
  console.error("");
  console.error(`✗ ÉCHEC — ${titre}`);
  console.error(`  ${String(detail).split("\n").join("\n  ")}`);
  console.error("");
  console.error(`Code retour : ${exit}`);
  process.exit(exit);
}

// ───────────────────────────────────────────────────────────────────────────
// GARDE 0 — conversion de l'identifiant Gmail
// ───────────────────────────────────────────────────────────────────────────
// L'appariement API↔IMAP repose ENTIÈREMENT sur un changement de base :
// l'API Gmail donne l'id du message en HEXADÉCIMAL ("18c3f…"), l'extension
// IMAP X-GM-MSGID le donne en DÉCIMAL. BigInt fait le pont — mais un pont non
// vérifié apparie silencieusement les mauvais messages, et le script conclurait
// alors « MIME différent » pour la seule raison qu'il compare deux mails
// distincts. On vérifie donc AVANT de s'en servir, sur des valeurs codées en
// dur, avec sortie en erreur si ça ne tombe pas juste.
//
// ⚠️ Le couple qui circule dans les notes de migration,
//    1278455344230334865 → 11bd1ea6a4b0e451, N'EST PAS un couple : ces deux
//    nombres désignent deux messages différents (mesuré, cf. GARDE 0.c).
//    La valeur correcte est ci-dessous. Ne pas réintroduire l'autre.
const DEC_TEMOIN = "1278455344230334865";
const HEX_TEMOIN = "11bdfc5cae0c8191"; // vérifié indépendamment, pas recopié
const HEX_FAUTIF = "11bd1ea6a4b0e451"; // valeur MORTE, conservée pour la détecter
const DEC_DU_HEX_FAUTIF = "1278211570319549521";

/** hex (API Gmail) → décimal (X-GM-MSGID). */
const hexVersDec = (hex) => BigInt("0x" + hex).toString(10);
/** décimal (X-GM-MSGID) → hex (API Gmail). */
const decVersHex = (dec) => BigInt(dec).toString(16);

function gardeConversion() {
  console.log("── GARDE 0 : conversion identifiant Gmail décimal ↔ hexadécimal ──");
  const obtenu = decVersHex(DEC_TEMOIN);
  console.log(`  BigInt("${DEC_TEMOIN}").toString(16)`);
  console.log(`    obtenu  = ${obtenu}`);
  console.log(`    attendu = ${HEX_TEMOIN}`);
  if (obtenu !== HEX_TEMOIN) {
    echec(
      EXIT.GARDE,
      "GARDE DE CONVERSION",
      `décimal→hexadécimal a rendu "${obtenu}" au lieu de "${HEX_TEMOIN}" ` +
        `pour l'entrée "${DEC_TEMOIN}". Aucun appariement API↔IMAP n'est fiable ` +
        "dans ces conditions."
    );
  }
  // Aller-retour : teste le sens INVERSE, celui réellement utilisé (hex→déc).
  const retour = hexVersDec(obtenu);
  console.log(`  aller-retour hex→déc : ${retour} ${retour === DEC_TEMOIN ? "= entrée ✓" : "≠ entrée ✗"}`);
  if (retour !== DEC_TEMOIN) {
    echec(
      EXIT.GARDE,
      "GARDE DE CONVERSION",
      `hexadécimal→décimal a rendu "${retour}" au lieu de "${DEC_TEMOIN}".`
    );
  }
  // (c) Le couple fautif des notes de migration : on MESURE qu'il désigne un
  //     autre message, plutôt que d'affirmer en prose qu'il est faux.
  const decFautif = hexVersDec(HEX_FAUTIF);
  console.log(`  couple des notes de migration → ${HEX_FAUTIF} vaut ${decFautif} en décimal,`);
  console.log(
    `    soit ${decFautif === DEC_TEMOIN ? "LE MÊME" : "un AUTRE"} message que ${DEC_TEMOIN} ` +
      `(écart ${(BigInt(DEC_TEMOIN) - BigInt(decFautif)).toString()})`
  );
  if (decFautif !== DEC_DU_HEX_FAUTIF) {
    echec(
      EXIT.GARDE,
      "GARDE DE CONVERSION",
      `"${HEX_FAUTIF}" a rendu "${decFautif}" au lieu de "${DEC_DU_HEX_FAUTIF}".`
    );
  }
  console.log("  ✓ garde passée — le pont hex↔déc est utilisable.");
  console.log("");
}

// ───────────────────────────────────────────────────────────────────────────
// .env.local (même parseur que scripts/imap-smoke.mjs — DUPLIQUÉ À DESSEIN :
// les deux scripts doivent rester exécutables isolément, sans module commun
// dont une régression casserait les deux mesures en même temps.)
// ───────────────────────────────────────────────────────────────────────────
async function loadEnvLocal() {
  let text;
  try {
    text = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf-8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // l'env réel gagne
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[key] = value;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Découpage MIME — réimplémenté ICI, indépendamment de lib/auth-results.ts.
// ───────────────────────────────────────────────────────────────────────────
// latin1 et pas utf8 : on veut un octet = un caractère. En utf8, deux MIME
// différents sur des octets invalides se ramèneraient au même U+FFFD et le
// diff d'en-têtes raterait la différence qu'on cherche précisément à voir.
const enTexte = (buf) => buf.toString("latin1");

/** Sépare le bloc d'en-têtes TOP-LEVEL du corps (arrêt à la 1re ligne vide).
 *  C'est la règle anti-spoofing de lib/auth-results.ts : les en-têtes d'une
 *  pièce jointe message/rfc822 sont exclus par construction. */
function blocEnTetes(buf) {
  const s = enTexte(buf);
  const m = /\r?\n\r?\n/.exec(s);
  return m ? s.slice(0, m.index) : s;
}

/** En-têtes DÉPLIÉS (les continuations « \n<espace> » sont recollées), dans
 *  l'ordre du message. Le premier de la liste = le dernier hop = celui que le
 *  récepteur a prépendu, donc le seul digne de confiance. */
function enTetes(buf) {
  const lignes = blocEnTetes(buf).split(/\r?\n/);
  const out = [];
  let courant = null;
  for (const ligne of lignes) {
    if (/^[ \t]/.test(ligne)) {
      if (courant !== null) courant += " " + ligne.trim();
      continue;
    }
    if (courant !== null) out.push(courant);
    courant = ligne === "" ? null : ligne;
  }
  if (courant !== null) out.push(courant);
  return out;
}

const nomDe = (h) => h.slice(0, Math.max(h.indexOf(":"), 0)).toLowerCase();
const valeurDe = (h) => h.slice(h.indexOf(":") + 1).trim();
const valeursDe = (liste, nom) =>
  liste.filter((h) => nomDe(h) === nom).map(valeurDe);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Diff LIGNE À LIGNE des seuls en-têtes (multi-ensembles : un en-tête présent
 *  3 fois d'un côté et 2 fois de l'autre compte pour 1 de différence).
 *  Le corps est délibérément exclu : illisible, et sans effet sur le verdict
 *  d'authentification. */
function diffEnTetes(a, b) {
  const compte = (liste) => {
    const m = new Map();
    for (const h of liste) m.set(h, (m.get(h) ?? 0) + 1);
    return m;
  };
  const ma = compte(a);
  const mb = compte(b);
  const seulA = [];
  const seulB = [];
  for (const [h, n] of ma) {
    const d = n - (mb.get(h) ?? 0);
    for (let i = 0; i < d; i++) seulA.push(h);
  }
  for (const [h, n] of mb) {
    const d = n - (ma.get(h) ?? 0);
    for (let i = 0; i < d; i++) seulB.push(h);
  }
  return { seulA, seulB };
}

const tronque = (s, n = 150) => (s.length > n ? s.slice(0, n) + " …" : s);

// ───────────────────────────────────────────────────────────────────────────
// Programme
// ───────────────────────────────────────────────────────────────────────────
gardeConversion();

const N = Math.max(1, Number(process.argv[2]) || 5);
await loadEnvLocal();

const QUERY = process.env.GMAIL_QUERY || "newer_than:30d";

// --- 1. côté API Gmail ------------------------------------------------------
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  const abs = [];
  if (!clientId) abs.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) abs.push("GOOGLE_CLIENT_SECRET");
  echec(
    EXIT.CONFIG,
    "CONFIGURATION OAUTH MANQUANTE",
    `Variable(s) absente(s) : ${abs.join(", ")}\n` +
      "Sans elles, impossible d'interroger l'API Gmail : la comparaison ne peut\n" +
      "pas avoir lieu. Rien n'a été mesuré."
  );
}

// Le refresh token est écrit par lib/store.ts (Tokens.put("gmail", …)) dans
// ${DATA_DIR}/tokens/gmail.json en local. On le LIT sans importer le store :
// un fichier JSON de 3 champs ne justifie pas de tirer le TypeScript de l'app.
const DATA_DIR = process.env.DATA_DIR || ".data";
// resolve et pas join : un DATA_DIR ABSOLU doit rester absolu. path.join le
// recollerait derrière cwd et le message d'erreur citerait un chemin qui
// n'existe nulle part — un diagnostic faux est pire qu'un diagnostic absent.
const cheminToken = path.resolve(process.cwd(), DATA_DIR, "tokens", "gmail.json");
let refreshToken = process.env.GMAIL_REFRESH_TOKEN || "";
if (!refreshToken) {
  try {
    const j = JSON.parse(await fs.readFile(cheminToken, "utf-8"));
    refreshToken = j.refreshToken || "";
  } catch {
    refreshToken = "";
  }
}
if (!refreshToken) {
  echec(
    EXIT.TOKEN,
    "AUCUN REFRESH TOKEN GMAIL",
    `Rien à lire dans ${cheminToken} (ni dans GMAIL_REFRESH_TOKEN).\n\n` +
      "LA COMPARAISON EST IMPOSSIBLE sans reconnexion : ce script a besoin des\n" +
      "DEUX côtés (API + IMAP) pour comparer quoi que ce soit. Il n'y a pas de\n" +
      "demi-mesure ici — un seul côté ne prouve rien.\n\n" +
      "  → Lancer l'app (npm run dev) puis se reconnecter à Gmail depuis l'UI\n" +
      "    (Connexions → Gmail → Reconnecter), et relancer ce script."
  );
}

const oauth = new google.auth.OAuth2(
  clientId,
  clientSecret,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/auth/google/callback"
);
oauth.setCredentials({ refresh_token: refreshToken });

console.log("── Comparaison MIME : API Gmail vs IMAP ────────────────────────");
console.log(`Échantillon  : ${N} message(s) les plus récents`);
console.log(`Requête      : ${QUERY}`);
console.log(`Refresh token: lu depuis ${refreshToken === process.env.GMAIL_REFRESH_TOKEN ? "GMAIL_REFRESH_TOKEN" : cheminToken} (non affiché)`);
console.log("");

// Le refresh token du mode « Testing » Google expire au bout de ~7 jours. On
// le teste TOUT DE SUITE, avant de toucher à IMAP : échouer après 20 s de
// travail inutile est une perte de temps, et surtout le message d'erreur
// arriverait noyé au milieu d'une sortie qui a l'air de fonctionner.
try {
  await oauth.getAccessToken();
  console.log("✓ Jeton d'accès Gmail obtenu (refresh token encore valide)");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = err?.response?.data?.error ?? "";
  if (/invalid_grant|expired|revoked|unauthorized_client/i.test(msg + " " + detail)) {
    echec(
      EXIT.TOKEN,
      "REFRESH TOKEN GMAIL EXPIRÉ OU RÉVOQUÉ",
      `Google répond : ${detail || msg}\n\n` +
        "LA COMPARAISON EST IMPOSSIBLE sans reconnexion. C'est le comportement\n" +
        "ATTENDU du mode « Testing » de Google : le refresh token y expire tous\n" +
        "les 7 jours — c'est d'ailleurs exactement la raison d'être de cette\n" +
        "migration vers IMAP.\n\n" +
        "  → Lancer l'app (npm run dev), Connexions → Gmail → Reconnecter,\n" +
        "    puis relancer ce script DANS LA FOULÉE.\n\n" +
        "Aucune comparaison n'a été faite. Ne pas conclure que les MIME\n" +
        "concordent : ils n'ont pas été regardés."
    );
  }
  echec(EXIT.UNEXPECTED, "APPEL OAUTH IMPOSSIBLE", msg);
}

const gmail = google.gmail({ version: "v1", auth: oauth });

let idsApi = [];
try {
  const liste = await gmail.users.messages.list({ userId: "me", q: QUERY, maxResults: N });
  idsApi = (liste.data.messages ?? []).map((m) => m.id).filter(Boolean).slice(0, N);
} catch (err) {
  echec(EXIT.UNEXPECTED, "LISTAGE API GMAIL IMPOSSIBLE", err instanceof Error ? err.message : String(err));
}
if (idsApi.length === 0) {
  echec(
    EXIT.CONFIG,
    "AUCUN MESSAGE À COMPARER",
    `La requête "${QUERY}" ne remonte aucun message côté API. Rien n'a été mesuré.\n` +
      "  → Élargir GMAIL_QUERY, ou vérifier que la boîte n'est pas vide."
  );
}

const cote = new Map(); // id hex → { api, imap, uid }
for (const id of idsApi) {
  try {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
    // base64url et PAS base64 : l'API Gmail substitue -/_ à +/. Se tromper de
    // variante produit un Buffer silencieusement corrompu — pas une exception.
    // (lib/gmail.ts fait exactement le même décodage.)
    cote.set(id, { api: Buffer.from(msg.data.raw ?? "", "base64url"), imap: null, uid: null });
  } catch (err) {
    echec(
      EXIT.UNEXPECTED,
      "TÉLÉCHARGEMENT API IMPOSSIBLE",
      `message ${id} : ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
console.log(`✓ API Gmail : ${cote.size} message(s) récupérés en format=raw`);

// --- 2. côté IMAP -----------------------------------------------------------
const user = (process.env.IMAP_USER || "").trim();
const password = (process.env.IMAP_PASSWORD || "").replace(/\s+/g, ""); // cf. imap-smoke.mjs
if (!user || !password) {
  const abs = [];
  if (!user) abs.push("IMAP_USER");
  if (!password) abs.push("IMAP_PASSWORD");
  echec(
    EXIT.CONFIG,
    "CONFIGURATION IMAP MANQUANTE",
    `Variable(s) absente(s) ou vide(s) : ${abs.join(", ")}\n` +
      "Le côté API a été récupéré, mais il n'y a rien à quoi le comparer.\n" +
      "  → Créer un mot de passe d'application : https://myaccount.google.com/apppasswords\n" +
      "  → Le vérifier d'abord avec : node scripts/imap-smoke.mjs"
  );
}

const client = new ImapFlow({
  host: HOST,
  port: PORT,
  secure: true,
  auth: { user, pass: password },
  logger: false,
  connectionTimeout: 15_000,
  greetingTimeout: 8_000,
  socketTimeout: 60_000, // les téléchargements complets sont plus longs qu'un SEARCH
});
client.on("error", () => {});

try {
  await client.connect();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (err?.authenticationFailed === true || /AUTHENTICATIONFAILED|invalid credentials/i.test(msg)) {
    echec(
      EXIT.TOKEN,
      "IDENTIFIANTS IMAP REFUSÉS",
      `${msg}\n  → Diagnostiquer avec : node scripts/imap-smoke.mjs`
    );
  }
  echec(EXIT.NETWORK, "CONNEXION IMAP IMPOSSIBLE", `${msg}\n  → Diagnostiquer avec : node scripts/imap-smoke.mjs`);
}
console.log("✓ IMAP : connecté et authentifié");

let resultats = [];
let lock = null;
try {
  // \All et pas INBOX : l'API interroge TOUT le compte (archives, envoyés).
  // Comparer contre INBOX seule raterait la moitié de l'échantillon et on
  // conclurait « IMAP ne voit pas ces messages » alors qu'on a mal cherché.
  const boites = await client.list();
  const all = boites.find((b) => b.specialUse === "\\All");
  if (!all) {
    echec(
      EXIT.APPARIEMENT,
      "BOÎTE \\All INTROUVABLE",
      'Aucune mailbox SPECIAL-USE "\\All" — « Tous les messages » n\'est pas exposée en IMAP.\n' +
        "  → Gmail → Paramètres → Transfert et POP/IMAP → cocher « Afficher dans IMAP »."
    );
  }
  console.log(`✓ IMAP : boîte \\All = "${all.path}"`);

  lock = await client.getMailboxLock(all.path, { readOnly: true });

  // Appariement par X-GM-MSGID. On construit la table dans le sens IMAP→API en
  // UNE passe sur les messages récents, plutôt qu'une recherche par message :
  // une table explicite se relit et se vérifie, une recherche opaque non.
  const total = client.mailbox.exists;
  const fenetre = 400; // large devant N, assez petit pour rester rapide
  const debut = Math.max(1, total - fenetre + 1);
  const tableImap = new Map(); // décimal X-GM-MSGID → uid
  if (total > 0) {
    for await (const m of client.fetch(`${debut}:*`, { uid: true, emailId: true })) {
      if (m.emailId) tableImap.set(String(m.emailId), m.uid);
    }
  }
  console.log(`✓ IMAP : ${tableImap.size} X-GM-MSGID indexés (fenêtre des ${fenetre} derniers sur ${total})`);

  const introuvables = [];
  for (const [id, e] of cote) {
    const dec = hexVersDec(id);
    let uid = tableImap.get(dec) ?? null;
    if (uid === null) {
      // Hors fenêtre : recherche ciblée. imapflow traduit `emailId` en
      // X-GM-MSGID quand le serveur annonce X-GM-EXT-1 (pas OBJECTID).
      try {
        const trouve = await client.search({ emailId: dec }, { uid: true });
        if (Array.isArray(trouve) && trouve.length > 0) uid = trouve[0];
      } catch {
        // laissé à null → compté comme introuvable, jamais deviné
      }
    }
    if (uid === null) {
      introuvables.push({ id, dec });
      continue;
    }
    e.uid = uid;
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) {
      introuvables.push({ id, dec });
      continue;
    }
    e.imap = msg.source;
  }

  if (introuvables.length > 0) {
    console.log("");
    console.error("✗ Messages non appariés (X-GM-MSGID introuvable côté IMAP) :");
    for (const x of introuvables) console.error(`   • API id ${x.id}  (décimal ${x.dec})`);
    console.error("  Causes possibles : message dans la Corbeille/Spam (hors \\All),");
    console.error("  ou X-GM-EXT-1 non annoncée par le serveur.");
  }

  // --- 3. comparaison -------------------------------------------------------
  for (const [id, e] of cote) {
    if (!e.imap) {
      resultats.push({ id, apparie: false });
      continue;
    }
    const hApi = sha256(e.api);
    const hImap = sha256(e.imap);
    const identique = hApi === hImap;

    const enApi = enTetes(e.api);
    const enImap = enTetes(e.imap);

    // Deuxième mesure, distincte de la première : une différence qui n'est QUE
    // des fins de ligne (l'API rend parfois du LF là où IMAP impose CRLF) n'a
    // aucun effet sur le verdict SPF/DKIM/DMARC, alors qu'une différence
    // d'en-têtes en a un. Les confondre ferait paniquer pour rien, ou rassurer
    // à tort. On publie les deux.
    const normApi = enTexte(e.api).replace(/\r\n/g, "\n");
    const normImap = enTexte(e.imap).replace(/\r\n/g, "\n");
    const identiqueNorm = normApi === normImap;

    const arApi = valeursDe(enApi, "authentication-results");
    const arImap = valeursDe(enImap, "authentication-results");
    const arIdentique =
      arApi.length === arImap.length && arApi.every((v, i) => v === arImap[i]);
    const recApi = valeursDe(enApi, "received");
    const recImap = valeursDe(enImap, "received");
    const recIdentique =
      recApi.length === recImap.length && recApi.every((v, i) => v === recImap[i]);

    resultats.push({
      id,
      apparie: true,
      uid: e.uid,
      identique,
      identiqueNorm,
      octetsApi: e.api.length,
      octetsImap: e.imap.length,
      nApi: enApi.length,
      nImap: enImap.length,
      arApi,
      arImap,
      arIdentique,
      recApi,
      recImap,
      recIdentique,
      hApi,
      hImap,
      diff: identique ? null : diffEnTetes(enApi, enImap),
    });
  }
} catch (err) {
  if (lock) lock.release();
  try {
    await client.logout();
  } catch {
    client.close();
  }
  echec(EXIT.UNEXPECTED, "COMPARAISON INTERROMPUE", err instanceof Error ? err.message : String(err));
} finally {
  if (lock) lock.release();
}

try {
  await client.logout();
} catch {
  client.close();
}

// --- 4. restitution ---------------------------------------------------------
console.log("");
console.log("── Détail par message ──────────────────────────────────────────");
for (const r of resultats) {
  console.log("");
  if (!r.apparie) {
    console.log(`■ ${r.id} — NON APPARIÉ, non comparé`);
    continue;
  }
  console.log(`■ ${r.id}  (UID IMAP ${r.uid})`);
  console.log(`  sha256 API  : ${r.hApi}  (${r.octetsApi} octets)`);
  console.log(`  sha256 IMAP : ${r.hImap}  (${r.octetsImap} octets)`);
  console.log(`  identique octet pour octet : ${r.identique ? "OUI" : "NON"}`);
  if (!r.identique) {
    console.log(`  identique après normalisation CRLF→LF : ${r.identiqueNorm ? "OUI" : "NON"}`);
    const { seulA, seulB } = r.diff;
    if (seulA.length === 0 && seulB.length === 0) {
      console.log("  → les en-têtes sont IDENTIQUES : la différence est dans le CORPS.");
    } else {
      console.log(`  → diff des en-têtes (${seulA.length} côté API, ${seulB.length} côté IMAP) :`);
      for (const h of seulA) console.log(`      - API  : ${tronque(h)}`);
      for (const h of seulB) console.log(`      + IMAP : ${tronque(h)}`);
    }
  }
  // Le bloc qui décide du verdict anti-spoofing de lib/auth-results.ts.
  console.log(`  Authentication-Results : API ${r.arApi.length} / IMAP ${r.arImap.length} — ${r.arIdentique ? "IDENTIQUES" : "DIFFÉRENTS"}`);
  if (!r.arIdentique) {
    for (const v of r.arApi) console.log(`      - API  : ${tronque(v, 200)}`);
    for (const v of r.arImap) console.log(`      + IMAP : ${tronque(v, 200)}`);
  } else if (r.arApi.length > 0) {
    console.log(`      = ${tronque(r.arApi[0], 200)}`);
  }
  console.log(`  Received : API ${r.recApi.length} / IMAP ${r.recImap.length} — ${r.recIdentique ? "IDENTIQUES" : "DIFFÉRENTS"}`);
  if (!r.recIdentique) {
    for (const v of r.recApi) console.log(`      - API  : ${tronque(v)}`);
    for (const v of r.recImap) console.log(`      + IMAP : ${tronque(v)}`);
  }
}

console.log("");
console.log("── Récapitulatif ───────────────────────────────────────────────");
console.log("id                 | identique | en-têtes API | en-têtes IMAP | A-R identique");
console.log("-------------------+-----------+--------------+---------------+--------------");
for (const r of resultats) {
  if (!r.apparie) {
    console.log(`${r.id.padEnd(18)} | ${"N/A".padEnd(9)} | ${"—".padEnd(12)} | ${"—".padEnd(13)} | ${"—"}`);
    continue;
  }
  console.log(
    `${r.id.padEnd(18)} | ${(r.identique ? "OUI" : "NON").padEnd(9)} | ` +
      `${String(r.nApi).padEnd(12)} | ${String(r.nImap).padEnd(13)} | ` +
      `${r.arIdentique ? "OUI" : "NON"}`
  );
}
console.log("");

const nonApparies = resultats.filter((r) => !r.apparie).length;
const differents = resultats.filter((r) => r.apparie && !r.identique).length;
const arDifferents = resultats.filter((r) => r.apparie && !r.arIdentique).length;

// La conclusion qui compte pour Sentinel : ce n'est pas l'égalité des octets,
// c'est la survie du verdict anti-spoofing.
if (arDifferents > 0) {
  console.log(`⚠ ${arDifferents}/${resultats.length} message(s) ont un Authentication-Results DIFFÉRENT.`);
  console.log("  Le verdict SPF/DKIM/DMARC de lib/auth-results.ts changerait après migration.");
  console.log("  Il ne deviendrait pas indisponible : il deviendrait FAUX. À traiter avant bascule.");
} else if (resultats.some((r) => r.apparie)) {
  console.log("✓ Authentication-Results identique sur tous les messages appariés :");
  console.log("  le verdict anti-spoofing de lib/auth-results.ts survit à la migration");
  console.log(`  (mesuré sur n=${resultats.length - nonApparies}, pas sur la boîte entière).`);
}
console.log("");

if (nonApparies > 0) {
  echec(
    EXIT.APPARIEMENT,
    "APPARIEMENT INCOMPLET",
    `${nonApparies}/${resultats.length} message(s) n'ont pas pu être retrouvés côté IMAP.\n` +
      "La comparaison est PARTIELLE — elle ne prouve rien sur ces messages-là."
  );
}
if (differents > 0) {
  echec(
    EXIT.DIFFERENT,
    "MIME DIFFÉRENTS",
    `${differents}/${resultats.length} message(s) diffèrent entre l'API et IMAP.\n` +
      "Voir le détail ci-dessus : la nature de la différence (fins de ligne, en-têtes\n" +
      "ajoutés, Received réordonnés) décide de la gravité."
  );
}

console.log(`✓ SUCCÈS — les ${resultats.length} message(s) sont identiques octet pour octet.`);
console.log(`Code retour : ${EXIT.OK}`);
process.exit(EXIT.OK);
