// Vérification SPF/DKIM/DMARC depuis l'en-tête Authentication-Results (RFC 8601)
// du mail REÇU : on lit le verdict posé par le récepteur (Gmail `mx.google.com`,
// Outlook), on ne re-vérifie JAMAIS en DNS à l'analyse — le verdict du header est
// figé à la réception (idempotent), alors qu'une re-vérification diverge dès que
// les sélecteurs DKIM tournent. Parser volontairement TOLÉRANT, pas strict RFC :
// Outlook.com viole la RFC 8601 (pas d'authserv-id, `action=`/`reason=` sans
// ptype, méthode propriétaire `compauth`).
//
// Anti-spoofing : un expéditeur peut inclure son propre Authentication-Results
// forgé. Les récepteurs PRÉPENDENT le leur (champ de trace, jamais réordonné)
// → on retient le premier en-tête (le plus haut) dont l'authserv-id correspond
// à la source d'ingestion ; sinon confiance dégradée (trusted=false).

import type { AuthResultsSummary, EmailVersion } from "./types";

export type AuthSource = EmailVersion["source"];

const KNOWN_METHODS = new Set([
  "spf",
  "dkim",
  "dmarc",
  "arc",
  "compauth",
  "dkim-adsp",
  "iprev",
  "auth",
  "bimi",
]);

interface AuthMethodResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

export interface ParsedAuthResults {
  authservId: string | null;
  results: AuthMethodResult[];
  raw: string;
}

/** Retire les commentaires CFWS `(...)` (imbriqués, non fermés = jusqu'à la fin).
 *  Boucle à compteur de profondeur — pas de regex, donc pas de backtracking. */
function stripComments(v: string): string {
  let out = "";
  let depth = 0;
  for (const c of v) {
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

export function parseAuthenticationResults(raw: string): ParsedAuthResults {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  const clean = stripComments(unfolded).replace(/\s+/g, " ").trim();
  const segments = clean.split(";").map((s) => s.trim()).filter(Boolean);

  let authservId: string | null = null;
  const results: AuthMethodResult[] = [];
  let current: AuthMethodResult | null = null;

  segments.forEach((seg, i) => {
    // 1er segment sans "=" = authserv-id (+ version éventuelle "mx.microsoft.com 1").
    // Absent chez Outlook.com : le header commence directement par "spf=…".
    if (i === 0 && !seg.includes("=")) {
      authservId = seg.split(" ")[0]?.toLowerCase() ?? null;
      return;
    }
    for (const token of seg.split(" ")) {
      const eq = token.indexOf("=");
      if (eq === -1) continue; // "none" header-level, ou débris — pas de résultat
      const key = token.slice(0, eq).toLowerCase();
      const value = token.slice(eq + 1);
      if (KNOWN_METHODS.has(key)) {
        current = { method: key, result: value.toLowerCase().slice(0, 40), props: {} };
        results.push(current);
      } else if (current) {
        // Propriété RFC (header.d=, smtp.mailfrom=…) ou hors-ptype Outlook (action=, reason=)
        current.props[key] = value.slice(0, 200);
      }
    }
  });

  return { authservId, results, raw: unfolded.trim() };
}

/** Toutes les valeurs Authentication-Results du bloc d'en-têtes TOP-LEVEL du MIME,
 *  dans l'ordre du message (le plus haut = dernier hop). Les parties message/rfc822
 *  attachées sont exclues par construction (arrêt à la première ligne vide). */
export function extractAuthHeaders(rawMime: string): string[] {
  const head = rawMime.slice(0, 64 * 1024);
  const found: string[] = [];
  let current: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (line === "") break; // fin du bloc d'en-têtes
    if (/^[ \t]/.test(line)) {
      if (current !== null) current += " " + line.trim();
      continue;
    }
    if (current !== null) {
      found.push(current);
      current = null;
    }
    const m = /^authentication-results:\s*(.*)$/i.exec(line);
    if (m) current = m[1] ?? "";
    // Ligne qui ne ressemble pas à un header (rawMime tronqué/dégénéré) → stop
    else if (!/^[\x21-\x39\x3b-\x7e]+:/.test(line)) break;
  }
  if (current !== null) found.push(current);
  return found;
}

function domainOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
  return d.trim().toLowerCase() || undefined;
}

/** Alignement INFORMATIF (suffixe strict) — jamais une entrée de verdict :
 *  c'est la clause dmarc= du récepteur qui fait foi (il a la vraie liste des
 *  suffixes publics ; une heuristique locale accepterait gucci.co.uk ↔ x.co.uk). */
function looseAligned(d: string | undefined, from: string | undefined): boolean | undefined {
  if (!d || !from) return undefined;
  return d === from || d.endsWith("." + from) || from.endsWith("." + d);
}

export function evaluateAuthResults(rawMime: string, source: AuthSource): AuthResultsSummary {
  const rawHeaders = extractAuthHeaders(rawMime);
  if (rawHeaders.length === 0) return { present: false, trusted: false, dkim: [] };

  const parsed = rawHeaders.map(parseAuthenticationResults);
  const isTrustedId = (id: string | null) =>
    source === "gmail"
      ? id === "mx.google.com"
      : source === "outlook"
        ? id === null || /outlook|microsoft/i.test(id ?? "")
        : false; // upload/colle : provenance non prouvable
  let chosen = parsed.find((p) => isTrustedId(p.authservId));
  const trusted = chosen !== undefined;
  chosen = chosen ?? parsed[0];

  const first = (method: string) => chosen!.results.find((r) => r.method === method);
  const spf = first("spf");
  const dmarc = first("dmarc");
  const compauth = first("compauth");
  const fromDomain = domainOf(dmarc?.props["header.from"]);
  // La policy DMARC vit dans le commentaire "(p=REJECT sp=… dis=…)" — strippé par
  // le parser, on la repêche sur le raw de l'en-tête retenu.
  // slice(0, 2000) : borne le backtracking de [^;]*? sur un raw attaquant-contrôlé
  // (la clause dmarc + son commentaire tiennent toujours largement dedans).
  const policy = /\bdmarc=[a-z]+[^;]*?\(\s*p=([A-Za-z]+)/i
    .exec(chosen.raw.slice(0, 2000))?.[1]
    ?.toUpperCase();

  return {
    present: true,
    trusted,
    authservId: chosen.authservId ?? undefined,
    spf: spf ? { result: spf.result, mailfrom: domainOf(spf.props["smtp.mailfrom"]) } : undefined,
    dkim: chosen.results
      .filter((r) => r.method === "dkim")
      .map((r) => {
        const domain = domainOf(r.props["header.d"] ?? r.props["header.i"]);
        return {
          result: r.result,
          domain,
          selector: r.props["header.s"],
          alignedWithFrom: looseAligned(domain, fromDomain),
        };
      }),
    dmarc: dmarc ? { result: dmarc.result, fromDomain, policy } : undefined,
    compauth: compauth
      ? { result: compauth.result, reason: compauth.props["reason"] }
      : undefined,
    raw: chosen.raw.slice(0, 1000),
  };
}
