// L'ARRIVÉE. Le fichier voisin (glossary.test.ts) mesure ce que le bloc
// contient ; celui-ci mesure qu'il ARRIVE — à chaque worker, sans exception.
//
// Pourquoi les deux ne peuvent pas être un seul test. Une fonction qui rend le
// bon texte et un prompt qui ne le contient pas se ressemblent parfaitement de
// l'extérieur : l'écran affiche le glossaire, la fonction le compose, et le
// modèle ne l'a jamais lu. C'est la forme exacte du réglage MUET que le dépôt a
// déjà payée une fois — les exemples saisis dans /rules n'atteignaient pas
// l'agent vision, qui reconstruisait son prompt à la main.
//
// Deux pièges sont donc visés nommément :
//   - `WorkerCtx` est une interface FERMÉE. `buildWorkerCtx` peut très bien
//     renvoyer un champ de plus : il est silencieusement absent du contexte que
//     les workers reçoivent, avec `tsc` au vert. C'est arrivé à
//     `salesforceCampaignName`, passé depuis analyze.ts, qui n'atteint aucun
//     agent à ce jour.
//   - un worker à protocole spécialisé (`runner`) n'emprunte PAS runWorker.
//     Le seul qui existe aujourd'hui — l'arbitre de traduction — est justement
//     celui qui a le plus besoin de savoir que MX est le Mexique et non
//     l'Espagne.
//
// LLM entièrement mocké : ce qu'on inspecte est le message CONSTRUIT, pas une
// réponse.
import { describe, expect, it, vi } from "vitest";

vi.mock("../structured", () => ({
  runAgent: vi.fn(async () => ({ ok: false as const, error: "mock" })),
  verifyQuote: () => true,
}));
vi.mock("../foundry", () => ({
  workerModel: () => "mock-worker",
  judgeModel: () => "mock-judge",
  streamText: vi.fn(),
}));

import { runAgent } from "../structured";
import { WORKERS, buildWorkerCtx, runTranslationWorker, runWorker } from "../agents";
import { DEFAULT_TEMPLATE } from "../brief-template";
import type { EmailFacts } from "../types";

const mocked = vi.mocked(runAgent);
const PHRASE = "Le brief est écrit par l'agence, jamais par la marque.";
const TEMPLATE = { ...DEFAULT_TEMPLATE, glossary: PHRASE };

const facts = { subject: "S", links: [], images: [] } as unknown as EmailFacts;

function ctx(withTemplate: boolean) {
  return buildWorkerCtx({
    facts,
    linkResults: [],
    ...(withTemplate ? { template: TEMPLATE } : {}),
  });
}

/** Le dernier message utilisateur envoyé au modèle, en texte. */
function lastUserText(): string {
  const call = mocked.mock.calls.at(-1)?.[0] as { user: unknown } | undefined;
  const u = call?.user;
  return typeof u === "string" ? u : JSON.stringify(u);
}

describe("le glossaire atteint les agents", () => {
  it("buildWorkerCtx le POSE dans le contexte — sinon rien ne le transporte", () => {
    // Première marche : le champ doit être DÉCLARÉ dans WorkerCtx. Sans cette
    // assertion, tout le reste du fichier passerait sur un contexte où le
    // glossaire a été effacé par le typage, et les prompts seraient vides pour
    // une raison qu'aucun test ne nommerait.
    expect(ctx(true).glossaryBlock).toContain(PHRASE);
  });

  it("CHAQUE worker générique le reçoit dans son message utilisateur", async () => {
    const generiques = WORKERS.filter((w) => !w.runner);
    // Contrôle positif de POPULATION : une liste vide ferait passer la boucle
    // sans avoir rien vérifié — un « 0 sur 0 » qui se lit comme un succès.
    expect(generiques.length).toBeGreaterThan(3);

    for (const w of generiques) {
      mocked.mockClear();
      await runWorker(w, ctx(true), null);
      expect(lastUserText(), `le worker ${w.key} ne reçoit pas le glossaire`).toContain(PHRASE);
    }
  });

  it("l'arbitre de TRADUCTION aussi, bien qu'il n'emprunte pas runWorker", async () => {
    const trad = WORKERS.find((w) => w.runner === "translation");
    expect(trad, "le worker de traduction a disparu — ce cas ne mesure plus rien").toBeTruthy();
    if (!trad) return;
    mocked.mockClear();
    await runTranslationWorker(trad, ctx(true), [
      {
        findingId: "f1",
        lang: "FR",
        block: "subject",
        expected: "Bonjour",
        found: "Hello",
        similarity: 0.2,
      } as never,
    ]);
    expect(lastUserText()).toContain(PHRASE);
  });

  it("CONTRÔLE POSITIF — sans template, la phrase n'est nulle part", async () => {
    // Sans ce cas, les précédents passeraient aussi si la phrase venait d'un
    // autre bloc du prompt (les faits, les règles) plutôt que du glossaire.
    const w = WORKERS.find((x) => !x.runner)!;
    mocked.mockClear();
    await runWorker(w, ctx(false), null);
    expect(lastUserText()).not.toContain(PHRASE);
  });
});
