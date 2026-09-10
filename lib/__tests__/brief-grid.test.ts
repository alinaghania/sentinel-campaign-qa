// Tests d'acceptation du parseur de briefs sur les 5 FICHIERS RÉELS Kering
// (lib/__tests__/fixtures — voir README, données client, ne pas publier).
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseBriefGridDetailed } from "../brief-grid";
import { isPlaceholderText, isPlaceholderUrl } from "../brief-placeholders";
import { runCodeChecks } from "../checks-code";
import { parseTestName } from "../lang-report";
import { parseEmailFacts } from "../parse-email";
import type { BriefGrid } from "../types";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name));

describe("parseBriefGridDetailed — fichiers réels", () => {
  it("MX Guadalajara (.xlsm famille template) : variantes genrées + vraie URL + ES", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("mx-guadalajara.xlsm"));
    expect(grid).not.toBeNull();
    expect(telemetry.family).toBe("field_value");
    expect(telemetry.sheetUsed).toBe("Campaign Brief");
    // La clé de colonne est le code DÉCLARÉ par le fichier ("MX"), plus son
    // code de langue ("ES"). Avant le 2026-09-04 la grille rendait ["ES"] et
    // rangeait le libellé d'origine dans `langLabels` : la colonne mexicaine
    // n'existait plus qu'en tant qu'étiquette d'affichage. Ici le fichier ne
    // porte qu'UNE colonne de la famille espagnole, donc rien ne se perdait ;
    // le classeur canonique en porte deux (ES et MX), et là MX n'était jamais
    // lue. Même mécanisme, deux issues — d'où la clé par colonne.
    expect(grid!.languages).toEqual(["MX"]);
    // `langLabels` ne porte plus rien : la clé EST le libellé du fichier. Il
    // ne reste que les codes que la canonicalisation change encore (JP → JA).
    expect(grid!.langLabels).toBeUndefined();
    expect(grid!.isLikelyTemplate).toBeFalsy();
    // Noms de blocs = libellés EXACTS du fichier, DANS L'ORDRE du fichier.
    expect(grid!.blocks.map((b) => b.name)).toEqual([
      "Subject Line (male & others)",
      "Subject Line (female)",
      "Preheader",
      "Headline (male & others)",
      "Headline (female)",
      "Body Copy",
      "CTA 1 Label",
    ]);
    expect(grid!.blocks.find((b) => b.name === "Subject Line (female)")?.valueByLang.MX).toContain("Bienvenida");
    // Aucun placeholder du template dans la grille
    for (const b of grid!.blocks) {
      for (const v of Object.values(b.valueByLang)) expect(isPlaceholderText(v)).toBe(false);
    }
    // La VRAIE URL (colonne MX), pas le placeholder brand.com de la colonne VALUE
    expect(grid!.expectedLinks).toHaveLength(1);
    expect(grid!.expectedLinks[0].ww).toBe("https://www.balenciaga.com/storelocator/mexico-guadalajara-pdh");
    // Appariement URL ↔ CTA : le lien "Hero Asset / CTA URL" hérite du libellé CTA 1
    expect(grid!.expectedLinks[0].ctaLabelByLang?.MX).toBe("RESERVAR UNA CITA");
    expect(grid!.salesforceCampaignName).toBe("ADHOC_LOCAL_OTM_EMAIL_20260721_MXGuadalajaraMidtown_StoreClosure");
  });

  it("template vierge : détecté isLikelyTemplate, placeholders conservés", async () => {
    const { grid } = await parseBriefGridDetailed(fixture("blank-template.xlsm"));
    expect(grid).not.toBeNull();
    expect(grid!.isLikelyTemplate).toBe(true);
    expect(grid!.blocks.length).toBeGreaterThan(3);
  });

  it("STJ (.xlsm brief TASK) : contenu réel de Campaign Brief repris tel quel", async () => {
    const { grid } = await parseBriefGridDetailed(fixture("bal-stj-fieldvalue.xlsm"));
    expect(grid).not.toBeNull();
    expect(grid!.languages).toEqual(["EN"]);
    expect(grid!.salesforceCampaignName).toMatch(/_/);
    // Fidélité : les champs du fichier (brief TASK) repris avec leurs libellés
    // exacts — plus de repli sur la feuille EMAIL template.
    expect(grid!.blocks.map((b) => b.name)).toEqual(["Subject", "Description"]);
    expect(grid!.isLikelyTemplate).toBeFalsy();
  });

  it("BAL Newsletter (grille horizontale) : non-régression", async () => {
    const { grid, telemetry } = await parseBriefGridDetailed(fixture("bal-newsletter-grid.xlsx"));
    expect(grid).not.toBeNull();
    expect(telemetry.family).toBe("grid");
    expect(grid!.languages).toEqual(expect.arrayContaining(["EN", "FR", "JA", "ZH"]));
    const names = grid!.blocks.map((b) => b.name);
    expect(names).toContain("Subject line");
    expect(names).toContain("CTA 3");
    expect(grid!.expectedLinks.some((l) => (l.ww ?? "").includes("balenciaga.com"))).toBe(true);
    expect(grid!.isLikelyTemplate).toBeFalsy();
  });

  it("AMQ (grille BCP-47) : non-régression", async () => {
    const { grid } = await parseBriefGridDetailed(fixture("amq-grid.xlsx"));
    expect(grid).not.toBeNull();
    expect(grid!.languages).toHaveLength(6);
    expect(grid!.blocks.map((b) => b.name)).toEqual(expect.arrayContaining(["sl", "ph", "body", "cta"]));
    expect(grid!.expectedLinks).toHaveLength(0);
  });
});

describe("parseTestName (nomenclature du nom de test)", () => {
  it("nouveau format audience en dernier : [num - nom - MX - F]", () => {
    const tn = parseTestName("[1294653 - MX Guadalajara Midtown Store Closure - MX - F] Bienvenida a Balenciaga");
    expect(tn).toMatchObject({ testNumber: "1294653", market: "MX", audience: "F", wellFormed: true });
    expect(tn!.campaignName).toBe("MX Guadalajara Midtown Store Closure");
  });

  it("format BAL historique audience avant marché : [num - nom - ALL - EU]", () => {
    const tn = parseTestName("[1293933 - New Footer Substack - ALL - EU] The Final Touch");
    expect(tn).toMatchObject({ testNumber: "1293933", market: "EU", audience: "ALL", wellFormed: true });
  });

  it("préfixe sans audience → marché extrait, nomenclature incomplète", () => {
    const tn = parseTestName("[1293370 - Le 7 Bowling Bag - US] subject");
    expect(tn).toMatchObject({ market: "US", audience: null, wellFormed: false });
  });

  it("sans préfixe crocheté → null ; malformé → pas wellFormed", () => {
    expect(parseTestName("Bienvenida a Balenciaga")).toBeNull();
    expect(parseTestName("[hello world] subject")?.wellFormed).toBe(false);
  });

  it("nomenclature malformée → finding MINEUR ; complète → check vert", () => {
    const facts = parseEmailFacts("<html><body><p>x</p></body></html>");
    const bad = runCodeChecks({ facts, linkResults: [], subject: "[oops] subject" });
    const nom = bad.findings.find((f) => /nomenclature/i.test(f.message));
    expect(nom?.severite).toBe("MINEUR");
    // Titre harmonisé : le nom de test vit dans la ligne sujet
    expect(nom?.title).toBe("Problem in the subject line");
    const good = runCodeChecks({ facts, linkResults: [], subject: "[1294653 - Store Closure - MX - F] subject" });
    expect(good.passed.some((p) => /nomenclature/i.test(p.label))).toBe(true);
  });
});

describe("brief-placeholders (oracle)", () => {
  it("reconnaît les placeholders du template et les motifs génériques", () => {
    expect(isPlaceholderText("Dear [Name], discover…")).toBe(true);
    expect(isPlaceholderText("Shop Now")).toBe(true);
    expect(isPlaceholderText("Hola [Nombre del Cliente], bienvenida")).toBe(false); // personnalisation réelle, pas un placeholder
    expect(isPlaceholderText("RESERVAR UNA CITA")).toBe(false);
    expect(isPlaceholderUrl("https://brand.com/new-collection")).toBe(true);
    expect(isPlaceholderUrl("https://www.balenciaga.com/storelocator/x")).toBe(false);
  });
});

describe("checks-code §4 — variantes genrées = alternatives (OU, pas ET)", () => {
  const gridPromise = parseBriefGridDetailed(fixture("mx-guadalajara.xlsm")).then((r) => r.grid!);

  /** Fabrique le mail de test depuis la grille : les blocs FÉMININS et neutres,
   *  lus sous la clé de colonne que la grille utilise VRAIMENT.
   *
   *  Cette clé était écrite en dur (`valueByLang.ES`). Le jour où la colonne
   *  mexicaine a reçu sa propre clé, les quatre cas de ce bloc sont passés au
   *  rouge — non pas parce que la plateforme s'était cassée, mais parce que le
   *  harnais composait un mail VIDE et le donnait à juger. Cinq findings
   *  « traduction absente » sont sortis, tous justes, tous portant sur rien.
   *
   *  D'où le contrôle : un mail sans bloc ne prouve rien, et il ne doit plus
   *  pouvoir se déguiser en défaut de la plateforme. */
  function mailDepuisLaGrille(grid: BriefGrid, remplacer = false): string {
    const key = grid.languages[0];
    const textes = grid.blocks
      .filter((b) => !/\(male/i.test(b.name))
      .map((b) => {
        const v = b.valueByLang[key] ?? "";
        return remplacer ? v.replace("[Nombre del Cliente], / Hola,", "María,") : v;
      })
      .filter(Boolean);
    expect(textes.length, `aucun bloc lu sous la clé "${key}" — le mail serait vide`).toBeGreaterThan(0);
    return `<html><body>${textes.map((t) => `<p>${t}</p>`).join("")}</body></html>`;
  }

  it("mail mono-genre (féminin) → zéro finding traduction", async () => {
    const grid = await gridPromise;
    // Email simulé : UNIQUEMENT les variantes féminines + blocs neutres.
    const html = mailDepuisLaGrille(grid);
    const facts = parseEmailFacts(html);
    const { findings, passed } = runCodeChecks({
      facts,
      linkResults: [],
      briefGrid: grid,
      detectedLanguage: { lang: "ES", confidence: "high" },
    });
    expect(findings.filter((f) => f.categorie === "brief")).toHaveLength(0);
    expect(passed.some((p) => p.categorie === "brief")).toBe(true);
  });

  it("personnalisation : '[Nombre del Cliente]' remplacé par le vrai nom → zéro faux positif", async () => {
    const grid = await gridPromise;
    // Email réel : le jeton est remplacé ("Hola María,") et seule la salutation
    // personnalisée est présente (pas le repli " / Hola,").
    const html = mailDepuisLaGrille(grid, true);
    const { findings } = runCodeChecks({
      facts: parseEmailFacts(html),
      linkResults: [],
      briefGrid: grid,
      detectedLanguage: { lang: "ES", confidence: "high" },
    });
    expect(findings.filter((f) => f.categorie === "brief")).toHaveLength(0);
  });

  it("audience M avec texte féminin → finding 'Wrong audience variant' avec diff", async () => {
    const grid = await gridPromise;
    // Mail du test "- M]" qui contient par erreur les variantes FÉMININES.
    const html = mailDepuisLaGrille(grid, true);
    const { findings } = runCodeChecks({
      facts: parseEmailFacts(html),
      linkResults: [],
      briefGrid: grid,
      detectedLanguage: { lang: "ES", confidence: "high" },
      subject: "[1294656 - MX Guadalajara Midtown Store Closure - MX - M] Bienvenida a Balenciaga Guadalajara - El Palacio de Hierro",
    });
    const wrong = findings.filter((f) => /Wrong audience/i.test(f.message));
    expect(wrong.length).toBeGreaterThanOrEqual(1);
    expect(wrong[0].expected).toContain("Bienvenido"); // variante attendue (male & others)
    expect(wrong[0].received).toContain("Bienvenida"); // variante trouvée (female)
    expect(wrong[0].title).toBe("Problem in the translation");
  });

  it("audience F avec texte féminin → zéro finding (la bonne variante est exigée et trouvée)", async () => {
    const grid = await gridPromise;
    const html = mailDepuisLaGrille(grid, true);
    const { findings } = runCodeChecks({
      facts: parseEmailFacts(html),
      linkResults: [],
      briefGrid: grid,
      detectedLanguage: { lang: "ES", confidence: "high" },
      subject: "[1294653 - MX Guadalajara Midtown Store Closure - MX - F] Bienvenida a Balenciaga Guadalajara - El Palacio de Hierro",
    });
    expect(findings.filter((f) => f.categorie === "brief")).toHaveLength(0);
  });

  it("aucune variante présente → UN SEUL finding pour le groupe (pas un par variante)", async () => {
    const grid = await gridPromise;
    const facts = parseEmailFacts("<html><body><p>Contenu sans rapport</p></body></html>");
    const { findings } = runCodeChecks({
      facts,
      linkResults: [],
      briefGrid: grid,
      detectedLanguage: { lang: "ES", confidence: "high" },
    });
    const subjectFindings = findings.filter(
      (f) => f.categorie === "brief" && /subject line/i.test(f.message)
    );
    expect(subjectFindings).toHaveLength(1);
    expect(subjectFindings[0].message).toContain("any of 2 variants");
    // Bloc absent : expected = texte du brief, received vide (boîte "not found")
    expect(subjectFindings[0].expected).toBeTruthy();
    expect(subjectFindings[0].received).toBe("");
  });
});
