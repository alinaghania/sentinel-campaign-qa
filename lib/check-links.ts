// Vérification HTTP des liens — verdicts 4 états, guard SSRF obligatoire.
// - Seuls les liens "statique" et "tracked" sont testés (jamais l'AMPscript).
// - GET en navigation navigateur ; 400/403/405/429 → non_verifiable (bot-blocked ≠ cassé).
// - Blocklist IP privées/link-local sur CHAQUE hop de redirection (anti-SSRF).

import { lookup } from "dns/promises";
import { isIP } from "net";
import pLimit from "p-limit";
import type { EmailFacts, LinkCheckResult } from "./types";
import type { ResolvedRuleConfig } from "./rule-config";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// ANTI-BOT : les sites des maisons (Kering) sont derrière Akamai Bot Manager,
// qui ne regarde pas que le User-Agent. Un UA Chrome envoyé SEUL, sans les
// en-têtes qu'un vrai Chrome émet toujours à côté, est une signature de bot
// évidente → 403. Le jeu complet ci-dessous passe. Mesuré le 2026-07-27 sur
// les destinations réelles des mails en base :
//   balenciaga.com 403→200 · alexandermcqueen.com 403→200 · gucci.com ✗→200
//   facebook.com 400→200 · aucune régression sur les domaines déjà OK.
// Ces en-têtes DOIVENT rester cohérents entre eux (UA Chrome 138 ↔ sec-ch-ua
// v138) : une combinaison incohérente est un signal de bot plus fort que rien.
const NAV_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;
/** Octets lus du corps pour la détection de soft-404 — le reste est annulé
 *  (les pages des maisons pèsent plusieurs Mo, on n'a besoin que du <title>). */
const BODY_SNIPPET_BYTES = 8192;

function ipIsPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    // IPv6 : loopback, link-local, unique-local, mapped IPv4
    const low = ip.toLowerCase();
    if (low === "::1" || low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd"))
      return true;
    if (low.startsWith("::ffff:")) return ipIsPrivate(low.slice(7));
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local / IMDS Azure & AWS
    (a === 100 && b >= 64 && b <= 127)
  );
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`forbidden protocol (SSRF guard): ${u.protocol}`);
  }
  const host = u.hostname;
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new Error("private/link-local IP blocked (SSRF)");
    return u;
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("internal host blocked (SSRF)");
  }
  const res = await lookup(host, { all: true });
  for (const { address } of res) {
    if (ipIsPrivate(address)) throw new Error("DNS resolution to a private IP blocked (SSRF)");
  }
  return u;
}

const SOFT_404_RE =
  /page (introuvable|non trouv[ée]e)|not found|introuvable|n'existe (pas|plus)|404/i;

// SÉCURITÉ : un GET sur un lien de désinscription peut désabonner l'adresse de test.
// Tout lien qui matche (href OU texte) est exclu du scan HTTP.
const UNSUB_RE =
  /unsubscribe|d[ée]sinscri|d[ée]sabonn|opt.?out|se d[ée]sinscrire|preference center|g[ée]rer mes pr[ée]f[ée]rences|abmelden|darse de baja|cancelar (la )?suscripci|annulla l'iscrizione|退订|配信停止|配信解除|購読解除|수신거부/i;

/** Extrait les paramètres utm_* de la query string d'une URL (clés en minuscules). */
function parseQuery(url: string): Record<string, string> {
  const utm: Record<string, string> = {};
  try {
    const u = new URL(url);
    for (const [key, value] of u.searchParams) {
      const k = key.toLowerCase();
      if (k.startsWith("utm_")) utm[k] = value;
    }
  } catch {
    // URL invalide — pas de params exploitables
  }
  return utm;
}

/** Requête d'un hop en imitant une navigation navigateur.
 *
 *  GET et pas HEAD : un vrai navigateur n'envoie JAMAIS de HEAD pour ouvrir une
 *  page, et les WAF le savent — Akamai répond 403 à un HEAD même avec des
 *  en-têtes parfaits (vérifié sur alexandermcqueen.com), Facebook répond 400.
 *  Le corps est annulé après quelques Ko (voir readSnippet), donc le coût
 *  réseau reste proche d'un HEAD.
 *
 *  Sec-Fetch-Site vaut TOUJOURS "cross-site" ici, y compris après redirection :
 *  la navigation est initiée depuis un mail (origine tierce), et la spec fetch
 *  ne fait que DÉGRADER cette valeur le long d'une chaîne — un navigateur ne
 *  remonte jamais à "same-origin" en cours de route. Envoyer "same-origin" sur
 *  un hop serait justement l'incohérence qu'un WAF sait repérer. */
async function fetchOnce(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "GET",
    redirect: "manual",
    signal,
    headers: { ...NAV_HEADERS, "Sec-Fetch-Site": "cross-site" },
  });
}

/** Lit le DÉBUT du corps puis annule le flux (pages multi-Mo). */
async function readSnippet(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < BODY_SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        size += value.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c.subarray(0, Math.min(c.length, size - off)), off);
    off += c.length;
    if (off >= size) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** Libère le socket quand on n'exploite pas le corps de la réponse. */
function discardBody(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

/** Réglages pilotables depuis /rules (règles "links-http-verification" et
 *  "links-status-classification"). Tout est optionnel : un appelant qui ne passe
 *  rien retrouve EXACTEMENT le comportement d'avant, aux constantes du module. */
export interface LinkCheckOptions {
  timeoutMs?: number;
  concurrency?: number;
  maxRedirects?: number;
  /** Codes "bloqué par un anti-bot" → non_verifiable (≠ cassé). */
  blockedStatuses?: number[];
  /** Codes "cassé" → casse. 5xx est TOUJOURS cassé, quelle que soit la liste. */
  brokenStatuses?: number[];
}

interface ResolvedLinkOptions {
  timeoutMs: number;
  concurrency: number;
  maxRedirects: number;
  blockedStatuses: Set<number>;
  brokenStatuses: Set<number>;
}

/** Traduit la config /rules en options de vérification. Le seul endroit qui
 *  connaît la correspondance entre les clés du catalogue et ce module. */
export function linkOptionsFromConfig(cfg: ResolvedRuleConfig): LinkCheckOptions {
  return {
    timeoutMs: cfg.int("links-http-verification", "timeoutSec", TIMEOUT_MS / 1000) * 1000,
    concurrency: cfg.int("links-http-verification", "concurrency", CONCURRENCY),
    maxRedirects: cfg.int("links-http-verification", "maxRedirects", MAX_REDIRECTS),
    blockedStatuses: cfg.intList("links-status-classification", "blockedStatuses", [400, 403, 405, 429]),
    brokenStatuses: cfg.intList("links-status-classification", "brokenStatuses", [404, 410]),
  };
}

function resolveOptions(o?: LinkCheckOptions): ResolvedLinkOptions {
  return {
    timeoutMs: o?.timeoutMs ?? TIMEOUT_MS,
    concurrency: o?.concurrency ?? CONCURRENCY,
    maxRedirects: o?.maxRedirects ?? MAX_REDIRECTS,
    blockedStatuses: new Set(o?.blockedStatuses ?? [400, 403, 405, 429]),
    brokenStatuses: new Set(o?.brokenStatuses ?? [404, 410]),
  };
}

async function checkOne(href: string, opt: ResolvedLinkOptions): Promise<Partial<LinkCheckResult>> {
  let current = href;
  let redirects = 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs);
  try {
    for (;;) {
      await assertPublicUrl(current);
      const res = await fetchOnce(current, ctrl.signal);

      if (res.status >= 300 && res.status < 400) {
        discardBody(res);
        const loc = res.headers.get("location");
        if (!loc) return { status: "suspect", httpStatus: res.status, redirects, reason: "redirect without a Location header" };
        redirects++;
        if (redirects > opt.maxRedirects)
          return { status: "suspect", httpStatus: res.status, redirects, reason: "too many redirects" };
        const next = new URL(loc, current).toString();
        // SÉCURITÉ CRITIQUE : un lien tracké SFMC peut rediriger vers l'URL de
        // désinscription — la requêter désabonnerait l'adresse de test. On
        // STOPPE la chaîne dès qu'un hop ressemble à une désinscription.
        if (UNSUB_RE.test(next)) {
          return {
            status: "non_teste",
            httpStatus: res.status,
            redirects,
            finalUrl: next,
            reason: "redirects to an unsubscribe link — chain stopped (safety)",
          };
        }
        current = next;
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        // soft-404 : 200 mais contenu "page introuvable"
        if (res.headers.get("content-type")?.includes("text/html")) {
          try {
            const body = await readSnippet(res);
            const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] || "";
            if (SOFT_404_RE.test(title)) {
              return { status: "suspect", httpStatus: res.status, redirects, finalUrl: current, reason: `possible soft-404 (title: "${title.trim().slice(0, 60)}")` };
            }
          } catch {
            // body illisible — on garde OK
          }
        } else {
          discardBody(res);
        }
        return { status: "ok", httpStatus: res.status, redirects, finalUrl: current };
      }

      discardBody(res);
      // 400 : rejet de l'edge/WAF (ex. facebook.com sur une requête sans
      // cookies) — la page existe, c'est notre client qui est refusé. À classer
      // avec l'anti-bot, jamais en "cassé" : ce serait un faux positif MAJEUR
      // sur les liens sociaux du footer.
      if (opt.blockedStatuses.has(res.status)) {
        return { status: "non_verifiable", httpStatus: res.status, redirects, finalUrl: current, reason: "blocked by anti-bot protection (≠ broken)" };
      }
      // 5xx est cassé quoi qu'il arrive : une liste vidée par mégarde ne doit
      // pas faire passer une erreur serveur pour un lien sain.
      if (opt.brokenStatuses.has(res.status) || res.status >= 500) {
        return { status: "casse", httpStatus: res.status, redirects, finalUrl: current, reason: `HTTP ${res.status}` };
      }
      return { status: "suspect", httpStatus: res.status, redirects, finalUrl: current, reason: `HTTP ${res.status}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("SSRF") || msg.includes("interdit") || msg.includes("interne")) {
      return { status: "non_teste", reason: msg };
    }
    if ((e as Error).name === "AbortError") {
      return { status: "suspect", reason: `timeout (${opt.timeoutMs / 1000}s)` };
    }
    return { status: "casse", reason: `network: ${msg.slice(0, 100)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkLinks(
  facts: EmailFacts,
  onResult?: (r: LinkCheckResult) => void | Promise<void>,
  options?: LinkCheckOptions
): Promise<LinkCheckResult[]> {
  const opt = resolveOptions(options);
  const limit = pLimit(opt.concurrency);
  return Promise.all(
    facts.links.map((l) =>
      limit(async (): Promise<LinkCheckResult> => {
        const base: LinkCheckResult = {
          href: l.href,
          text: l.text,
          kind: l.kind,
          utm: l.utm,
          status: "non_teste",
        };
        let result: LinkCheckResult;
        if (UNSUB_RE.test(l.href) || UNSUB_RE.test(l.text)) {
          // SÉCURITÉ CRITIQUE : ne jamais requêter un lien de désinscription.
          result = { ...base, reason: "unsubscribe link — not tested (safety)" };
        } else if (l.kind === "ampscript") {
          result = { ...base, reason: "dynamic AMPscript link — not statically verifiable" };
        } else if (l.kind === "mailto" || l.kind === "anchor") {
          result = { ...base, reason: l.kind === "anchor" ? "anchor/empty href" : "mailto" };
        } else {
          result = { ...base, ...(await checkOne(l.href, opt)) };
          if (result.finalUrl && (result.redirects ?? 0) > 0) {
            result.finalUtm = parseQuery(result.finalUrl);
          }
        }
        await onResult?.(result);
        return result;
      })
    )
  );
}
