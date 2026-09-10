// Sonde IMAP Gmail — tranche EMPIRIQUEMENT l'inconnue n°1 de la migration
// « API Gmail + OAuth » → « IMAP + mot de passe d'application ».
//
// POURQUOI ce script existe : les sources se contredisent. L'une affirme que
// Google n'accepte plus que XOAUTH2 sur imap.gmail.com, l'autre que les mots de
// passe d'application restent l'exception explicitement maintenue. On ne tranche
// pas une contradiction documentaire en lisant une 3e page : on se connecte.
// C'est le CODE RETOUR de ce script qui fait foi, pas sa sortie texte.
//
//   0 = tout a réussi (connexion + \All trouvée + X-GM-EXT-1 + X-GM-RAW)
//   2 = configuration manquante (variables d'environnement)
//   3 = IDENTIFIANTS REFUSÉS (le serveur a répondu, il a dit non)
//   4 = RÉSEAU BLOQUÉ / timeout (le serveur n'a jamais répondu)
//   5 = extension ou boîte \All absente (connexion OK, capacité manquante)
//   6 = erreur inattendue
//
// Usage : node scripts/imap-smoke.mjs
// Aucune dépendance nouvelle : imapflow est déjà dans package.json.
// Ce script est VOLONTAIREMENT autonome — il n'importe pas lib/imap.ts. Un
// harnais qui importe le code qu'il teste n'est plus une mesure, c'est un miroir.

import { promises as fs } from "fs";
import path from "path";
import { ImapFlow } from "imapflow";

const HOST = "imap.gmail.com";
const PORT = 993;
const QUERY = process.env.GMAIL_QUERY || "newer_than:30d";
const BUDGET_MS = 30_000; // la question doit être tranchée en moins de 30 s

// Codes de sortie nommés — un code retour anonyme n'est pas un instrument.
const EXIT = {
  OK: 0,
  CONFIG: 2,
  CREDENTIALS: 3,
  NETWORK: 4,
  EXTENSION: 5,
  UNEXPECTED: 6,
};

// --- .env.local -------------------------------------------------------------
// Le dépôt n'a pas de dotenv (Next.js le charge tout seul côté app) : on parse
// à la main. Les valeurs y sont ÉCRITES ENTRE GUILLEMETS (cf. README) — ne pas
// les retirer donnerait un mot de passe qui commence par un `"`, refusé par le
// serveur, et on conclurait à tort « identifiants invalides ».
// L'environnement réel est PRIORITAIRE sur le fichier : c'est ce qui permet le
// contrôle positif `IMAP_USER=bidon node scripts/imap-smoke.mjs`.
async function loadEnvLocal() {
  let text;
  try {
    text = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf-8");
  } catch {
    return; // absent = normal en CI / en prod Azure
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
      value = value.replace(/\s+#.*$/, "").trim(); // commentaire de fin de ligne
    }
    process.env[key] = value;
  }
}

// --- classification des échecs ----------------------------------------------
// Distinguer « refusé » de « jamais joint » est TOUT l'intérêt du script : les
// deux se ressemblent dans les logs, et ils n'appellent pas la même action.
const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

function classify(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err?.code ?? "";
  const serverCode = err?.serverResponseCode ?? "";
  const response = err?.response ?? "";

  // 1. Le serveur a répondu NON. Cas le plus informatif : Gmail dit précisément
  //    pourquoi (mot de passe simple refusé vs mot de passe d'application faux).
  if (
    err?.authenticationFailed === true ||
    /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED/i.test(String(serverCode)) ||
    /invalid credentials|application-specific password|web login required|username and password not accepted/i.test(
      msg + " " + response
    )
  ) {
    return {
      exit: EXIT.CREDENTIALS,
      titre: "IDENTIFIANTS REFUSÉS",
      detail:
        "Le serveur IMAP a répondu, et il a rejeté le couple utilisateur/mot de passe.\n" +
        "  → Vérifier que c'est bien un MOT DE PASSE D'APPLICATION (16 caractères,\n" +
        "    https://myaccount.google.com/apppasswords) et non le mot de passe du compte.\n" +
        "  → Vérifier que la validation en 2 étapes est active sur le compte.\n" +
        "  → Vérifier que IMAP est activé dans Gmail (Paramètres → Transfert et POP/IMAP).",
    };
  }
  // 2. TLS : le tunnel n'a pas pu s'établir. Ni réseau mort, ni identifiants.
  if (/CERT_|self.signed|unable to verify|SSL routines|EPROTO/i.test(msg + " " + code)) {
    return {
      exit: EXIT.NETWORK,
      titre: "TLS REFUSÉ",
      detail:
        "La négociation TLS a échoué (proxy d'entreprise qui inspecte le trafic ?).\n" +
        "  → Aucune conclusion possible sur les identifiants : ils n'ont pas été envoyés.",
    };
  }
  // 3. Le serveur n'a jamais répondu.
  if (
    NETWORK_CODES.has(code) ||
    /timeout|timed out|getaddrinfo|socket|econn|network/i.test(msg + " " + code)
  ) {
    return {
      exit: EXIT.NETWORK,
      titre: "RÉSEAU BLOQUÉ",
      detail:
        `Impossible d'atteindre ${HOST}:${PORT} (aucune réponse du serveur).\n` +
        "  → Aucune conclusion possible sur les identifiants : ils n'ont pas été testés.\n" +
        "  → Pare-feu / VPN d'entreprise qui ferme le port 993 ?",
    };
  }
  return {
    exit: EXIT.UNEXPECTED,
    titre: "ERREUR INATTENDUE",
    detail: `${msg}${code ? ` (code ${code})` : ""}`,
  };
}

function echec({ exit, titre, detail }) {
  console.error("");
  console.error(`✗ ÉCHEC — ${titre}`);
  console.error(`  ${detail.split("\n").join("\n  ")}`);
  console.error("");
  console.error(`Code retour : ${exit}`);
  process.exit(exit);
}

// --- programme --------------------------------------------------------------
await loadEnvLocal();

const user = (process.env.IMAP_USER || "").trim();
const rawPassword = process.env.IMAP_PASSWORD || "";
// Google AFFICHE le mot de passe d'application en 4 blocs de 4 pour la lisibilité.
// Les espaces ne font PAS partie du secret : les laisser = échec d'authentification
// impossible à distinguer d'un mauvais mot de passe. On les retire toujours.
const password = rawPassword.replace(/\s+/g, "");
const espacesRetires = rawPassword.length - password.length;

const manquantes = [];
if (!user) manquantes.push("IMAP_USER");
if (!password) manquantes.push("IMAP_PASSWORD");
if (manquantes.length > 0) {
  echec({
    exit: EXIT.CONFIG,
    titre: "CONFIGURATION MANQUANTE",
    detail:
      `Variable(s) absente(s) ou vide(s) : ${manquantes.join(", ")}\n` +
      "Rien n'a été testé — ce n'est PAS un verdict sur le mot de passe d'application.\n\n" +
      "  Les renseigner dans .env.local :\n" +
      '    IMAP_USER="adresse@gmail.com"\n' +
      '    IMAP_PASSWORD="abcd efgh ijkl mnop"   # mot de passe d\'application, les espaces sont tolérés\n\n' +
      "  ou en ligne de commande :\n" +
      '    IMAP_USER="adresse@gmail.com" IMAP_PASSWORD="abcdefghijklmnop" node scripts/imap-smoke.mjs',
  });
}

console.log("── Sonde IMAP Gmail ────────────────────────────────────────────");
console.log(`Serveur      : ${HOST}:${PORT} (TLS)`);
console.log(`Utilisateur  : ${user}`);
// Le mot de passe n'est JAMAIS affiché, même partiellement : on n'en publie que
// la forme, qui suffit au diagnostic (« 15 caractères » = une frappe manquée).
console.log(
  `Mot de passe : ${"•".repeat(Math.min(password.length, 32))} ` +
    `(${password.length} caractères, ${espacesRetires} espace(s) retiré(s))`
);
console.log(`Requête      : ${QUERY}`);
console.log("");

// Garde-fou de temps : sans lui, un port filtré fait pendre le script plusieurs
// minutes et la réponse « ça marche ou pas ? » n'arrive jamais.
const watchdog = setTimeout(() => {
  echec({
    exit: EXIT.NETWORK,
    titre: "RÉSEAU BLOQUÉ (budget de 30 s dépassé)",
    detail:
      `Aucune réponse exploitable de ${HOST}:${PORT} en ${BUDGET_MS / 1000} s.\n` +
      "  → Aucune conclusion possible sur les identifiants.",
  });
}, BUDGET_MS);

const client = new ImapFlow({
  host: HOST,
  port: PORT,
  secure: true,
  auth: { user, pass: password },
  logger: false, // sinon imapflow déverse du JSON de debug sur stdout
  // Timeouts serrés : on veut un verdict, pas une attente.
  connectionTimeout: 12_000,
  greetingTimeout: 8_000,
  socketTimeout: 20_000,
});
// imapflow émet 'error' hors des promesses (socket coupée) : sans écouteur,
// Node tue le process avec une stack illisible et un code retour trompeur.
client.on("error", () => {});

try {
  await client.connect();
} catch (err) {
  clearTimeout(watchdog);
  echec(classify(err));
}

// À partir d'ici la connexion est établie ET authentifiée : la question n°1 a
// sa réponse, le reste est de la reconnaissance de terrain.
console.log("✓ Connexion TLS + authentification RÉUSSIES");
console.log("  → le mot de passe d'application est ACCEPTÉ en IMAP par Gmail.");
console.log("");

const problemes = [];
let allPath = null;

try {
  // --- capacités ------------------------------------------------------------
  const caps = [...client.capabilities.keys()].map(String);
  const hasGmExt = caps.some((c) => c.toUpperCase() === "X-GM-EXT-1");
  console.log(`Capacités annoncées : ${caps.length}`);
  console.log(`  X-GM-EXT-1 (extensions Gmail) : ${hasGmExt ? "OUI" : "NON"}`);
  if (!hasGmExt) {
    problemes.push(
      "X-GM-EXT-1 absente : ni X-GM-RAW (traduction de GMAIL_QUERY) ni X-GM-MSGID " +
        "(appariement avec les ids de l'API) ne sont disponibles."
    );
  }
  console.log("");

  // --- boîte \All -----------------------------------------------------------
  // On a besoin du NOM EXACT pour ce compte précis : Gmail traduit le libellé
  // selon la langue du compte (« Tous les messages » / « All Mail ») et le
  // préfixe est tantôt [Gmail], tantôt [GoogleMail]. Le deviner = casser un
  // jour sans prévenir. On lit l'attribut SPECIAL-USE, qui, lui, ne bouge pas.
  const boites = await client.list();
  const all = boites.find((b) => b.specialUse === "\\All");
  console.log(`Mailboxes listées : ${boites.length}`);
  if (all) {
    allPath = all.path;
    console.log(`  Boîte \\All : "${all.path}"`);
    console.log(`    délimiteur   : "${all.delimiter}"`);
    console.log(`    déterminée par : ${all.specialUseSource ?? "?"}`);
    console.log(`    abonnée      : ${all.subscribed ? "oui" : "non"}`);
  } else {
    console.log("  Boîte \\All : INTROUVABLE");
    problemes.push(
      'Aucune mailbox ne porte l\'attribut SPECIAL-USE "\\All". La case ' +
        '« Afficher dans IMAP » de "Tous les messages" est probablement décochée ' +
        "dans les paramètres Gmail — sans elle, IMAP ne voit pas les archives."
    );
  }
  console.log("");

  // --- recherche ------------------------------------------------------------
  if (allPath) {
    const lock = await client.getMailboxLock(allPath, { readOnly: true });
    try {
      console.log(`Boîte ouverte : "${allPath}" (${client.mailbox.exists} messages)`);

      // (a) X-GM-RAW : la traduction fidèle de GMAIL_QUERY. C'est ce qui permet
      //     de garder la même requête qu'avec l'API après la migration.
      let nRaw = null;
      let rawErreur = null;
      try {
        const uids = await client.search({ gmraw: QUERY }, { uid: true });
        if (uids === false) throw new Error("le serveur a refusé la recherche (réponse NO)");
        nRaw = uids.length;
      } catch (err) {
        rawErreur = err instanceof Error ? err.message : String(err);
      }

      // (b) SINCE : le repli portable, TOUJOURS mesuré, même quand (a) marche.
      //     Deux comptes valent mieux qu'un : leur écart dit ce que la requête
      //     Gmail filtre en plus de la date (labels, corbeille, spam…).
      const depuis = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let nSince = null;
      let sinceErreur = null;
      try {
        const uids = await client.search({ since: depuis }, { uid: true });
        if (uids === false) throw new Error("le serveur a refusé la recherche (réponse NO)");
        nSince = uids.length;
      } catch (err) {
        sinceErreur = err instanceof Error ? err.message : String(err);
      }

      if (nRaw !== null) {
        console.log(`  UID SEARCH X-GM-RAW "${QUERY}"  → ${nRaw} UID`);
      } else {
        console.log(`  UID SEARCH X-GM-RAW "${QUERY}"  → INDISPONIBLE`);
        console.log(`    motif : ${rawErreur}`);
        problemes.push(
          `X-GM-RAW inutilisable (${rawErreur}) : la requête "${QUERY}" ne peut pas ` +
            "être transposée telle quelle en IMAP, il faudra la réécrire."
        );
      }
      if (nSince !== null) {
        console.log(
          `  UID SEARCH SINCE ${depuis.toISOString().slice(0, 10)} → ${nSince} UID  (repli portable)`
        );
      } else {
        console.log(`  UID SEARCH SINCE → INDISPONIBLE (${sinceErreur})`);
        problemes.push(`Le repli SINCE échoue aussi : ${sinceErreur}`);
      }
      if (nRaw !== null && nSince !== null) {
        const ecart = nSince - nRaw;
        console.log(
          `  Écart SINCE − X-GM-RAW : ${ecart >= 0 ? "+" : ""}${ecart} ` +
            `(SINCE ne filtre QUE sur la date : il ratisse plus large dès que ` +
            `"${QUERY}" contient autre chose qu'un critère de date)`
        );
      }
    } finally {
      lock.release();
    }
    console.log("");
  }
} catch (err) {
  clearTimeout(watchdog);
  try {
    await client.logout();
  } catch {
    client.close();
  }
  echec(classify(err));
}

// --- déconnexion propre -----------------------------------------------------
// logout() envoie LOGOUT et attend le BYE ; close() coupe le TCP sans prévenir.
// Le repli existe parce qu'un logout() sur socket déjà morte rejette, et on ne
// veut pas qu'une déconnexion ratée maquille un test réussi en échec.
try {
  await client.logout();
  console.log("✓ Déconnexion propre (LOGOUT)");
} catch {
  client.close();
  console.log("~ LOGOUT impossible — socket fermée en repli (close())");
}
clearTimeout(watchdog);

console.log("");
if (problemes.length > 0) {
  console.error("✗ ÉCHEC PARTIEL — EXTENSION / BOÎTE MANQUANTE");
  console.error("  L'authentification a RÉUSSI, mais tout n'est pas exploitable :");
  for (const p of problemes) console.error(`   • ${p}`);
  console.error("");
  console.error(`Code retour : ${EXIT.EXTENSION}`);
  process.exit(EXIT.EXTENSION);
}

console.log("✓ SUCCÈS — mot de passe d'application accepté, \\All trouvée,");
console.log("  X-GM-EXT-1 annoncée, X-GM-RAW opérationnelle.");
console.log(`Code retour : ${EXIT.OK}`);
process.exit(EXIT.OK);
