// Aller-retour : un tableau composé en classeur, relu par le parseur de
// production, doit revenir à l'identique dans le tableau.
import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, buildTemplateWorkbook } from "../brief-template";
import { parseBriefGrid } from "../brief-grid";
import { gridToFill, templateGap } from "../brief-prefill";

describe("gridToFill", () => {
  it("restitue dans le tableau ce que le parseur a lu", async () => {
    const textField = DEFAULT_TEMPLATE.fields.find((f) => f.kind === "text" && f.translatable)!;
    const lang = DEFAULT_TEMPLATE.languageColumns[0];
    const fill = { [textField.key]: { [lang]: "Bonjour le monde" } };
    const buf = await buildTemplateWorkbook(DEFAULT_TEMPLATE, fill);
    const grid = await parseBriefGrid(buf);
    expect(grid).not.toBeNull();
    const out = gridToFill(grid!, DEFAULT_TEMPLATE);
    expect(out.fill[textField.key]?.[lang]).toBe("Bonjour le monde");
    expect(out.cells).toBeGreaterThan(0);
  });

  it("rend les libellés sans champ au lieu de les jeter", () => {
    const out = gridToFill(
      { languages: ["EN"], blocks: [{ name: "Totally unknown row", valueByLang: { EN: "x" } }], expectedLinks: [] },
      DEFAULT_TEMPLATE
    );
    expect(out.cells).toBe(0);
    expect(out.unmatched).toEqual([{ label: "Totally unknown row", kind: "text", translatable: true }]);
  });

  it("propose les champs et colonnes manquants, et plus rien ne reste ensuite", () => {
    const grid = {
      languages: ["EN", "FR"],
      blocks: [{ name: "Loyalty banner", valueByLang: { EN: "Hi", FR: "Salut" } }],
      expectedLinks: [{ block: "Loyalty", linksByMarket: { WW: "https://a.b" } }],
    };
    const gap = templateGap(grid, DEFAULT_TEMPLATE);
    expect(gap.rows.map((r) => r.label)).toEqual(["Loyalty banner", "Loyalty URL"]);
    const extended = {
      languageColumns: [...DEFAULT_TEMPLATE.languageColumns, ...gap.languageColumns],
      fields: [
        ...DEFAULT_TEMPLATE.fields,
        ...gap.rows.map((r, i) => ({
          key: `n${i}`, label: r.label, description: "", master: "", rowOffset: 900 + i,
          kind: r.kind, required: false, translatable: r.translatable,
        })),
      ],
    };
    const after = gridToFill(grid, extended);
    expect(after.unmatched).toEqual([]);
    expect(after.fill.n0).toEqual({ EN: "Hi", FR: "Salut" });
    expect(templateGap(grid, extended).rows).toEqual([]);
  });
});
