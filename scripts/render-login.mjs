// Login MANUEL unique pour le rendu réel (npm run render:login).
// Ouvre une fenêtre Chrome sur le profil persistant du renderer : se connecter
// à Gmail (acnkering@gmail.com) puis à Outlook Web, et FERMER la fenêtre.
// Les sessions restent dans .playwright/profile — plus jamais besoin de login.
import { chromium } from "playwright";
import path from "path";

const PROFILE_DIR = path.join(process.cwd(), ".playwright", "profile");

// channel "msedge" + flags anti-détection : Google refuse le login sur le
// Chromium de test ("This browser or app may not be secure") mais accepte
// un vrai navigateur (Edge installé) sans les marqueurs d'automatisation.
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "msedge",
  viewport: { width: 1280, height: 900 },
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
});

const gmail = ctx.pages()[0] ?? (await ctx.newPage());
await gmail.goto("https://mail.google.com/");
const outlook = await ctx.newPage();
await outlook.goto("https://outlook.live.com/mail/");

console.log("");
console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ 1. Onglet 1 : connecte-toi à Gmail (acnkering@gmail.com)    │");
console.log("│ 2. Onglet 2 : connecte-toi à Outlook Web (compte perso)     │");
console.log("│ 3. Quand les deux inbox s'affichent, FERME la fenêtre.      │");
console.log("│    Les sessions sont sauvées dans .playwright/profile       │");
console.log("└─────────────────────────────────────────────────────────────┘");
console.log("");

await new Promise((resolve) => ctx.on("close", resolve));
console.log("Profil sauvegardé — le rendu réel est actif pour les prochaines analyses.");
