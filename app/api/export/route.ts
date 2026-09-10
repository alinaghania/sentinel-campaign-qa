// GET : rapport Excel formaté (exceljs) — 3 onglets :
// Overview (KPIs, taux d'erreur, répartitions avec barres), Campaigns, Findings.
import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { diffRichText, findingRichText, sanitizeXml } from "@/lib/export-findings";
import { Campaigns, Reports } from "@/lib/store";
import type { AnalysisReport, Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

const INK = "FF111111";
const PAPER = "FFFFFFFF";
const ZEBRA = "FFF6F6F4";
const RULE = "FFDDDDD8";
const CRIT = "FFFBE3E3";
const MAJOR = "FFFDEFDD";
const MINOR = "FFFBF6DE";
const OKBG = "FFE4F2E9";

const STATUS_LABELS: Record<string, string> = {
  BRIEF_RECU: "Brief received",
  EMAIL_ATTENDU: "Awaiting email",
  EN_ANALYSE: "Analyzing",
  NO_GO: "No-go",
  CORRECTIONS: "Fixes",
  GO_AVEC_RESERVES: "Go — reservations",
  GO: "Go",
  ENVOYE: "Sent",
};

/** Ambre : ni le vert du GO franc, ni le rouge du refus. */
const RESERVEBG = "FFFBEBCC";

function headerRow(ws: ExcelJS.Worksheet, row: number, labels: string[], startCol = 1) {
  labels.forEach((label, i) => {
    const cell = ws.getCell(row, startCol + i);
    cell.value = label.toUpperCase();
    cell.font = { bold: true, color: { argb: PAPER }, size: 10, name: "Arial" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
    cell.alignment = { vertical: "middle" };
    cell.border = { bottom: { style: "thin", color: { argb: INK } } };
  });
  ws.getRow(row).height = 20;
}

function sectionTitle(ws: ExcelJS.Worksheet, row: number, title: string, span = 6) {
  ws.mergeCells(row, 1, row, span);
  const cell = ws.getCell(row, 1);
  cell.value = title.toUpperCase();
  cell.font = { bold: true, size: 11, name: "Arial", color: { argb: INK } };
  cell.border = { bottom: { style: "medium", color: { argb: INK } } };
  ws.getRow(row).height = 22;
}

function bar(n: number, max: number): string {
  if (max === 0) return "";
  return "█".repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / max) * 24)));
}

export async function GET(req: NextRequest) {
  const period = req.nextUrl.searchParams.get("period");
  const status = req.nextUrl.searchParams.get("status");
  let campaigns = await Campaigns.list();
  if (period) campaigns = campaigns.filter((c) => c.period === period);
  if (status) campaigns = campaigns.filter((c) => c.status === status);
  const allReports = await Reports.list();

  // dernier rapport par campagne
  const lastReport = (c: Campaign): AnalysisReport | undefined =>
    allReports
      .filter((r) => r.campaignId === c.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const analyzed = campaigns.map((c) => ({ c, r: lastReport(c) })).filter((x) => x.r);
  const go = analyzed.filter((x) => x.r!.verdict === "GO").length;
  const reserves = analyzed.filter((x) => x.r!.verdict === "GO_AVEC_RESERVES").length;
  // `nogo` compte les REFUS, pas « tout ce qui n'est pas GO » : soustraire les
  // deux catégories non bloquantes, sinon les réserves gonflent le taux d'erreur
  // rendu au client — c'est exactement ce que le troisième état corrige.
  const nogo = analyzed.length - go - reserves;
  const errorRate = analyzed.length ? Math.round((nogo / analyzed.length) * 100) : 0;
  const totals = { crit: 0, major: 0, minor: 0, passed: 0 };
  const byCategory = new Map<string, number>();
  const byAgent = new Map<string, number>();
  for (const { r } of analyzed) {
    totals.crit += r!.counters.critiques;
    totals.major += r!.counters.majeurs;
    totals.minor += r!.counters.mineurs;
    totals.passed += r!.passedChecks.length;
    for (const f of r!.findings) {
      byCategory.set(f.categorie, (byCategory.get(f.categorie) ?? 0) + 1);
      byAgent.set(f.source === "regle" ? "Deterministic rules" : f.agent, (byAgent.get(f.source === "regle" ? "Deterministic rules" : f.agent) ?? 0) + 1);
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Sentinel";
  wb.created = new Date();

  // ============ 1. OVERVIEW ============
  const ov = wb.addWorksheet("Overview", { views: [{ showGridLines: false }] });
  ov.columns = [
    { width: 34 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 30 }, { width: 14 },
  ];

  ov.mergeCells("A1:F1");
  const title = ov.getCell("A1");
  title.value = "SENTINEL — EMAIL CAMPAIGN QA REPORT";
  title.font = { bold: true, size: 18, name: "Arial", color: { argb: INK } };
  ov.getRow(1).height = 30;
  ov.mergeCells("A2:F2");
  ov.getCell("A2").value =
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}` +
    (period ? ` · Period: ${period}` : "") +
    (status ? ` · Status: ${STATUS_LABELS[status] ?? status}` : "");
  ov.getCell("A2").font = { size: 10, color: { argb: "FF8C8C8C" }, name: "Arial" };
  ov.getCell("A3").border = {};

  // --- KPIs ---
  sectionTitle(ov, 4, "Key figures");
  const kpis: Array<[string, number | string, string?]> = [
    ["Campaigns in scope", campaigns.length],
    ["Campaigns analyzed", analyzed.length],
    ["GO (AI verdict)", go, OKBG],
    ["GO with reservations (AI verdict)", reserves, reserves ? RESERVEBG : OKBG],
    ["NO-GO (AI verdict)", nogo, nogo ? CRIT : OKBG],
    ["Error rate (NO-GO / analyzed)", `${errorRate}%`, errorRate > 30 ? CRIT : OKBG],
    ["Critical findings", totals.crit, totals.crit ? CRIT : OKBG],
    ["Major findings", totals.major, totals.major ? MAJOR : OKBG],
    ["Minor findings", totals.minor, totals.minor ? MINOR : OKBG],
    ["Checks passed", totals.passed, OKBG],
  ];
  kpis.forEach(([label, value, fill], i) => {
    const row = 5 + i;
    ov.getCell(row, 1).value = label as string;
    ov.getCell(row, 1).font = { size: 10.5, name: "Arial" };
    const v = ov.getCell(row, 2);
    v.value = value;
    v.font = { bold: true, size: 11, name: "Arial" };
    v.alignment = { horizontal: "center" };
    if (fill) v.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    ov.getCell(row, 1).border = { bottom: { style: "hair", color: { argb: RULE } } };
    v.border = { bottom: { style: "hair", color: { argb: RULE } } };
  });

  // --- Findings by severity (avec barres) ---
  let r0 = 5 + kpis.length + 1;
  sectionTitle(ov, r0, "Findings by severity");
  headerRow(ov, r0 + 1, ["Severity", "Count", "", "Distribution"], 1);
  ov.mergeCells(r0 + 1, 3, r0 + 1, 4);
  const sevMax = Math.max(totals.crit, totals.major, totals.minor, 1);
  const sevRows: Array<[string, number, string]> = [
    ["Critical", totals.crit, "FFB3261E"],
    ["Major", totals.major, "FFB26A00"],
    ["Minor", totals.minor, "FF8F7A00"],
  ];
  sevRows.forEach(([label, n, color], i) => {
    const row = r0 + 2 + i;
    ov.getCell(row, 1).value = label;
    ov.getCell(row, 1).font = { size: 10.5, name: "Arial" };
    ov.getCell(row, 2).value = n;
    ov.getCell(row, 2).font = { bold: true, name: "Arial" };
    ov.getCell(row, 2).alignment = { horizontal: "center" };
    ov.mergeCells(row, 3, row, 4);
    ov.getCell(row, 3).value = bar(n, sevMax);
    ov.getCell(row, 3).font = { color: { argb: color }, size: 10, name: "Arial" };
  });

  // --- Findings by category ---
  r0 = r0 + 2 + sevRows.length + 1;
  sectionTitle(ov, r0, "Findings by category");
  headerRow(ov, r0 + 1, ["Category", "Count", "", "Distribution"], 1);
  ov.mergeCells(r0 + 1, 3, r0 + 1, 4);
  const cats = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(...cats.map(([, n]) => n), 1);
  cats.forEach(([cat, n], i) => {
    const row = r0 + 2 + i;
    ov.getCell(row, 1).value = cat;
    ov.getCell(row, 1).font = { size: 10.5, name: "Arial" };
    ov.getCell(row, 2).value = n;
    ov.getCell(row, 2).font = { bold: true, name: "Arial" };
    ov.getCell(row, 2).alignment = { horizontal: "center" };
    ov.mergeCells(row, 3, row, 4);
    ov.getCell(row, 3).value = bar(n, catMax);
    ov.getCell(row, 3).font = { color: { argb: "FF444444" }, size: 10, name: "Arial" };
  });

  // --- Top issues détectés par (règles vs agents) ---
  r0 = r0 + 2 + cats.length + 1;
  sectionTitle(ov, r0, "Findings by detector");
  headerRow(ov, r0 + 1, ["Detector", "Count"], 1);
  [...byAgent.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([agent, n], i) => {
      const row = r0 + 2 + i;
      ov.getCell(row, 1).value = agent;
      ov.getCell(row, 1).font = { size: 10.5, name: "Arial" };
      ov.getCell(row, 2).value = n;
      ov.getCell(row, 2).font = { bold: true, name: "Arial" };
      ov.getCell(row, 2).alignment = { horizontal: "center" };
    });

  // ============ 2. CAMPAIGNS ============
  const cs = wb.addWorksheet("Campaigns", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  const csCols = [
    ["Campaign", 34], ["Period", 10], ["Status", 14], ["AI verdict", 11],
    ["Human decision", 14], ["Critical", 9], ["Major", 9], ["Minor", 9],
    ["Checks passed", 13], ["Versions", 9], ["Send date", 12],
    ["Subject (brief)", 34], ["Promo code", 11], ["Missing brief fields", 30], ["Updated", 17],
  ] as const;
  cs.columns = csCols.map(([, width]) => ({ width }));
  headerRow(cs, 1, csCols.map(([label]) => label));
  cs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: csCols.length } };

  campaigns.forEach((c, i) => {
    const r = lastReport(c);
    const b = c.briefExtraction;
    const row = cs.getRow(i + 2);
    row.values = [
      sanitizeXml(c.name),
      c.period,
      STATUS_LABELS[c.status] ?? c.status,
      r ? (r.verdict === "GO" ? "GO" : r.verdict === "GO_AVEC_RESERVES" ? "GO (RES.)" : "NO-GO") : "—",
      c.humanDecision ?? "—",
      r?.counters.critiques ?? "",
      r?.counters.majeurs ?? "",
      r?.counters.mineurs ?? "",
      r?.passedChecks.length ?? "",
      c.versions.length,
      c.sendDate?.slice(0, 10) ?? "",
      sanitizeXml(b?.subject_line?.value ?? ""),
      b?.promo_code?.value ?? "",
      b?.missing_fields?.join(", ") ?? "",
      c.updatedAt.slice(0, 16).replace("T", " "),
    ];
    row.font = { size: 10, name: "Arial" };
    if (i % 2 === 1) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
      });
    }
    const verdictCell = row.getCell(4);
    if (r) {
      verdictCell.font = { bold: true, size: 10, name: "Arial" };
      verdictCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
          argb:
            r.verdict === "GO" ? OKBG : r.verdict === "GO_AVEC_RESERVES" ? RESERVEBG : CRIT,
        },
      };
      verdictCell.alignment = { horizontal: "center" };
    }
    if (r?.counters.critiques) {
      row.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: CRIT } };
      row.getCell(6).font = { bold: true, size: 10, name: "Arial" };
    }
  });

  // ============ 3. FINDINGS ============
  const fs = wb.addWorksheet("Findings", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  const fsCols = [
    ["Campaign", 30], ["Version", 8], ["Severity", 10], ["Category", 13],
    ["Detector", 22], ["Finding", 60], ["Expected", 40], ["Received", 40],
    ["Evidence", 40], ["Locator", 18], ["Suggestion", 40], ["Resolved", 9],
  ] as const;
  fs.columns = fsCols.map(([, width]) => ({ width }));
  headerRow(fs, 1, fsCols.map(([label]) => label));
  fs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: fsCols.length } };

  let fRow = 2;
  for (const { c, r } of analyzed) {
    const version = c.versions.find((v) => v.id === r!.versionId);
    for (const f of r!.findings) {
      const hasDiff = f.expected !== undefined;
      const row = fs.getRow(fRow++);
      row.values = [
        sanitizeXml(c.name),
        version?.label ?? "",
        f.severite === "CRITIQUE" ? "Critical" : f.severite === "MAJEUR" ? "Major" : "Minor",
        f.categorie,
        f.source === "regle" ? "Deterministic rule" : f.agent,
        // Titre harmonisé en gras + explication (richText).
        findingRichText(f),
        diffRichText(f.expected, f.received) ?? "",
        diffRichText(f.received, f.expected) ?? "",
        // evidence = copie VERBATIM du contenu du mail (source externe) : les
        // caractères de contrôle rendraient le XLSX invalide.
        sanitizeXml(f.evidence),
        sanitizeXml(f.locator),
        f.suggestion ? sanitizeXml(f.suggestion) : "",
        f.review ? "Yes" : "",
      ];
      row.font = { size: 10, name: "Arial" };
      row.alignment = { vertical: "top", wrapText: true };
      // Fond jaune pâle du diff (équivalent du surlignage de l'UI) — seulement
      // quand le finding porte une comparaison expected/received.
      if (hasDiff) {
        for (const col of [7, 8]) {
          row.getCell(col).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFF3B0" },
          };
        }
      }
      const sev = row.getCell(3);
      sev.font = { bold: true, size: 10, name: "Arial" };
      sev.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: f.severite === "CRITIQUE" ? CRIT : f.severite === "MAJEUR" ? MAJOR : MINOR },
      };
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sentinel-qa-report-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
