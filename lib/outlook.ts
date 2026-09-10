// Connexion Outlook réelle — OAuth2 Auth Code + PKCE (fetch maison, endpoint
// /consumers), MIME complet via GET /me/messages/{id}/$value → mailparser.
// Rotation des refresh tokens : on persiste le nouveau RT à chaque refresh.

import crypto from "crypto";
import { Connections, Inbox, Tokens } from "./store";
import { parseMime } from "./parse-mime";
import type { InboxEmail } from "./types";

const TENANT = process.env.MS_TENANT || "consumers";
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "openid email offline_access User.Read Mail.Read";

export function outlookConfigured(): boolean {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

function redirectUri(origin?: string): string {
  return (
    process.env.MS_REDIRECT_URI ||
    `${origin ?? "http://localhost:3000"}/api/auth/outlook/callback`
  );
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function outlookAuthUrl(origin: string, challenge: string, state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID!,
    response_type: "code",
    redirect_uri: redirectUri(origin),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_BASE}/authorize?${p}`;
}

async function tokenRequest(body: URLSearchParams) {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`MS token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<{ access_token: string; refresh_token?: string }>;
}

export async function outlookHandleCallback(
  code: string,
  verifier: string,
  origin: string
): Promise<string> {
  const tokens = await tokenRequest(
    new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID!,
      client_secret: process.env.MS_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(origin),
      code_verifier: verifier,
    })
  );
  if (!tokens.refresh_token) throw new Error("Pas de refresh_token (vérifier offline_access + redirect type Web)");
  let email: string | undefined;
  try {
    const me = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }).then((r) => r.json());
    email = me.mail || me.userPrincipalName;
  } catch {
    // non bloquant
  }
  await Tokens.put("outlook", tokens.refresh_token, email);
  await Connections.put({
    provider: "outlook",
    email,
    connectedAt: new Date().toISOString(),
    status: "connected",
  });
  return email ?? "connecté";
}

async function accessToken(): Promise<string> {
  const tok = await Tokens.get("outlook");
  if (!tok) throw new Error("Outlook non connecté");
  const tokens = await tokenRequest(
    new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID!,
      client_secret: process.env.MS_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: tok.refreshToken,
      scope: SCOPES,
    })
  );
  if (tokens.refresh_token) await Tokens.put("outlook", tokens.refresh_token, tok.email);
  return tokens.access_token;
}

/** Deep-link OWA d'un message (rendu réel) : Graph fournit webLink, l'URL
 *  officielle qui ouvre CE message dans Outlook Web. */
export async function outlookWebLink(providerMessageId: string): Promise<string> {
  const token = await accessToken();
  const res = await fetch(
    `${GRAPH}/me/messages/${encodeURIComponent(providerMessageId)}?$select=webLink`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Graph webLink ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { webLink } = (await res.json()) as { webLink?: string };
  if (!webLink) throw new Error("Graph: webLink absent pour ce message");
  return webLink;
}

export async function outlookSync(): Promise<{ added: number; error?: string }> {
  const conn = await Connections.get("outlook");
  if (!conn || conn.status === "disconnected") return { added: 0 };
  try {
    const token = await accessToken();
    const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    const p = new URLSearchParams({
      $filter: `receivedDateTime gt ${since}`,
      $orderby: "receivedDateTime desc",
      $select: "id,subject,from,receivedDateTime",
      $top: "20",
    });
    const res = await fetch(`${GRAPH}/me/mailFolders/inbox/messages?${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { value } = (await res.json()) as { value: Array<{ id: string }> };
    const existing = new Set((await Inbox.list()).map((e) => e.providerMessageId));
    let added = 0;
    for (const m of value ?? []) {
      if (existing.has(m.id)) continue;
      // MIME complet — chemin /me/messages/{id}/$value (PAS via mailFolders)
      const mime = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(m.id)}/$value`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!mime.ok) continue;
      const parsed = await parseMime(Buffer.from(await mime.arrayBuffer()));
      const entry: InboxEmail = {
        // Id DÉTERMINISTE (hash du message provider — l'id Graph contient des
        // caractères non-fichier) : les syncs concurrents n'en font qu'une entrée.
        id: `ol-${crypto.createHash("sha1").update(m.id).digest("hex").slice(0, 20)}`,
        provider: "outlook",
        providerMessageId: m.id,
        subject: parsed.subject,
        from: parsed.from,
        receivedAt: parsed.receivedAt,
        html: parsed.html,
        rawMime: parsed.rawMime,
        headerChecks: parsed.headerChecks,
      };
      await Inbox.put(entry);
      added++;
    }
    await Connections.put({ ...conn, status: "connected", lastSyncAt: new Date().toISOString() });
    return { added };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await Connections.put({
      ...(conn ?? { provider: "outlook" as const }),
      status: "error",
      error: /invalid_grant|interaction_required/i.test(msg)
        ? "Session Outlook expirée — cliquer sur Reconnecter"
        : msg.slice(0, 200),
    });
    return { added: 0, error: msg };
  }
}
