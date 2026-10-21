import { describe, expect, it } from "vitest";
import { buildFindingsEmail, parseRecipients } from "@/lib/send-findings";
import type { AnalysisReport, Finding } from "@/lib/types";

describe("parseRecipients", () => {
  it("sépare, dédoublonne et rejette les valeurs invalides", () => {
    const r = parseRecipients("a@x.com, b@y.com;a@x.com\nnope, c@d");
    expect(r.valid).toEqual(["a@x.com", "b@y.com"]);
    expect(r.invalid).toEqual(["nope", "c@d"]);
  });
  it("refuse l'injection d'en-tête", () => {
    expect(parseRecipients("a@x.com\r\nBcc: evil@z.com").invalid.length).toBeGreaterThan(0);
  });
});

describe("buildFindingsEmail", () => {
  const f = {
    id: "1", agent: "x", categorie: "liens", severite: "MAJEUR", message: "Lien <cassé>",
    evidence: "https://a.b", locator: "a[0]", source: "regle",
  } as Finding;
  const report = { verdict: "NO_GO" } as AnalysisReport;
  it("échappe le HTML et garde l'objet sur une ligne", () => {
    const m = buildFindingsEmail({ report, findings: [f], campaignName: "Camp\nX" });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).toContain("Lien &lt;cassé&gt;");
    expect(m.text).toContain("[MAJEUR]");
  });
});
