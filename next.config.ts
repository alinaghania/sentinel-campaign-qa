import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build autonome pour Docker/Azure : `.next/standalone` contient server.js
  // + les node_modules tracés (cf. node_modules/next/dist/docs .../output.md).
  output: "standalone",
  // Playwright n'est jamais exécuté sur Azure (RENDER_REAL=0) : on l'exclut du
  // trace pour garder une image légère. La clé "*" est matchée par picomatch
  // en mode `contains` → couvre TOUTES les routes ainsi que le trace
  // `next-server` (vérifié dans next/dist/build/collect-build-traces.js).
  outputFileTracingExcludes: {
    "*": [
      "node_modules/playwright/**",
      "node_modules/playwright-core/**",
      "node_modules/@playwright/**",
      // Données locales et profil navigateur : jamais dans le bundle
      // (montés via Azure Files au runtime). Le trace nft les aspire sinon
      // (lecture fs relative à process.cwd() dans lib/store.ts).
      ".data/**",
      ".playwright/**",
    ],
  },
};

export default nextConfig;
