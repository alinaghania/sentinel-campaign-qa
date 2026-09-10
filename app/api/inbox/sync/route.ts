// POST : poll Gmail + Outlook, puis matching auto des nouveaux mails.
import { NextResponse } from "next/server";
import { gmailSync } from "@/lib/gmail";
import { imapConfigured, imapSync } from "@/lib/imap";
import { outlookSync } from "@/lib/outlook";
import { Campaigns, Inbox, Settings } from "@/lib/store";
import { matchEmailToCampaigns, MATCH_AUTO_THRESHOLD } from "@/lib/match";
import { resolveRuleConfig } from "@/lib/rule-config";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// La boîte Gmail est relevée soit en IMAP + mot de passe d'application, soit via
// l'API Gmail en OAuth. Le choix tient à la seule présence des variables d'env :
// on bascule d'une voie à l'autre sans redéployer, et on peut revenir en arrière
// si l'IMAP pose problème. Les deux écrivent le même provider dans le store, donc
// le matching en aval et la réponse JSON sont inchangés.
function gmailTransport(): Promise<{ added: number; error?: string }> {
  return imapConfigured() ? imapSync() : gmailSync();
}

// Le mode courant est décidé côté serveur : la page /inbox, qui est un composant
// client, ne peut pas lire process.env pour savoir s'il lui reste un flux OAuth à
// proposer. Elle vient donc le demander ici.
export async function GET() {
  return NextResponse.json({ transport: imapConfigured() ? "imap" : "gmail" });
}

export async function POST() {
  const [g, o] = await Promise.all([gmailTransport(), outlookSync()]);

  // Seuil de rattachement automatique, réglable depuis /rules. Lu UNE FOIS
  // pour toute la synchro : tous les mails d'un même passage sont rattachés
  // avec le même seuil.
  const cfg = resolveRuleConfig(await Settings.get());
  const autoThreshold =
    cfg.int("matching-auto-threshold", "autoThresholdPercent", MATCH_AUTO_THRESHOLD * 100) / 100;

  // Matching des mails non rattachés
  const campaigns = await Campaigns.list();
  const emails = await Inbox.list();
  let matched = 0;
  for (const email of emails) {
    if (email.campaignId) continue;
    const m = matchEmailToCampaigns(email, campaigns);
    if (m) {
      email.campaignId = m.campaignId;
      email.matchScore = m.score;
      email.matchConfirmed = m.score >= autoThreshold;
      await Inbox.put(email);
      matched++;
    }
  }
  return NextResponse.json({ gmail: g, outlook: o, matched });
}
