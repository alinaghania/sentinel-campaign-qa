// Pré-parse déterministe du HTML email → faits structurés compacts.
// Le LLM ne voit JAMAIS le HTML brut : il reçoit ces faits (< 15k tokens).
// Inclut le contenu des commentaires conditionnels MSO (liens/boutons Outlook).

import * as cheerio from "cheerio";
import type { EmailFacts } from "./types";

const TRACKED_DOMAINS_RE =
  /(^|\.)(click|cta|t|links?|email|mc|trk|track(ing)?)\.[^/]+|exacttarget\.com|exct\.net|salesforce-email|sfmc/i;
const AMPSCRIPT_RE = /%%[=[][\s\S]*?[=\]]%%|%%[a-zA-Z_][a-zA-Z0-9_]*%%/g;

export function classifyLink(
  href: string
): "statique" | "ampscript" | "tracked" | "mailto" | "anchor" {
  const h = href.trim();
  if (/%%/.test(h)) return "ampscript";
  if (h.startsWith("mailto:")) return "mailto";
  if (h.startsWith("#") || h === "") return "anchor";
  try {
    const u = new URL(h);
    if (TRACKED_DOMAINS_RE.test(u.hostname)) return "tracked";
  } catch {
    return "ampscript"; // non parsable = probablement dynamique
  }
  return "statique";
}

export function parseUtm(href: string): Record<string, string> {
  try {
    const u = new URL(href);
    const utm: Record<string, string> = {};
    for (const [k, v] of u.searchParams) {
      if (k.toLowerCase().startsWith("utm_")) utm[k.toLowerCase()] = v;
    }
    return utm;
  } catch {
    return {};
  }
}

// Params non-utm de la query string (ex "e=ADHOC_GLOBAL_OTO_EMAIL_...").
export function parseOtherParams(href: string): Record<string, string> {
  try {
    const u = new URL(href);
    const other: Record<string, string> = {};
    for (const [k, v] of u.searchParams) {
      if (!k.toLowerCase().startsWith("utm_")) other[k] = v;
    }
    return other;
  } catch {
    return {};
  }
}

export function unwrapSafeLink(href: string): { url: string; wasWrapped: boolean } {
  try {
    const u = new URL(href);
    if (u.hostname.endsWith(".safelinks.protection.outlook.com")) {
      const original = u.searchParams.get("url");
      if (original) return { url: decodeURIComponent(original), wasWrapped: true };
    }
  } catch {
    // href invalide — laissé tel quel
  }
  return { url: href, wasWrapped: false };
}

// Extrait les blocs conditionnels MSO pour ne pas rater liens/CTA Outlook.
function extractMsoBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<!--\[if[^\]]*mso[^\]]*\]>([\s\S]*?)<!\[endif\]-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) blocks.push(m[1]);
  return blocks;
}

// Multilingue : les mails de marché (JP/KO/ZH/DE/ES/IT…) n'écrivent pas "unsubscribe".
const UNSUB_RE =
  /d[ée]sinscri|d[ée]sabonn|unsubscribe|se d[ée]sinscrire|opt[- ]?out|abmelden|darse de baja|cancelar (la )?suscripci|annulla l'iscrizione|cancellarsi|退订|配信停止|配信解除|購読解除|수신거부|구독\s*취소/i;

// Caractères invisibles (ZWSP/ZWNJ/ZWJ/BOM/soft-hyphen/marques bidi) : utilisés
// en anti-spam ("b‍alenciag‍a.com") et en padding de préheader — ils
// cassent le matching brief↔email et polluent les textes. Supprimés (pas
// remplacés par un espace : ils ne marquent PAS une coupure de mot).
const ZERO_WIDTH_RE = /[​‌‍⁠﻿­‎‏]/g;
const cleanText = (s: string) => s.replace(ZERO_WIDTH_RE, "").replace(/\s+/g, " ").trim();

export function parseEmailFacts(html: string): EmailFacts {
  const $ = cheerio.load(html);
  const msoBlocks = extractMsoBlocks(html);
  const msoHtml = msoBlocks.join("\n");
  const $mso = msoBlocks.length ? cheerio.load(msoHtml) : null;

  // Liens (DOM principal + blocs MSO), dédupliqués par href+texte
  const links: EmailFacts["links"] = [];
  const seen = new Set<string>();
  const collectLinks = ($$: cheerio.CheerioAPI, inMso: boolean) => {
    $$("a[href]").each((_, el) => {
      const href = ($$(el).attr("href") || "").trim();
      const text = cleanText($$(el).text()).slice(0, 120);
      const key = `${href}|${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      const { url } = unwrapSafeLink(href);
      const otherParams = parseOtherParams(url);
      links.push({
        index: links.length,
        href: url,
        text,
        kind: classifyLink(url),
        utm: parseUtm(url),
        otherParams: Object.keys(otherParams).length ? otherParams : undefined,
        inMsoBlock: inMso,
      });
    });
  };
  collectLinks($, false);
  if ($mso) collectLinks($mso, true);

  // Images
  const images: EmailFacts["images"] = [];
  $("img").each((_, el) => {
    const src = ($(el).attr("src") || "").trim();
    const alt = $(el).attr("alt") ?? null;
    const width = $(el).attr("width");
    const height = $(el).attr("height");
    const w = Number(width), h = Number(height);
    const kind: "remote" | "cid" | "data" = src.startsWith("cid:")
      ? "cid"
      : src.startsWith("data:")
        ? "data"
        : "remote";
    images.push({
      index: images.length,
      src: kind === "data" ? `data:(inline, ${Math.round(src.length / 1024)}KB)` : src,
      alt,
      width,
      height,
        // Regex ANCRÉE : "max-width:100%" et "width:100px" ne sont PAS des pixels
      // (début de déclaration avant "width", fin de valeur après le "1").
      isTrackingPixel:
        (w === 1 && h === 1) ||
        /(?:^|[;\s"'])width\s*[:=]\s*["']?1(?:px)?\s*(?:;|!|"|'|$)/i.test($(el).attr("style") || ""),
      kind,
    });
  });

  // Textes visibles — texte COMPLET de chaque bloc feuille (les balises inline
  // <strong>/<a>/<em> restent incluses, sinon "-40%" ou "ETE40" disparaîtraient
  // et les agents inventeraient des absences → faux positifs).
  $("style, script").remove();
  // Un <br> est une coupure visuelle : sans ça, cheerio .text() colle les mots
  // ("Bowling Bag.<br><br>A practical" → "Bag.A practical") et le matching
  // brief↔email produit de faux "le texte diffère".
  $("br").replaceWith(" ");
  const textBlocks: string[] = [];
  $("p, h1, h2, h3, h4, li, td").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    // un <td> conteneur (qui contient d'autres blocs) dupliquerait leurs textes
    if (tag === "td" && $(el).find("p, h1, h2, h3, h4, li, td, table").length > 0) return;
    const text = cleanText($(el).text());
    if (text.length > 2 && !textBlocks.includes(text)) textBlocks.push(text);
  });

  // Préheader : premier bloc texte caché ou premier texte du body
  let preheader: string | undefined;
  $("[style]").each((_, el) => {
    if (preheader) return;
    const style = ($(el).attr("style") || "").toLowerCase();
    if (/display\s*:\s*none|max-height\s*:\s*0|font-size\s*:\s*[01]px/.test(style)) {
      const t = cleanText($(el).text());
      if (t.length > 5) preheader = t.slice(0, 200);
    }
  });

  // Footer : derniers blocs texte
  const footerText = textBlocks.slice(-6).join(" · ").slice(0, 600);

  const personalizationTokens = Array.from(
    new Set((html.match(/%%[a-zA-Z_][a-zA-Z0-9_]*%%/g) || []).slice(0, 30))
  );
  const ampscriptSnippets = Array.from(
    new Set((html.match(AMPSCRIPT_RE) || []).slice(0, 30))
  ).map((s) => s.slice(0, 120));

  // Désinscription : texte du lien, href, OU texte du bloc parent — les mails
  // de marché mettent souvent "ここ"/"here" avec la mention dans la phrase autour.
  let hasUnsubscribeLink = links.some(
    (l) => (UNSUB_RE.test(l.text) || UNSUB_RE.test(l.href)) && l.kind !== "anchor" && l.href !== ""
  );
  if (!hasUnsubscribeLink) {
    $("a[href]").each((_, el) => {
      if (hasUnsubscribeLink) return;
      const href = ($(el).attr("href") || "").trim();
      if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
      const context = cleanText($(el).closest("td, p, div").first().text()).slice(0, 300);
      if (UNSUB_RE.test(context)) hasUnsubscribeLink = true;
    });
  }

  return {
    subject: $("title").text().trim() || undefined,
    preheader,
    htmlSizeBytes: Buffer.byteLength(html, "utf-8"),
    links,
    images,
    textBlocks: textBlocks.slice(0, 150),
    msoBlockCount: msoBlocks.length,
    hasUnsubscribeLink,
    personalizationTokens,
    ampscriptSnippets,
    footerText,
    lang: $("html").attr("lang") || undefined,
  };
}

// Version compacte pour les prompts (budget < ~12k tokens)
export function factsForPrompt(facts: EmailFacts): string {
  const compact = {
    subject: facts.subject,
    preheader: facts.preheader,
    htmlSizeKB: Math.round(facts.htmlSizeBytes / 1024),
    lang: facts.lang,
    links: facts.links.map((l) => ({
      i: l.index,
      href: l.href.slice(0, 200),
      text: l.text,
      kind: l.kind,
      utm: Object.keys(l.utm).length ? l.utm : undefined,
      other: l.otherParams && Object.keys(l.otherParams).length ? l.otherParams : undefined,
      mso: l.inMsoBlock || undefined,
    })),
    images: facts.images.map((im) => ({
      i: im.index,
      src: im.src.slice(0, 200),
      alt: im.alt,
      pixel: im.isTrackingPixel || undefined,
      kind: im.kind,
    })),
    personalizationTokens: facts.personalizationTokens,
    ampscript: facts.ampscriptSnippets,
    hasUnsubscribeLink: facts.hasUnsubscribeLink,
    footer: facts.footerText,
    texts: facts.textBlocks,
  };
  let out = JSON.stringify(compact, null, 1);
  if (out.length > 48_000) {
    compact.texts = compact.texts.slice(0, 60);
    out = JSON.stringify(compact, null, 1);
  }
  return out;
}
