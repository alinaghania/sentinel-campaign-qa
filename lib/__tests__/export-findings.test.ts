import { describe, expect, it } from "vitest";
import { diffRichText, findingRichText, sanitizeXml } from "../export-findings";
import type { Finding } from "../types";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "x",
  agent: "règles",
  categorie: "brief",
  severite: "MAJEUR",
  message: "Translation differs from the brief",
  evidence: "e",
  locator: "contenu",
  source: "regle",
  ...over,
});

describe("export-findings", () => {
  it("sanitizeXml : strip des caractères de contrôle interdits, \\n\\t conservés", () => {
    expect(sanitizeXml("a\u0000b\u0008c\u000bd\u001fe")).toBe("abcde");
    expect(sanitizeXml("ligne1\nligne2\tfin\r")).toBe("ligne1\nligne2\tfin\r");
  });

  it("findingRichText : titre en gras + message, title absent → fallback catégorie", () => {
    const rt = findingRichText(finding());
    expect(rt.richText[0]).toEqual({
      text: "Problem in the translation",
      font: { bold: true },
    });
    expect(rt.richText[1].text).toBe("\nTranslation differs from the brief");
    const custom = findingRichText(finding({ title: "Possible issue to review" }));
    expect(custom.richText[0].text).toBe("Possible issue to review");
  });

  it("diffRichText : segments différents en gras coloré, valeur vide → cellule vide", () => {
    const rt = diffRichText("Bienvenido a Balenciaga", "Bienvenida a Balenciaga");
    expect(rt).toBeDefined();
    const changed = rt!.richText.filter((r) => r.font?.bold);
    expect(changed.map((r) => r.text)).toEqual(["Bienvenido"]);
    expect(changed[0].font?.color?.argb).toBe("FF9A6A00");
    expect(diffRichText("", "autre")).toBeUndefined();
    expect(diffRichText(undefined, "autre")).toBeUndefined();
    expect(diffRichText("   ", "autre")).toBeUndefined();
  });

  it("diffRichText : queue au-delà du cap 1200 tokens réinjectée — texte TOUJOURS complet", () => {
    // 1300 mots = 2599 tokens (mot + espace) > cap 1200 de diffSegments
    const long = Array.from({ length: 1300 }, (_, i) => `mot${i}`).join(" ");
    const rt = diffRichText(long, "autre texte");
    expect(rt).toBeDefined();
    const rendered = rt!.richText.map((r) => r.text).join("");
    expect(rendered).toBe(long);
    // la queue réinjectée n'est PAS surlignée
    const last = rt!.richText[rt!.richText.length - 1];
    expect(last.font?.bold).toBeUndefined();
  });
});
