// Seed des données de démo — écrit directement dans .data/ (store fichiers).
// Usage : npm run seed
import { promises as fs } from "fs";
import path from "path";

const DATA = path.join(process.cwd(), ".data");
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const now = new Date().toISOString();

async function put(kind, id, value) {
  await fs.mkdir(path.join(DATA, kind), { recursive: true });
  await fs.writeFile(
    path.join(DATA, kind, `${id}.json`),
    JSON.stringify(value, null, 2)
  );
}

// ---------- Marque de démo avec règles compilées ----------
const brandId = uid();
const brand = {
  id: brandId,
  name: "MAPAUSE",
  allowedLinkDomains: ["aurapause.com", "instagram.com"],
  guidelinesSourceText: `- Vouvoiement obligatoire dans toutes les communications (jamais de tutoiement, sauf citations clients entre guillemets).
- Prix au format français : 99,90 € avec espace avant le symbole (jamais €99.90).
- Objet de 50 caractères maximum, pas de mot entièrement en majuscules, maximum un point d'exclamation par email.
- Toute promotion doit afficher la mention « Offre valable en France métropolitaine ».
- Ton élégant et chaleureux, jamais de pression commerciale agressive (pas de "Dernière chance !!!", pas de compte à rebours anxiogène).
- Le mot "gratuit" est interdit — utiliser "offert".`,
  compiledRules: [
    {
      id: "vouvoiement-obligatoire",
      title: "Vouvoiement obligatoire",
      description:
        "Aucun tutoiement adressé au lecteur (tu, ton/ta/tes, impératifs 2e personne du singulier). Exceptions : citations clients entre guillemets.",
      category: "tone",
      engine: "hybrid",
      severity: "error",
      params: { check: "forbidden_terms", tokens: [] },
      examples: {
        good: ["Profitez de vos avantages"],
        bad: ["Profite de tes avantages"],
      },
      exceptions: ["citations clients entre guillemets"],
      enabled: true,
    },
    {
      id: "format-prix-fr",
      title: "Prix au format français",
      description: "Les prix s'écrivent 99,90 € (virgule, espace avant €), jamais €99.90 ni 99.90€.",
      category: "format",
      engine: "llm",
      severity: "warning",
      examples: { good: ["49,90 €"], bad: ["€49.90", "49.90€"] },
      enabled: true,
    },
    {
      id: "objet-max-50",
      title: "Objet ≤ 50 caractères",
      description: "L'objet de l'email ne dépasse pas 50 caractères.",
      category: "format",
      engine: "code",
      severity: "warning",
      params: { check: "max_length", max: 50 },
      enabled: true,
    },
    {
      id: "mention-france-metropolitaine",
      title: "Mention promotions obligatoire",
      description:
        "Toute promotion doit afficher la mention exacte « Offre valable en France métropolitaine ».",
      category: "legal",
      engine: "code",
      severity: "error",
      params: { check: "required_text", exactText: "Offre valable en France métropolitaine" },
      enabled: true,
    },
    {
      id: "interdiction-gratuit",
      title: "« Gratuit » interdit",
      description: "Le mot « gratuit » est interdit, utiliser « offert ».",
      category: "lexical",
      engine: "code",
      severity: "warning",
      params: { check: "forbidden_terms", tokens: ["gratuit", "gratuite"] },
      enabled: true,
    },
    {
      id: "ton-non-agressif",
      title: "Pas de pression commerciale agressive",
      description:
        "Ton élégant et chaleureux : pas de « Dernière chance !!! », pas de compte à rebours anxiogène, maximum un point d'exclamation.",
      category: "tone",
      engine: "llm",
      severity: "warning",
      examples: { good: ["Les soldes commencent aujourd'hui."], bad: ["DERNIÈRE CHANCE !!! Plus que 2h !"] },
      enabled: true,
    },
  ],
  compiledAt: now,
  version: 2,
};
await put("brands", brandId, brand);

// ---------- Campagne de démo complète (brief + email v1 piégé) ----------
const briefRaw = `Objet : Brief campagne — Lancement Brume Visage MAPAUSE Aura, vague été

Bonjour,

Voici les éléments pour la campagne Lancement Brume Visage — Été 2026.

Marché : France. Type : email promotionnel.
Cible : femmes 45-60 ans, abonnées newsletter, sensibilité bouffées de chaleur.
Date d'envoi souhaitée : 24/07/2026 à 9h00.

Objet retenu : "Votre alliée fraîcheur de l'été est arrivée"
Préheader : "La brume visage MAPAUSE Aura : -20% avec le code AURA20"

Message clé : lancement de la brume visage MAPAUSE Aura, le geste fraîcheur contre les bouffées de chaleur.
Offre : -20% + livraison offerte avec le code AURA20 (valable jusqu'au 31/07/2026).
CTA principal : "Je découvre" vers https://aurapause.com/

Plan de tracking : utm_source=sfmc, utm_medium=email, utm_campaign=lancement_brume_ete sur les liens commerciaux.
Mentions légales : rappeler "Offre valable en France métropolitaine".
Ton : vouvoiement, chaleureux et rassurant, conforme à la charte MAPAUSE.

Merci !
Camille — équipe CRM`;

const q = (s) => s; // les quotes doivent être des sous-chaînes exactes du briefRaw

const briefExtraction = {
  campaign_name: { value: "Lancement Brume Visage — Été 2026", quote: q("campagne Lancement Brume Visage — Été 2026"), confidence: "high" },
  market: { value: "France", quote: q("Marché : France"), confidence: "high" },
  email_type: { value: "email promotionnel", quote: q("Type : email promotionnel"), confidence: "high" },
  target_audience: { value: "femmes 45-60 ans, abonnées newsletter, sensibilité bouffées de chaleur", quote: q("Cible : femmes 45-60 ans, abonnées newsletter, sensibilité bouffées de chaleur"), confidence: "high" },
  send_datetime: { value: "2026-07-24T09:00", quote: q("Date d'envoi souhaitée : 24/07/2026 à 9h00"), confidence: "high" },
  subject_line: { value: "Votre alliée fraîcheur de l'été est arrivée", quote: q('Objet retenu : "Votre alliée fraîcheur de l\'été est arrivée"'), confidence: "high" },
  preheader: { value: "La brume visage MAPAUSE Aura : -20% avec le code AURA20", quote: q('Préheader : "La brume visage MAPAUSE Aura : -20% avec le code AURA20"'), confidence: "high" },
  key_message: { value: "Lancement de la brume visage MAPAUSE Aura, le geste fraîcheur contre les bouffées de chaleur", quote: q("lancement de la brume visage MAPAUSE Aura, le geste fraîcheur contre les bouffées de chaleur"), confidence: "high" },
  offer: { value: "-20% + livraison offerte avec le code AURA20 (valable jusqu'au 31/07/2026)", quote: q("Offre : -20% + livraison offerte avec le code AURA20 (valable jusqu'au 31/07/2026)"), confidence: "high" },
  promo_code: { value: "AURA20", quote: q("avec le code AURA20"), confidence: "high" },
  cta_label: { value: "Je découvre", quote: q('CTA principal : "Je découvre"'), confidence: "high" },
  landing_urls: { value: "https://aurapause.com/", quote: q("vers https://aurapause.com/"), confidence: "high" },
  utm_campaign: { value: "lancement_brume_ete", quote: q("utm_campaign=lancement_brume_ete sur les liens commerciaux"), confidence: "high" },
  legal_mentions: { value: "Offre valable en France métropolitaine", quote: q('rappeler "Offre valable en France métropolitaine"'), confidence: "high" },
  missing_fields: [],
};

const emailV1 = await fs.readFile(new URL("../samples/demo-email-v1.html", import.meta.url), "utf-8");

const demoId = uid();
await put("campaigns", demoId, {
  id: demoId,
  name: "Lancement Brume Visage — Été 2026",
  brandId,
  period: "2026-T3",
  status: "EN_ANALYSE",
  briefRaw,
  briefExtraction,
  versions: [
    {
      id: uid(),
      label: "v1",
      receivedAt: now,
      source: "colle",
      html: emailV1,
    },
  ],
  createdAt: now,
  updatedAt: now,
  sendDate: "2026-07-24T09:00",
});

console.log("✓ Seed terminé :");
console.log(`  - Marque "Maison Lucet" (6 règles compilées)`);
console.log(`  - Campagne de démo "Soldes Été 2026 — lancement" (brief extrait + email v1 piégé)`);
console.log(`\nDémo : ouvrir la campagne → onglet Rapport → "Analyser cette version".`);
console.log(`La v2 corrigée est dans samples/demo-email-v2.html (à coller après la revue).`);
