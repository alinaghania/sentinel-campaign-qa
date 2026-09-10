// POST : rattacher PLUSIEURS mails de l'inbox à une campagne en une fois.
// Chaque mail devient une version d'email (même logique que /api/inbox/[id]/attach),
// avec déduplication par providerMessageId et détection de langue si la grille du brief est présente.
import { NextRequest, NextResponse } from "next/server";
import { Campaigns, Inbox, uid, updateCampaign } from "@/lib/store";
import { parseEmailFacts } from "@/lib/parse-email";
import { startBatchAnalysis } from "@/lib/batch-analyze";
import type { BriefGrid, Campaign, EmailVersion, InboxEmail } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Détecte la langue canonique d'un mail à partir de la grille du brief.
 *  Heuristique (jamais bloquante) : sujet identique à un bloc "Subject line" de la grille,
 *  sinon attribut lang du HTML rapproché des langues attendues. Retourne undefined si incertain. */
function detectEmailLanguage(email: InboxEmail, campaign: Campaign): string | undefined {
  if (email.language) return email.language;
  const grid: BriefGrid | undefined = campaign.briefGrid;
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

  if (grid && email.subject) {
    const subjectBlocks = grid.blocks.filter((b) => /subject/i.test(b.name));
    for (const block of subjectBlocks) {
      // Le sujet peut être IDENTIQUE entre plusieurs langues (ex "Le 7 Bowling
      // Bag" en EN/FR/ES) : ne conclure que si UNE seule langue correspond,
      // sinon on taguerait arbitrairement la première colonne.
      const matching = Object.entries(block.valueByLang)
        .filter(([, value]) => value && norm(value) === norm(email.subject))
        .map(([lang]) => lang);
      if (matching.length === 1) return matching[0];
    }
  }

  // Repli : attribut lang du HTML (ex "fr-FR" → "FR"), rapproché des langues attendues.
  const expected = campaign.expectedLanguages ?? grid?.languages ?? [];
  if (email.html && expected.length > 0) {
    const htmlLang = parseEmailFacts(email.html).lang;
    if (htmlLang) {
      const primary = htmlLang.split("-")[0].toUpperCase();
      const match = expected.find((code) =>
        code
          .split("|")
          .some((part) => part.toUpperCase() === primary || part.split("-")[0].toUpperCase() === primary)
      );
      if (match) return match;
    }
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { campaignId?: string; inboxIds?: string[] };
  const { campaignId, inboxIds } = body;
  if (!campaignId || !Array.isArray(inboxIds) || inboxIds.length === 0) {
    return NextResponse.json(
      { error: "campaignId et inboxIds (non vide) requis" },
      { status: 400 }
    );
  }
  const campaign = await Campaigns.get(campaignId);
  if (!campaign) return NextResponse.json({ error: "campagne introuvable" }, { status: 404 });

  // Dédup : providerMessageId des mails déjà rattachés (confirmés) à cette campagne.
  const allInbox = await Inbox.list();
  const alreadyAttached = new Set(
    allInbox
      .filter((e) => e.campaignId === campaign.id && e.matchConfirmed)
      .map((e) => e.providerMessageId)
  );

  let skipped = 0;

  // Versions construites hors écriture (dédup + langue depuis le snapshot),
  // puis POSÉES en un seul updateCampaign (sérialisé par id) : un job
  // d'analyse concurrent ne peut pas effacer ces versions ni l'inverse.
  const newVersions: EmailVersion[] = [];
  const inboxUpdates: Array<{ email: InboxEmail; language?: string }> = [];
  for (const inboxId of inboxIds) {
    const email = await Inbox.get(inboxId);
    if (!email || !email.html) {
      skipped++;
      continue;
    }
    if (alreadyAttached.has(email.providerMessageId)) {
      skipped++;
      continue;
    }
    alreadyAttached.add(email.providerMessageId); // dédup intra-batch

    const language = detectEmailLanguage(email, campaign);
    newVersions.push({
      id: uid(),
      label: "v?", // renuméroté dans le mutator (longueur RÉELLE au moment de l'écriture)
      ...(email.subject ? { name: email.subject } : {}),
      providerMessageId: email.providerMessageId,
      receivedAt: email.receivedAt,
      source: email.provider,
      html: email.html,
      rawMime: email.rawMime,
      headerChecks: email.headerChecks,
      ...(language ? { language } : {}),
    });
    inboxUpdates.push({ email, language });
  }

  const attached = newVersions.length;
  if (attached > 0) {
    await updateCampaign(campaign.id, (c) => {
      for (const v of newVersions) {
        v.label = `v${c.versions.length + 1}`;
        c.versions.push(v);
      }
      if (c.status === "EMAIL_ATTENDU" || c.status === "BRIEF_RECU") {
        c.status = "EN_ANALYSE";
      }
    });
    for (const { email, language } of inboxUpdates) {
      email.campaignId = campaign.id;
      email.matchConfirmed = true;
      if (language) email.language = language;
      await Inbox.put(email);
    }

    // ANALYSE AUTOMATIQUE des mails fraîchement rattachés (zéro clic) : job
    // détaché — l'étape "rendu réel" de l'analyse capture aussi les
    // screenshots (desktop Gmail réel + largeurs mobiles). La fiche campagne
    // détecte le job actif et affiche la progression en live.
    const started = await startBatchAnalysis(
      campaign.id,
      newVersions.map((v) => v.id)
    );
    const fresh = await Campaigns.get(campaign.id);
    return NextResponse.json({
      attached,
      skipped,
      campaign: fresh ?? campaign,
      jobId: "jobId" in started ? started.jobId : null,
    });
  }

  return NextResponse.json({ attached, skipped, campaign });
}
