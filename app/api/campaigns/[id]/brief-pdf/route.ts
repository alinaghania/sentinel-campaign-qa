// Vue HTML imprimable du brief (export PDF via l'impression navigateur).
// GET → page autonome : titre, tableau langues × blocs, liens attendus, mockups.

import { NextRequest } from "next/server";
import { Campaigns } from "@/lib/store";
import { displayLang } from "@/lib/lang-codes";
import type { Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111; background: #fff; margin: 0; padding: 32px 40px;
    font-size: 12px; line-height: 1.5;
  }
  .eyebrow { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #777; margin: 0 0 4px; }
  h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
  .meta { color: #777; font-size: 11px; margin: 0 0 24px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #ddd; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere; }
  th { background: #f5f5f5; font-weight: 600; font-size: 11px; }
  th.block-col, td.block-col { width: 140px; font-weight: 600; background: #fafafa; }
  td.empty { color: #bbb; }
  a { color: #111; }
  .mockups { display: flex; flex-wrap: wrap; gap: 16px; }
  .mockup { max-width: 320px; }
  .mockup img { max-width: 100%; height: auto; border: 1px solid #ddd; display: block; }
  .mockup .caption { font-size: 10px; color: #777; margin-top: 4px; }
  .print-hint { margin: 0 0 20px; padding: 8px 12px; background: #f5f5f5; border: 1px solid #ddd; font-size: 11px; color: #555; }
  .none { color: #999; font-style: italic; }
  @media print {
    body { padding: 0; font-size: 11px; }
    .print-hint { display: none; }
    tr, .mockup { break-inside: avoid; }
    h2 { break-after: avoid; }
    a { text-decoration: none; }
  }
`;

function renderGrid(campaign: Campaign): string {
  const grid = campaign.briefGrid;
  if (!grid || grid.blocks.length === 0) {
    return `<p class="none">No content grid in this brief.</p>`;
  }
  const langs = grid.languages;
  const head =
    `<tr><th class="block-col">Block</th>` +
    langs.map((l) => `<th>${esc(displayLang(l))}</th>`).join("") +
    `</tr>`;
  const rows = grid.blocks
    .map((b) => {
      const cells = langs
        .map((l) => {
          const v = b.valueByLang[l];
          return v
            ? `<td>${esc(v)}</td>`
            : `<td class="empty">—</td>`;
        })
        .join("");
      return `<tr><td class="block-col">${esc(b.name)}</td>${cells}</tr>`;
    })
    .join("");
  return `<table>${head}${rows}</table>`;
}

function renderLinks(campaign: Campaign): string {
  const links = campaign.briefGrid?.expectedLinks ?? [];
  if (links.length === 0) return `<p class="none">No expected links in this brief.</p>`;
  // Colonne par marché : union de tous les marchés captés (+ raccourcis ww/cn).
  const markets: string[] = [];
  for (const l of links) {
    const byMarket = { ...(l.linksByMarket ?? {}) };
    if (l.ww && !byMarket.WW) byMarket.WW = l.ww;
    if (l.cn && !byMarket.CN) byMarket.CN = l.cn;
    for (const m of Object.keys(byMarket)) if (!markets.includes(m)) markets.push(m);
  }
  const head =
    `<tr><th class="block-col">Block</th>` +
    markets.map((m) => `<th>${esc(m)} link</th>`).join("") +
    `</tr>`;
  const rows = links
    .map((l) => {
      const byMarket = { ...(l.linksByMarket ?? {}) };
      if (l.ww && !byMarket.WW) byMarket.WW = l.ww;
      if (l.cn && !byMarket.CN) byMarket.CN = l.cn;
      const cells = markets
        .map((m) => {
          const url = byMarket[m];
          return url
            ? `<td><a href="${esc(url)}">${esc(url)}</a></td>`
            : `<td class="empty">—</td>`;
        })
        .join("");
      return `<tr><td class="block-col">${esc(l.block)}</td>${cells}</tr>`;
    })
    .join("");
  return `<table>${head}${rows}</table>`;
}

function renderMockups(campaign: Campaign): string {
  const mockups = campaign.briefMockups ?? [];
  if (mockups.length === 0) return `<p class="none">No mockups attached to this brief.</p>`;
  return (
    `<div class="mockups">` +
    mockups
      .map(
        (m) =>
          `<figure class="mockup"><img src="${esc(m.dataUrl)}" alt="${esc(m.name)}"` +
          (m.width ? ` width="${m.width}"` : "") +
          (m.height ? ` height="${m.height}"` : "") +
          ` /><figcaption class="caption">${esc(m.name)}</figcaption></figure>`
      )
      .join("") +
    `</div>`
  );
}

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  if (!campaign) {
    return page(
      "Brief not found",
      `<p class="eyebrow">Sentinel — Brief</p><h1>Campaign not found</h1>`
    );
  }

  if (!campaign.briefGrid) {
    return page(
      `${campaign.name} — Brief`,
      `<p class="eyebrow">Sentinel — Brief</p>
<h1>${esc(campaign.name)}</h1>
<p class="meta">Period ${esc(campaign.period)}</p>
<p class="none">No brief yet.</p>`
    );
  }

  const body = `
<p class="eyebrow">Sentinel — Brief</p>
<h1>${esc(campaign.name)}</h1>
<p class="meta">Period ${esc(campaign.period)} · Generated ${esc(
    new Date().toISOString().slice(0, 10)
  )}</p>
<div class="print-hint">Use your browser print dialog (Ctrl/Cmd+P) to save this brief as a PDF.</div>
<h2>Content grid</h2>
${renderGrid(campaign)}
<h2>Expected links</h2>
${renderLinks(campaign)}
<h2>Mockups</h2>
${renderMockups(campaign)}
`;
  return page(`${campaign.name} — Brief`, body);
}
