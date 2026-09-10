// Récupération automatique du logo officiel d'une marque depuis son site :
// apple-touch-icon (haute résolution) → <link rel=icon> le plus grand →
// <img> "logo" du header → fallback Clearbit Logo API. SSRF-guardé.

import * as cheerio from "cheerio";
import { assertPublicUrl } from "./check-links";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function urlOk(url: string): Promise<boolean> {
  try {
    await assertPublicUrl(url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return false;
    const type = res.headers.get("content-type") ?? "";
    return type.startsWith("image/");
  } catch {
    return false;
  }
}

export async function fetchBrandLogo(domain: string): Promise<string | null> {
  const base = `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const candidates: string[] = [];

  try {
    await assertPublicUrl(base);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(base, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    if (res.ok) {
      const html = (await res.text()).slice(0, 500_000);
      const $ = cheerio.load(html);
      const abs = (u: string) => new URL(u, res.url).toString();

      // 1. apple-touch-icon (souvent 180×180, le meilleur candidat)
      $('link[rel~="apple-touch-icon"]').each((_, el) => {
        const href = $(el).attr("href");
        if (href) candidates.push(abs(href));
      });
      // 2. <link rel=icon> — trié par taille déclarée décroissante
      const icons: Array<{ href: string; size: number }> = [];
      $('link[rel~="icon"]').each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const size = parseInt(($(el).attr("sizes") ?? "0").split("x")[0]) || 0;
        icons.push({ href: abs(href), size });
      });
      icons.sort((a, b) => b.size - a.size);
      candidates.push(...icons.map((i) => i.href));
      // 3. <img> du site avec "logo" dans src/alt/class (header en priorité)
      $("header img, nav img, img").each((_, el) => {
        const src = $(el).attr("src") ?? "";
        const alt = $(el).attr("alt") ?? "";
        const cls = $(el).attr("class") ?? "";
        if (/logo/i.test(`${src} ${alt} ${cls}`) && src && !src.startsWith("data:")) {
          candidates.push(abs(src));
        }
      });
    }
  } catch {
    // site injoignable — on tente les fallbacks
  }

  // 4. Fallbacks : Clearbit Logo API puis favicon Google
  const host = new URL(base).hostname;
  candidates.push(`https://logo.clearbit.com/${host}`);
  candidates.push(`https://www.google.com/s2/favicons?domain=${host}&sz=128`);

  for (const url of [...new Set(candidates)]) {
    if (await urlOk(url)) return url;
  }
  return null;
}
