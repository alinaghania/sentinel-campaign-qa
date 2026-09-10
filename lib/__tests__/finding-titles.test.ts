import { describe, expect, it } from "vitest";
import {
  FINDING_TITLES,
  FINDING_TITLES_AGENT,
  TITLE_ALLOWED_CATEGORIES,
  TITLE_BY_CATEGORY,
  titleForFinding,
} from "../finding-titles";
import type { Finding } from "../types";

describe("finding-titles", () => {
  it("titre valide → repris tel quel", () => {
    expect(titleForFinding({ title: "Problem in the tracking", categorie: "liens" })).toBe(
      "Problem in the tracking"
    );
  });

  it("titre absent ou hors liste → fallback titre de la catégorie", () => {
    expect(titleForFinding({ categorie: "liens" })).toBe("Problem in a link");
    expect(titleForFinding({ title: "Random hallucinated title", categorie: "brief" })).toBe(
      "Problem in the translation"
    );
    expect(titleForFinding({ categorie: "delivrabilite" })).toBe(
      "Problem in the email authentication"
    );
  });

  it("catégorie inconnue (donnée persistée inattendue) → titre générique", () => {
    expect(
      titleForFinding({ categorie: "unknown" as Finding["categorie"] })
    ).toBe("Possible issue to review");
  });

  it("les 9 catégories ont un titre par défaut, tous dans FINDING_TITLES", () => {
    const all = new Set<string>(FINDING_TITLES);
    for (const t of Object.values(TITLE_BY_CATEGORY)) expect(all.has(t)).toBe(true);
  });

  it("liste agents = 11 titres, SANS les 2 titres auth (réservés au code)", () => {
    expect(FINDING_TITLES_AGENT).toHaveLength(11);
    expect(FINDING_TITLES_AGENT).not.toContain("Problem in the email authentication");
    expect(FINDING_TITLES_AGENT).not.toContain("Email authentication could not be verified");
  });

  it("cohérence title↔catégorie : liens seulement pour 'Problem in a link', toutes pour 'Possible issue to review'", () => {
    expect(TITLE_ALLOWED_CATEGORIES["Problem in a link"]).toEqual(["liens"]);
    expect(TITLE_ALLOWED_CATEGORIES["Possible issue to review"]).toHaveLength(9);
  });
});
