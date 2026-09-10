// Rendu RÉEL Gmail Web / Outlook Web — Playwright sur profil persistant.
//
// Principe : le mail de test est DÉJÀ dans la boîte (c'est par là que Sentinel
// l'ingère). On rouvre le message dans le vrai client web avec un navigateur
// dont le profil garde les sessions (login manuel unique via `npm run
// render:login`), et on screenshote le corps du message tel que le client le
// rend réellement (réécriture HTML Gmail comprise).
//
// Contraintes :
// - Un profil persistant ne supporte qu'UN navigateur à la fois → mutex module
//   (les captures du batch parallèle se sérialisent ici, ~5-10 s chacune).
// - Jamais de login automatisé (ToS Google/Microsoft + captcha) : si la session
//   est absente, on échoue proprement → l'analyse continue sans rendu réel.
// - Screenshots persistés dans .data/renders/<versionId>/<provider>.png :
//   re-analyser une version écrase sa capture (le HTML n'a pas changé, le
//   rendu réel peut, ex. images distantes).

import { promises as fs } from "fs";
import path from "path";

export const PROFILE_DIR = path.join(process.cwd(), ".playwright", "profile");
const RENDERS_DIR = path.join(process.cwd(), ".data", "renders");

export interface RealRender {
  provider: "gmail" | "outlook";
  /** "desktop" (1280) ou "mobile-<largeur>" — la LARGEUR CSS du viewport
   *  déclenche les media queries responsive du mail dans le vrai client.
   *  Approximation de 1er niveau : vraie sanitation/réécriture Gmail, mais
   *  pas le moteur de l'app native iOS/Android (ça, c'est Litmus). */
  device: string;
  file: string; // chemin absolu du PNG
  capturedAt: string;
}

/** Largeurs capturées pour chaque message (largeur CSS, pas résolution
 *  physique — la hauteur est un viewport géant anti-lazy-loading, le mail
 *  défile de toute façon) :
 *  320 = petit écran worst case (iPhone SE) · 360 = Android standard
 *  (Galaxy/Pixel compacts) · 390 = iPhone récents · 430 = iPhone Plus/Max
 *  et grands Android. */
const GIANT_HEIGHT = 6500;
export const DEVICES: Array<{ device: string; width: number }> = [
  { device: "desktop", width: 1280 },
  { device: "mobile-320", width: 320 },
  { device: "mobile-360", width: 360 },
  { device: "mobile-390", width: 390 },
  { device: "mobile-430", width: 430 },
];

/** Sous-ensemble envoyé au juge vision (coût maîtrisé) : desktop + iPhone
 *  standard + worst case. Les autres largeurs restent visibles dans l'UI. */
export const VISION_DEVICES = ["desktop", "mobile-390", "mobile-320"];

/** Libellé humain d'un device ("mobile-390" → "mobile 390px"). */
export function deviceLabel(device: string): string {
  return device === "desktop" ? "desktop" : `mobile ${device.replace("mobile-", "")}px`;
}

/** Le rendu réel est-il activé et le profil navigateur initialisé ? */
export async function renderSessionAvailable(): Promise<boolean> {
  if (process.env.RENDER_REAL === "0") return false;
  try {
    await fs.access(path.join(PROFILE_DIR, "Default"));
    return true;
  } catch {
    return false;
  }
}

export function renderDir(versionId: string): string {
  return path.join(RENDERS_DIR, versionId);
}

/** Renders déjà capturés pour une version (pour l'UI).
 *  Legacy : "<provider>.png" (avant desktop/mobile) est traité comme desktop. */
export async function listRenders(versionId: string): Promise<RealRender[]> {
  const dir = renderDir(versionId);
  try {
    const files = await fs.readdir(dir);
    const out: RealRender[] = [];
    for (const f of files) {
      const m = /^(gmail|outlook)(?:-(desktop|mobile-\d{3}))?\.png$/.exec(f);
      if (!m) continue;
      const provider = m[1] as RealRender["provider"];
      const device = m[2] ?? "desktop";
      // Legacy "<provider>.png" ignoré si un "-desktop" plus récent existe.
      if (!m[2] && files.includes(`${provider}-desktop.png`)) continue;
      const stat = await fs.stat(path.join(dir, f));
      out.push({ provider, device, file: path.join(dir, f), capturedAt: stat.mtime.toISOString() });
    }
    // Desktop d'abord, puis mobiles par largeur croissante — ordre stable.
    const rank = (d: string) => (d === "desktop" ? 0 : Number(d.replace("mobile-", "")) || 999);
    return out.sort((a, b) => a.provider.localeCompare(b.provider) || rank(a.device) - rank(b.device));
  } catch {
    return [];
  }
}

// ── Mutex module : un seul navigateur sur le profil persistant à la fois. ──
let chain: Promise<unknown> = Promise.resolve();
function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/** URL d'ouverture du message dans le client web. Outlook nécessite le
 *  webLink Graph (l'id seul ne fait pas un deep-link stable). */
async function messageUrl(
  provider: "gmail" | "outlook",
  providerMessageId: string
): Promise<string> {
  if (provider === "gmail") {
    return `https://mail.google.com/mail/u/0/#all/${providerMessageId}`;
  }
  // Outlook : webLink via Graph (token de la connexion inbox existante).
  const { outlookWebLink } = await import("./outlook");
  return outlookWebLink(providerMessageId);
}

/** Capture le rendu réel d'un message en DESKTOP (1280) puis MOBILE (412 —
 *  les media queries responsive du mail se déclenchent à cette largeur).
 *  Throw avec un message actionnable si la session est absente/expirée —
 *  l'appelant loggue et continue. */
export async function captureRealRender(opts: {
  provider: "gmail" | "outlook";
  providerMessageId: string;
  versionId: string;
  /** HTML d'origine du mail — rendu directement aux largeurs mobiles
   *  (le web Gmail desktop n'est pas exploitable sous ~1000px : son UI
   *  écrase la zone message de façon imprévisible). */
  html: string;
  timeoutMs?: number;
}): Promise<RealRender[]> {
  const { provider, providerMessageId, versionId } = opts;
  const timeout = opts.timeoutMs ?? 45_000;
  const url = await messageUrl(provider, providerMessageId);

  return withBrowserLock(async () => {
    const { chromium } = await import("playwright");
    // MÊME canal que render-login (msedge) : le profil persistant doit être
    // ouvert par le même navigateur que celui du login. Flags anti-détection :
    // Google/Microsoft coupent les sessions des navigateurs "automatisés".
    // VIEWPORT GÉANT : Gmail lazy-load les images à l'entrée du viewport ET
    // dé-rend ce qui en sort (virtualisation) → scroller donne des captures
    // trouées. Avec tout le mail visible d'un coup, tout se charge, zéro scroll.
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: process.env.RENDER_HEADFUL !== "1",
      channel: "msedge",
      viewport: { width: DEVICES[0].width, height: GIANT_HEIGHT },
      locale: "fr-FR",
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
    });
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });

      // Session absente → redirection vers la page de login.
      const landed = page.url();
      if (/accounts\.google\.com|login\.microsoftonline|login\.live\.com/.test(landed)) {
        throw new Error(
          `session ${provider} absente ou expirée — lancer \`npm run render:login\` et se connecter une fois`
        );
      }

      // Corps du message : sélecteur du client, fallback pleine page.
      const bodySelector =
        provider === "gmail"
          ? "div.adn div.a3s" // conteneur du corps d'un message ouvert
          : "div[role='document'], div[aria-label='Corps du message'], div[aria-label='Message body']";
      const body = page.locator(bodySelector).first();

      await fs.mkdir(renderDir(versionId), { recursive: true });
      // Legacy (schémas de nommage précédents) : purgé pour éviter les doublons.
      await fs.unlink(path.join(renderDir(versionId), `${provider}.png`)).catch(() => undefined);
      await fs.unlink(path.join(renderDir(versionId), `${provider}-mobile.png`)).catch(() => undefined);

      const out: RealRender[] = [];

      // ── DESKTOP : capture dans le VRAI client web (Gmail/Outlook). ──
      const desktopFile = path.join(renderDir(versionId), `${provider}-desktop.png`);
      try {
        await body.waitFor({ state: "visible", timeout });
        // Mail plus grand que le viewport géant ? On agrandit pour tout charger.
        const box = await body.boundingBox();
        const needed = Math.ceil((box?.y ?? 0) + (box?.height ?? 0)) + 400;
        if (needed > GIANT_HEIGHT) {
          await page.setViewportSize({ width: DEVICES[0].width, height: Math.min(9500, needed) });
          await page.waitForTimeout(1200);
        }
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
        await page.waitForTimeout(2000); // laisser les images distantes se peindre
        await body.screenshot({ path: desktopFile, timeout });
      } catch {
        // Message introuvable par sélecteur (DOM client changé) : pleine page,
        // le juge vision reçoit quand même le rendu réel.
        await page.screenshot({ path: desktopFile, fullPage: true });
      }
      out.push({ provider, device: "desktop", file: desktopFile, capturedAt: new Date().toISOString() });

      // ── LARGEURS MOBILES : HTML d'origine rendu directement (moteur
      // Chromium, media queries réelles) — aperçu responsive de 1er niveau,
      // pas le client mail (le web Gmail est inutilisable sous ~1000px). ──
      for (const d of DEVICES.filter((x) => x.device !== "desktop")) {
        const file = path.join(renderDir(versionId), `${provider}-${d.device}.png`);
        const mp = await ctx.newPage();
        try {
          await mp.setViewportSize({ width: d.width, height: 1200 });
          await mp.setContent(opts.html, { waitUntil: "load", timeout });
          await mp.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
          await mp.waitForTimeout(1200);
          await mp.screenshot({ path: file, fullPage: true, timeout });
          out.push({ provider, device: d.device, file, capturedAt: new Date().toISOString() });
        } catch {
          // Largeur en échec : on continue, les autres captures restent valides.
        } finally {
          await mp.close().catch(() => undefined);
        }
      }
      return out;
    } finally {
      await ctx.close();
    }
  });
}
