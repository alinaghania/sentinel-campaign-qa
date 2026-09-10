// Connexion Gmail réelle — OAuth gmail.readonly + format=raw → mailparser.
// Mode Testing Google : refresh token expire ~7 jours → gérer invalid_grant
// proprement (statut "error" → bouton Reconnecter dans l'UI).

import { google } from "googleapis";
import { Connections, Inbox, Tokens } from "./store";
import { parseMime } from "./parse-mime";
import type { InboxEmail } from "./types";

export function gmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function getOAuthClient(origin?: string) {
  const redirect =
    process.env.GOOGLE_REDIRECT_URI ||
    `${origin ?? "http://localhost:3000"}/api/auth/google/callback`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirect
  );
}

export function gmailAuthUrl(origin: string): string {
  return getOAuthClient(origin).generateAuthUrl({
    access_type: "offline",
    prompt: "select_account consent", // force le choix du compte + ré-émission du refresh_token
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
}

export async function gmailHandleCallback(code: string, origin: string): Promise<string> {
  const client = getOAuthClient(origin);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error("Pas de refresh_token retourné (retenter avec prompt=consent)");
  client.setCredentials(tokens);
  let email: string | undefined;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    email = (await oauth2.userinfo.get()).data.email ?? undefined;
  } catch {
    // non bloquant
  }
  await Tokens.put("gmail", tokens.refresh_token, email);
  await Connections.put({
    provider: "gmail",
    email,
    connectedAt: new Date().toISOString(),
    status: "connected",
  });
  return email ?? "connecté";
}

async function gmailClient() {
  const tok = await Tokens.get("gmail");
  if (!tok) throw new Error("Gmail non connecté");
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: tok.refreshToken });
  return google.gmail({ version: "v1", auth: client });
}

// Synchronise les mails récents (query configurable — label QA recommandé).
export async function gmailSync(): Promise<{ added: number; error?: string }> {
  const conn = await Connections.get("gmail");
  if (!conn || conn.status === "disconnected") return { added: 0 };
  try {
    const gmail = await gmailClient();
    const q = process.env.GMAIL_QUERY || "newer_than:30d";
    const MAX = Number(process.env.GMAIL_MAX_MESSAGES) || 200;
    // Pagination : Gmail plafonne à 100 ids/page → on boucle jusqu'à MAX.
    // (Avant : maxResults 20 sans pagination → la plupart des tests manquaient.)
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 100, pageToken });
      for (const m of list.data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken && ids.length < MAX);
    const existing = new Set((await Inbox.list()).map((e) => e.providerMessageId));
    let added = 0;
    for (const id of ids.slice(0, MAX)) {
      if (existing.has(id)) continue;
      const msg = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
      if (!msg.data.raw) continue;
      const buf = Buffer.from(msg.data.raw, "base64url");
      const parsed = await parseMime(buf);
      const entry: InboxEmail = {
        // Id DÉTERMINISTE (dérivé du message provider) : deux syncs concurrents
        // écrasent la même entrée au lieu de créer un doublon.
        id: `gm-${id}`,
        provider: "gmail",
        providerMessageId: id,
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
    // error: undefined — sans ça, le spread de `conn` garde l'erreur du passage
    // précédent et une synchro réussie laisse un message périmé à l'écran.
    await Connections.put({ ...conn, status: "connected", lastSyncAt: new Date().toISOString(), error: undefined });
    return { added };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAuthError = /invalid_grant|unauthorized|invalid_client/i.test(msg);
    await Connections.put({
      ...(conn ?? { provider: "gmail" as const }),
      status: "error",
      error: isAuthError
        ? "Session Gmail expirée (mode test Google : 7 jours) — cliquer sur Reconnecter"
        : msg.slice(0, 200),
    });
    return { added: 0, error: msg };
  }
}
