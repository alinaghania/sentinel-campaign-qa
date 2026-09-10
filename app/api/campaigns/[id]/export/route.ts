// Export Excel du report GO/NO-GO.
// GET /api/campaigns/:id/export -> .xlsx (3 feuilles : verdicts + findings +
// screenshots des rendus réels). exceljs (et pas xlsx) : nécessaire pour
// EMBARQUER les images.

import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { Campaigns, Reports } from "@/lib/store";
import { diffRichText, findingRichText, sanitizeXml } from "@/lib/export-findings";
import { titleForFinding } from "@/lib/finding-titles";
import { isBlocking } from "@/lib/aggregate";
import { buildMarketReport } from "@/lib/lang-report";
import { listRenders } from "@/lib/render-real";
import type { AnalysisReport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Nom de fichier sûr : ascii, tirets, pas d'espaces ni caractères spéciaux. */
function safeFilename(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "campagne";
}

/** Dimensions d'un PNG (header IHDR) — pour garder le ratio à l'affichage. */
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF111111" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" } };

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  if (!campaign) {
    return NextResponse.json({ error: "introuvable" }, { status: 404 });
  }
  const reports = (await Reports.list()).filter((r) => r.campaignId === id);
  const reportById = new Map<string, AnalysisReport>(reports.map((r) => [r.id, r]));
  const marketRows = buildMarketReport(campaign, reports);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Sentinel";

  // --- Feuille 1 : format du fichier de suivi QA CLIENT (fichier_sortie.xlsx
  // fourni par Alina) : une ligne par mail de test — TEST SUBJECT | OK/KO |
  // FEEDBACK | FEEDBACK OWNER | TEST SENT TO CLIENT (Y/N) | TEST SUBJECT SENT
  // TO CLIENT. Sentinel préremplit verdict + feedback ; l'envoi client reste
  // au process humain.
  const s1 = wb.addWorksheet("QA");
  s1.columns = [{ width: 64 }, { width: 28 }, { width: 60 }, { width: 16 }, { width: 22 }, { width: 42 }];
  const meta = s1.addRow(["WRIKE/EMAIL", "CAMPAIGN NAME", "DEV"]);
  meta.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  s1.addRow(["", sanitizeXml(campaign.name), ""]);
  s1.addRow([]);
  const h1 = s1.addRow([
    "TEST SUBJECT",
    "OK/KO",
    "FEEDBACK",
    "FEEDBACK OWNER",
    "TEST SENT TO CLIENT (Y/N)",
    "TEST SUBJECT SENT TO CLIENT",
  ]);
  h1.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  for (const v of marketRows) {
    const report = v.reportId ? reportById.get(v.reportId) : undefined;
    // Feedback = les findings ACTIFS les plus importants, en une cellule courte :
    // une puce "Titre: message" PAR finding (message plafonné à 180 caractères,
    // borne totale ~1200 — plus de coupe globale au milieu d'une puce).
    const active = (report?.findings ?? []).filter((f) => !f.review);
    const bullets = active.slice(0, 4).map((f) => {
      const msg = f.message.length > 180 ? `${f.message.slice(0, 180)}…` : f.message;
      return `• ${titleForFinding(f)}: ${msg}`;
    });
    let feedbackBody = bullets.join("\n");
    if (feedbackBody.length > 1200) feedbackBody = `${feedbackBody.slice(0, 1200)}…`;
    if (active.length > 4) feedbackBody += `\n(+${active.length - 4} more in the Findings tab)`;
    const feedback =
      v.verdict === "—" ? "Not analyzed yet" : active.length === 0 ? "" : sanitizeXml(feedbackBody);
    const row = s1.addRow([
      sanitizeXml(v.name),
      // "KO" (pas "NOK") — terme du fichier de suivi client.
      //
      // GO_AVEC_RESERVES est rendu "OK" À DESSEIN : ce fichier suit le
      // vocabulaire à DEUX termes du client, et y introduire un troisième mot
      // est une décision de process client, pas une décision technique. Les
      // réserves ne disparaissent pas pour autant — la colonne FEEDBACK
      // ci-dessous est peuplée dès qu'il reste un finding actif, et la cellule
      // est mise en évidence. À rouvrir si le client veut son propre terme.
      v.verdict === "—" ? "" : isBlocking(v.verdict) ? "KO" : "OK",
      feedback,
      // FEEDBACK OWNER : laissé vide (rempli par l'humain).
      "",
      "",
      "",
    ]);
    row.getCell(3).alignment = { wrapText: true, vertical: "top" };
    if (v.verdict === "NO_GO") row.getCell(2).font = { bold: true, color: { argb: "FFB3261E" } };
    // Réserves : "OK" en ambre — le mot du client est conservé, mais l'œil voit
    // qu'il n'est pas le même OK qu'un mail sans aucune remarque.
    else if (v.verdict === "GO_AVEC_RESERVES")
      row.getCell(2).font = { bold: true, color: { argb: "FFB26A00" } };
    else if (v.verdict === "GO") row.getCell(2).font = { color: { argb: "FF2E7D32" } };
  }

  // --- Feuille 2 : findings de CHAQUE mail (dernier report), review incluse ---
  // Les findings arbitrés restent listés mais MARQUÉS (sinon la feuille
  // contredirait les compteurs de la feuille 1 qui les excluent).
  // Format simplifié demandé par Alina : 5 colonnes, uniquement les findings
  // ACTIFS (les arbitrés sont levés — cohérent avec les compteurs feuille 1).
  const s2 = wb.addWorksheet("Findings");
  s2.columns = [
    { width: 9 }, // Market
    { width: 36 }, // Email
    { width: 75 }, // Finding (titre gras + explication)
    { width: 48 }, // Expected
    { width: 48 }, // Received
  ];
  const h2 = s2.addRow(["Market", "Email", "Finding", "Expected", "Received"]);
  h2.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  // Fond jaune pâle des cellules de diff (équivalent du surlignage de l'UI).
  const DIFF_FILL: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFF3B0" },
  };
  for (const v of marketRows) {
    const report = v.reportId ? reportById.get(v.reportId) : undefined;
    if (!report) continue;
    for (const f of report.findings) {
      if (f.review) continue; // arbitré par l'humain → levé
      const hasDiff = f.expected !== undefined;
      const row = s2.addRow([
        v.market ?? "?",
        sanitizeXml(v.name),
        findingRichText(f),
        diffRichText(f.expected, f.received) ?? "",
        diffRichText(f.received, f.expected) ?? "",
      ]);
      row.getCell(3).alignment = { wrapText: true, vertical: "top" };
      for (const col of [4, 5]) {
        const cell = row.getCell(col);
        cell.alignment = { wrapText: true, vertical: "top" };
        if (hasDiff) cell.fill = DIFF_FILL;
      }
    }
  }

  // --- Feuille Links : TOUS les liens de chaque mail reçu (demande Alina —
  // retrouver facilement le lien fautif, et vue d'ensemble des destinations).
  const LINK_STATUS: Record<string, string> = {
    ok: "OK",
    casse: "BROKEN",
    suspect: "SUSPICIOUS",
    non_verifiable: "not verifiable",
    non_teste: "not tested",
  };
  const s4 = wb.addWorksheet("Links");
  s4.columns = [
    { width: 9 }, // Market
    { width: 36 }, // Email
    { width: 28 }, // Link text
    { width: 60 }, // URL
    { width: 60 }, // Final URL (après redirections)
    { width: 14 }, // Status
  ];
  const h4 = s4.addRow(["Market", "Email", "Link text", "URL", "Final URL", "Status"]);
  h4.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  for (const v of marketRows) {
    const report = v.reportId ? reportById.get(v.reportId) : undefined;
    if (!report) continue;
    for (const l of report.linkResults ?? []) {
      const row = s4.addRow([
        v.market ?? "?",
        sanitizeXml(v.name),
        sanitizeXml(l.text || "—"),
        sanitizeXml(l.href.slice(0, 500)),
        sanitizeXml((l.finalUrl ?? "").slice(0, 500)),
        LINK_STATUS[l.status] ?? l.status,
      ]);
      row.alignment = { vertical: "top", wrapText: true };
      if (l.status === "casse" || l.status === "suspect") {
        row.getCell(6).font = { bold: true, color: { argb: "FFB3261E" } };
      }
    }
  }

  // --- Feuille 3 : screenshots des rendus réels, un bloc par mail ---
  // Desktop (vrai Gmail/Outlook) + aperçu responsive 390px côte à côte.
  // (Les autres largeurs restent consultables dans l'app — fichier raisonnable.)
  const EXPORT_DEVICES = ["desktop", "mobile-390"];
  const s3 = wb.addWorksheet("Screenshots");
  s3.getColumn(1).width = 4;
  let rowCursor = 2;
  let hasShots = false;
  for (const v of marketRows) {
    const renders = (await listRenders(v.versionId)).filter((r) =>
      EXPORT_DEVICES.includes(r.device)
    );
    if (renders.length === 0) continue;
    hasShots = true;

    // Titre du bloc mail
    const title = s3.getCell(rowCursor, 2);
    title.value = `${v.market ?? "?"} — ${v.name}`;
    title.font = { bold: true, size: 13 };
    rowCursor += 2;

    let colPx = 0;
    let maxHeight = 0;
    for (const r of renders) {
      const png = await fs.readFile(r.file).catch(() => null);
      if (!png) continue;
      const { w, h } = pngSize(png);
      const displayW = r.device === "desktop" ? 420 : 250;
      const displayH = Math.round((h / w) * displayW);
      const colIndex = 2 + Math.round(colPx / 64); // ~64px par colonne Excel

      // Sous-titre demandé : "Gmail desktop : screen"
      const sub = s3.getCell(rowCursor, colIndex);
      sub.value =
        r.device === "desktop"
          ? `${r.provider === "gmail" ? "Gmail" : "Outlook"} desktop: screen (real render captured ${r.capturedAt.slice(0, 10)})`
          : `Responsive ${r.device.replace("mobile-", "")}px: screen`;
      sub.font = { bold: true, color: { argb: "FF555555" } };

      const imgId = wb.addImage({
        buffer: png as unknown as ExcelJS.Buffer,
        extension: "png",
      });
      s3.addImage(imgId, {
        tl: { col: colIndex - 1, row: rowCursor },
        ext: { width: displayW, height: displayH },
      });
      colPx += displayW + 40;
      maxHeight = Math.max(maxHeight, displayH);
    }
    // Ligne Excel ≈ 20px : réserver la hauteur de l'image + marge.
    rowCursor += Math.ceil(maxHeight / 20) + 4;
  }
  if (!hasShots) {
    s3.getCell(2, 2).value =
      "No screenshots — run an analysis with real rendering enabled (npm run render:login once).";
  }

  const buffer = await wb.xlsx.writeBuffer();

  return new Response(new Uint8Array(buffer as ArrayBuffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sentinel-${safeFilename(campaign.name)}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
