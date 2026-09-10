// Oracle des PLACEHOLDERS du template Kering — extrait du template vierge
// (lib/__tests__/fixtures/blank-template.xlsm, régénérable via
// scripts/extract-placeholders.mjs). Sert à :
//  - ne jamais prendre un placeholder de la colonne VALUE pour du contenu réel
//    (la colonne VALUE de "Campaign Brief" recopie TOUJOURS le template ;
//    le vrai contenu vit dans les colonnes langue à droite) ;
//  - détecter un template vierge uploadé par erreur (isLikelyTemplate).
// IMPORTANT : le ban ne s'applique que lorsqu'un contenu réel existe par
// ailleurs — un template 100% vierge garde ses blocs (bannière template).

const PLACEHOLDER_TEXTS = new Set([
  "dear [name], discover…",
  "dear client, discover…",
  "discover our exclusive collection…",
  "discover our new arrivals…",
  "encourage the client to visit the boutique within the next days.",
  "exclusive access to our new drop. shop now:",
  "explore the latest arrivals →",
  "follow up - phone order",
  "hello — promo message here",
  "shop now",
  "short editorial paragraph…",
  "spring — summer 2026",
  "text + image carousel",
  "text + image or article card",
  "800×600px or 720×720px jpg",
  "friendtalk: 800×600 | wide: 800×600",
  "wechat_card_gucci.jpg",
]);

// PAS de motif générique "[...]"/"%%…%%" : les crochets et tokens AMPscript
// sont de la personnalisation LÉGITIME dans les briefs réels ("Hola [Nombre
// del Cliente]", %%firstname%%) — seul le vocabulaire EXACT du template fait foi.

const PLACEHOLDER_URL_RE = /^https?:\/\/brand\.(com|cn)(\/|$)/i;

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Texte identique à un placeholder du template (comparaison normalisée). */
export function isPlaceholderText(s: string): boolean {
  const n = norm(s);
  if (!n) return false;
  return PLACEHOLDER_TEXTS.has(n);
}

/** URL du domaine fictif du template (brand.com / brand.cn). */
export function isPlaceholderUrl(s: string): boolean {
  return PLACEHOLDER_URL_RE.test(s.trim());
}
