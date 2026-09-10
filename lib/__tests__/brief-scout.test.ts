// Tests du structure scout — LLM entièrement mocké (zéro réseau en CI).
import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefParsePlan } from "../schemas";

vi.mock("../structured", () => ({
  runAgent: vi.fn(),
}));
vi.mock("../foundry", () => ({
  judgeModel: () => "claude-opus-4-8",
}));

import { runAgent } from "../structured";
import {
  executeParsePlan,
  loadWorkbookSheets,
  runStructureScout,
  shouldScout,
  verifyPlan,
} from "../brief-scout";
import { workbookDigest } from "../brief-sheet-text";
import { emptyTelemetry } from "../brief-grid";

const mockedRunAgent = vi.mocked(runAgent);
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name));
const MX = fixture("mx-guadalajara.xlsm");

/** Plan CORRECT pour le fichier MX (vérifié contre le fichier réel). */
const validPlan = (): BriefParsePlan => ({
  content_sheet: "Campaign Brief",
  header_row: 6,
  label_col: "A",
  value_col_is_placeholder: true,
  lang_columns: [{ col: "D", lang: "MX" }],
  field_mappings: [
    { row: 7, raw_label: "Subject Line (male & others)", canonical_block: "Subject line", variant_suffix: "(male & others)", is_url_row: false, url_market: null, skip_reason: null },
    { row: 8, raw_label: "Subject Line (female)", canonical_block: "Subject line", variant_suffix: "(female)", is_url_row: false, url_market: null, skip_reason: null },
    { row: 9, raw_label: "Preheader", canonical_block: "Preheader", variant_suffix: null, is_url_row: false, url_market: null, skip_reason: null },
    { row: 13, raw_label: "CTA 1 Label", canonical_block: "CTA 1", variant_suffix: null, is_url_row: false, url_market: null, skip_reason: null },
    { row: 14, raw_label: "Hero Asset / CTA URL", canonical_block: null, variant_suffix: null, is_url_row: true, url_market: "WW", skip_reason: null },
  ],
  sample_checks: [
    { cell: "D7", snippet: "Bienvenido a Balenciaga" },
    { cell: "D9", snippet: "Blvd. Patria" },
  ],
  confidence: 0.93,
  notes: "Kering 14-sheet family, content in Campaign Brief column D (MX).",
});

beforeEach(() => {
  mockedRunAgent.mockReset();
});

describe("workbookDigest (sérialisation)", () => {
  it("grille adressée : R<n>, adresses colonne, hyperliens, convention déclarée", async () => {
    const digest = await workbookDigest(MX);
    expect(digest).toContain("Cellules vides omises");
    expect(digest).toContain('"Campaign Brief"');
    expect(digest).toMatch(/R6: .*A="FIELD"/);
    expect(digest).toContain("->http"); // hyperlien porté par une cellule
    expect(digest.length).toBeLessThan(60_000);
  });
});

describe("verifyPlan (vérification référentielle)", () => {
  it("plan correct → aucune erreur", async () => {
    const sheets = (await loadWorkbookSheets(MX))!;
    expect(verifyPlan(sheets, validPlan())).toEqual([]);
  });

  it("feuille hallucinée → rejet", async () => {
    const sheets = (await loadWorkbookSheets(MX))!;
    const errors = verifyPlan(sheets, { ...validPlan(), content_sheet: "Grille FR" });
    expect(errors[0]).toContain('sheet "Grille FR" does not exist');
  });

  it("libellé décalé d'une ligne → rejet avec message actionnable", async () => {
    const sheets = (await loadWorkbookSheets(MX))!;
    const plan = validPlan();
    plan.field_mappings[0].row = 8; // (male & others) déclaré sur la ligne (female)
    const errors = verifyPlan(sheets, plan);
    expect(errors.some((e) => e.includes("label mismatch at A8"))).toBe(true);
  });

  it("snippet introuvable → rejet", async () => {
    const sheets = (await loadWorkbookSheets(MX))!;
    const plan = validPlan();
    plan.sample_checks = [
      { cell: "D7", snippet: "texte totalement inventé" },
      { cell: "D9", snippet: "autre hallucination" },
    ];
    const errors = verifyPlan(sheets, plan);
    expect(errors.some((e) => e.includes("snippet"))).toBe(true);
  });

  it("langue inconnue → rejet", async () => {
    const sheets = (await loadWorkbookSheets(MX))!;
    const errors = verifyPlan(sheets, { ...validPlan(), lang_columns: [{ col: "D", lang: "XX" }] });
    expect(errors.some((e) => e.includes("not a recognized language"))).toBe(true);
  });
});

describe("executeParsePlan (exécution 100% code)", () => {
  it("copie les valeurs des cellules, filtre les placeholders, apparie CTA↔URL", async () => {
    const sheets = (await loadWorkbookSheets(MX))!;
    const grid = executeParsePlan(sheets, validPlan())!;
    expect(grid).not.toBeNull();
    expect(grid.languages).toEqual(["ES"]); // MX canonicalisé en interne
    expect(grid.langLabels).toEqual({ ES: "MX" }); // libellé du fichier affiché
    // Fidélité : noms = libellés EXACTS du fichier (raw_label), jamais renommés
    expect(grid.blocks.map((b) => b.name)).toEqual([
      "Subject Line (male & others)",
      "Subject Line (female)",
      "Preheader",
      "CTA 1 Label",
    ]);
    expect(grid.blocks[1].valueByLang.ES).toContain("Bienvenida");
    expect(grid.expectedLinks).toHaveLength(1);
    expect(grid.expectedLinks[0].ww).toContain("storelocator");
    expect(grid.expectedLinks[0].ctaLabelByLang?.ES).toBe("RESERVAR UNA CITA");
    expect(grid.meta?.source).toBe("scout");
  });
});

describe("runStructureScout (orchestration, LLM mocké)", () => {
  it("plan valide du premier coup → ok, 1 seul appel LLM", async () => {
    mockedRunAgent.mockResolvedValueOnce({ ok: true, data: validPlan(), usage: { input_tokens: 0, output_tokens: 0 }, attempts: 1, toolName: "emit_parse_plan" });
    const res = await runStructureScout(MX);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.confidence).toBe(0.93);
      expect(res.grid.blocks.length).toBeGreaterThan(0);
    }
    expect(mockedRunAgent).toHaveBeenCalledTimes(1);
  });

  it("plan halluciné puis corrigé → retry avec feedback, ok au 2e appel", async () => {
    mockedRunAgent
      .mockResolvedValueOnce({ ok: true, data: { ...validPlan(), content_sheet: "EMAIL FR" }, usage: { input_tokens: 0, output_tokens: 0 }, attempts: 1, toolName: "emit_parse_plan" })
      .mockResolvedValueOnce({ ok: true, data: validPlan(), usage: { input_tokens: 0, output_tokens: 0 }, attempts: 1, toolName: "emit_parse_plan" });
    const res = await runStructureScout(MX);
    expect(res.ok).toBe(true);
    expect(mockedRunAgent).toHaveBeenCalledTimes(2);
    // Le feedback des erreurs est renvoyé au modèle au 2e appel
    const secondUser = mockedRunAgent.mock.calls[1][0].user;
    expect(secondUser).toContain("Erreurs de vérification");
    expect(secondUser).toContain("EMAIL FR");
  });

  it("plan toujours invalide après retry → ok:false, grille intacte", async () => {
    const bad = { ...validPlan(), content_sheet: "Nowhere" };
    mockedRunAgent
      .mockResolvedValueOnce({ ok: true, data: bad, usage: { input_tokens: 0, output_tokens: 0 }, attempts: 1, toolName: "emit_parse_plan" })
      .mockResolvedValueOnce({ ok: true, data: bad, usage: { input_tokens: 0, output_tokens: 0 }, attempts: 1, toolName: "emit_parse_plan" });
    const res = await runStructureScout(MX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("plan rejected after retry");
  });

  it("confiance < 0.8 → ok:false avec warning explicite", async () => {
    mockedRunAgent.mockResolvedValueOnce({
      ok: true,
      data: { ...validPlan(), confidence: 0.55 },
      usage: { input_tokens: 0, output_tokens: 0 },
      attempts: 1,
      toolName: "emit_parse_plan",
    });
    const res = await runStructureScout(MX);
    expect(res.ok).toBe(false);
    expect(res.warnings.some((w) => w.includes("confidence too low"))).toBe(true);
  });

  it("LLM indisponible (429/timeout) → ok:false, jamais de throw", async () => {
    mockedRunAgent.mockResolvedValueOnce({ ok: false, error: "429 rate limited" });
    const res = await runStructureScout(MX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("429");
  });
});

describe("shouldScout (fast-path : 0 LLM sur les fichiers standards)", () => {
  it("grille propre sans perte → false ; grille nulle ou pertes → true", () => {
    const t = emptyTelemetry();
    const grid = { languages: ["ES"], blocks: [{ name: "CTA 1", valueByLang: { ES: "x" } }], expectedLinks: [] };
    expect(shouldScout(grid, t)).toBe(false);
    expect(shouldScout(null, t)).toBe(true);
    expect(shouldScout(grid, { ...t, unmappedFields: ["Objet du mail"] })).toBe(true);
  });
});
