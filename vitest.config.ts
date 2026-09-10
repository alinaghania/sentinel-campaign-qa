import path from "node:path";
import { defineConfig } from "vitest/config";

// Budget de temps par test — 20 s, et non le défaut vitest de 5 s.
//
// MESURÉ le 03/09/2026. Deux tests lisent et parsent le VRAI classeur
// (`blank-template.xlsm`) : `brief-template.test.ts:64` et
// `brief-lang-columns.test.ts:114`. Isolés, les deux fichiers passent en
// 7,4 s pour 28 tests (rc=0). Dans la suite complète, 21 fichiers s'importent
// en parallèle — l'import cumulé monte à 30–50 s — et ces deux-là dépassent
// 5 s : rouge 2 fois sur 2, vert 2 fois sur 2 en isolé. En relançant la suite
// ENTIÈRE avec `--testTimeout=60000` : rc=0, 430 passés. Le seuil était donc
// la seule cause, pas le code.
//
// Pourquoi global et pas un 3e argument sur ces deux `it()` : le coût est
// porté par le PREMIER parse de classeur d'un worker, pas par un test en
// particulier — lequel le paie dépend de l'ordonnancement. Le fixer test par
// test reviendrait à courir derrière au fil des tests de template qu'on
// continue d'ajouter.
//
// 20 s et pas 60 : un vrai blocage doit rester rapide à voir. Ce budget
// couvre l'E/S disque sous charge, il ne couvre pas un deadlock.
//
// L'enjeu n'est pas le confort : cette porte est PARTAGÉE. Un rouge dont la
// cause est la charge de la machine et non le code apprend à l'équipe à
// passer outre — et le jour où il signale une vraie régression, il ne sera
// pas cru.
export default defineConfig({
  // Même alias que `tsconfig.json` ("@/*" → "./*"). Sans lui, tout module
  // important via "@/..." — c'est-à-dire tout `app/api/**/route.ts` — est
  // introuvable sous vitest : les routes n'étaient pas dures à tester, elles
  // étaient hors d'atteinte du harnais.
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    testTimeout: 20_000,
  },
});
