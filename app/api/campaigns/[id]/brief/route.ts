// POST : brief collé (texte/HTML) ou fichier uploadé (PDF/Excel/Word/PPT).
// Excel : la grille multilingue + les visuels sont DÉTERMINISTES (instantanés) et
// renvoyés tout de suite ; l'extraction LLM par langue tourne EN ARRIÈRE-PLAN
// (l'import n'attend plus ~30s). Non-Excel : extraction LLM synchrone (contenu).
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { Campaigns, uid, updateCampaign } from "@/lib/store";
import { briefToMarkdown, detectMarkets, extractBrief, extractFileText } from "@/lib/brief";
import { parseBriefGridDetailed, type BriefParseTelemetry } from "@/lib/brief-grid";
import { shouldScout } from "@/lib/brief-scout";
import { runAuditInBackground, runScoutInBackground } from "@/lib/brief-scout-job";
import { extractXlsxImages } from "@/lib/brief-media";
import { canonLang, displayLang, LANG_LABEL } from "@/lib/lang-codes";
import type { BriefExtraction, BriefGrid, Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_LANG_EXTRACTIONS = 8;

// Extraction LLM par langue, mergée dans la campagne (re-fetch pour ne pas
// écraser d'éventuelles éditions faites entre-temps). Ne throw jamais.
// importId : si un AUTRE brief a été importé pendant les ~30s d'extraction,
// ce job est périmé et n'écrit RIEN (sinon le mauvais fichier pollue le bon).
async function extractLanguagesInBackground(
  id: string,
  markdown: string,
  langs: string[],
  importId: string
) {
  try {
    const byLang: Record<string, BriefExtraction> = {};
    const results = await Promise.all(
      langs.slice(0, MAX_LANG_EXTRACTIONS).map(async (lang): Promise<[string, BriefExtraction | null]> => {
        const r = await extractBrief(markdown, `${displayLang(lang)} [${lang}]`);
        return [lang, r.ok ? r.data : null];
      })
    );
    for (const [lang, data] of results) if (data) byLang[lang] = data;
    if (Object.keys(byLang).length === 0) return;
    // Écriture sérialisée : ne pas écraser une édition de grille/PATCH
    // survenue pendant les ~30s d'extraction LLM.
    await updateCampaign(id, (fresh) => {
      if (fresh.briefImportId !== importId) return; // brief remplacé entre-temps
      fresh.briefExtractions = { ...(fresh.briefExtractions ?? {}), ...byLang };
      if (!fresh.briefExtraction) fresh.briefExtraction = Object.values(byLang)[0];
      if (!fresh.salesforceCampaignName) {
        const sf = Object.values(byLang).find((e) => e.salesforce_campaign_name?.value);
        if (sf?.salesforce_campaign_name?.value) fresh.salesforceCampaignName = sf.salesforce_campaign_name.value;
      }
    });
  } catch (err) {
    console.warn("[brief] extraction langues (arrière-plan) échouée :", err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  if (!campaign) return NextResponse.json({ error: "introuvable" }, { status: 404 });

  let raw = "";
  let fileName: string | null = null;
  let market: string | null = null;
  let excelBuffer: Buffer | null = null;
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "fichier manquant" }, { status: 400 });
    market = (form.get("market") as string) || null;
    const buf = Buffer.from(await file.arrayBuffer());
    fileName = file.name;
    raw = await extractFileText(file.name, buf);
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls")) {
      excelBuffer = buf;
    }
  } else {
    const body = await req.json();
    raw = body.brief ?? "";
    market = body.market ?? null;
  }
  if (!raw.trim()) return NextResponse.json({ error: "brief vide" }, { status: 400 });

  const markdown = briefToMarkdown(raw);
  const markets = detectMarkets(markdown);

  if (excelBuffer) {
    // --- DÉTERMINISTE (instantané) : grille + télémétrie + visuels ---
    let grid: BriefGrid | null = null;
    let telemetry: BriefParseTelemetry | undefined;
    try {
      const detailed = await parseBriefGridDetailed(excelBuffer);
      grid = detailed.grid;
      telemetry = detailed.telemetry;
    } catch (err) {
      console.warn("[brief] parse grille Excel échoué :", err);
    }
    let mockups: Campaign["briefMockups"];
    try {
      const extracted = await extractXlsxImages(excelBuffer);
      if (extracted.length > 0) mockups = extracted;
    } catch (err) {
      console.warn("[brief] extraction visuels Excel échouée :", err);
    }
    // Fichier persisté localement : rejouable par le scout ("Re-parse with AI").
    const fileHash = createHash("sha256").update(excelBuffer).digest("hex").slice(0, 16);
    let briefFilePath: string | undefined;
    try {
      const dir = path.join(process.cwd(), ".data", "briefs");
      await fs.mkdir(dir, { recursive: true });
      const ext = path.extname(fileName ?? "").toLowerCase() || ".xlsx";
      briefFilePath = path.join(dir, `${id}${ext}`);
      await fs.writeFile(briefFilePath, excelBuffer);
    } catch (err) {
      console.warn("[brief] sauvegarde fichier brief échouée :", err);
    }
    // Warnings de télémétrie : les pertes du parse ne sont plus silencieuses.
    const parseWarnings = (telemetry?.unmappedFields ?? []).map(
      (f) => `Field "${f.slice(0, 80)}" contains translated content but was not mapped to any grid block (not covered by QA)`
    );
    const scoutWanted = telemetry ? shouldScout(grid, telemetry) : grid === null;
    const importId = uid();
    const updated = await updateCampaign(id, (c) => {
      // RESET ATOMIQUE : un nouvel import remplace TOUT l'ancien brief — sinon
      // les champs du fichier précédent survivent et se mélangent au nouveau
      // (cas réel : nom Salesforce du mauvais template collé au bon brief).
      c.briefImportId = importId;
      c.briefRaw = markdown;
      c.briefMarkets = markets;
      c.briefMarket = market ?? undefined;
      c.briefFileName = fileName ?? "(texte collé)";
      c.briefFilePath = briefFilePath;
      c.briefExtraction = undefined;
      c.briefExtractions = undefined;
      c.briefGrid = grid ?? undefined;
      // Seul endroit du code où la famille est CONNUE : la télémétrie est
      // consommée ici (parseWarnings, shouldScout) puis jetée. La conformité au
      // template en a besoin bien plus tard, dans runCodeChecks — sans elle, un
      // brief d'une autre famille reçoit un verdict détaillé au lieu d'un « hors
      // périmètre ». `undefined` si le parse a échoué : on ne le remplace pas
      // par "none", qui affirmerait une famille reconnue.
      c.briefFamily = telemetry?.family;
      c.expectedLanguages = grid ? grid.languages : undefined;
      c.salesforceCampaignName = grid?.salesforceCampaignName; // undefined si absent
      c.briefParseWarnings = parseWarnings.length > 0 ? parseWarnings : undefined;
      c.briefScout = scoutWanted
        ? { status: "running", fileHash, startedAt: new Date().toISOString() }
        : { status: "skipped", fileHash };
      // Mockups : ceux du NOUVEAU fichier + les uploads MANUELS conservés
      // (les visuels extraits de l'ancien Excel sont périmés).
      const manual = (c.briefMockups ?? []).filter((m) => m.source === "upload");
      c.briefMockups = [...(mockups ?? []), ...manual];
      if (c.status === "BRIEF_RECU") c.status = "EMAIL_ATTENDU";
    });

    // --- LLM EN ARRIÈRE-PLAN : l'import répond tout de suite ---
    const langs =
      grid?.languages ??
      [...new Set(markets.map(canonLang))].filter((l) => l in LANG_LABEL);
    if (langs.length > 0) void extractLanguagesInBackground(id, markdown, langs, importId);
    if (scoutWanted) void runScoutInBackground(id, excelBuffer, importId, telemetry);
    void runAuditInBackground(id, markdown, grid, importId);

    return NextResponse.json({ campaign: updated ?? campaign });
  }

  // --- Non-Excel (PDF/texte/HTML collé) : extraction LLM synchrone (le contenu). ---
  const res = await extractBrief(markdown, market);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  const updated = await updateCampaign(id, (c) => {
    // RESET ATOMIQUE (même règle que le chemin Excel) : un brief PDF/texte
    // remplace toute l'ancienne grille Excel — pas de restes mélangés.
    c.briefImportId = uid();
    c.briefRaw = markdown;
    c.briefMarkets = markets;
    c.briefMarket = market ?? undefined;
    c.briefFileName = fileName ?? "(texte collé)";
    c.briefGrid = undefined;
    // Chemin PDF/texte : aucun parseur de famille n'a tourné. Laisser la valeur
    // du fichier Excel PRÉCÉDENT ferait gouverner le nouveau brief par une
    // famille mesurée sur l'ancien — le reste du bloc est un reset atomique
    // pour exactement cette raison.
    c.briefFamily = undefined;
    c.expectedLanguages = undefined;
    c.briefExtractions = undefined;
    c.briefParseWarnings = undefined;
    c.briefScout = undefined;
    c.briefFilePath = undefined;
    c.briefMockups = (c.briefMockups ?? []).filter((m) => m.source === "upload");
    c.briefExtraction = res.data;
    if (res.data.salesforce_campaign_name?.value) {
      c.salesforceCampaignName = res.data.salesforce_campaign_name.value;
    }
    if (res.data.campaign_name.value && c.name.startsWith("Campagne ")) {
      c.name = res.data.campaign_name.value;
    }
    if (res.data.send_datetime.value) c.sendDate = res.data.send_datetime.value;
    if (c.status === "BRIEF_RECU") c.status = "EMAIL_ATTENDU";
  });
  return NextResponse.json({ campaign: updated ?? campaign, extraction: res.data });
}
