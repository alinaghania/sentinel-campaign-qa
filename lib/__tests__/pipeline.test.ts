import { describe, expect, it } from "vitest";
import { classifyLink, parseEmailFacts, parseUtm, unwrapSafeLink } from "../parse-email";
import { assertPublicUrl } from "../check-links";
import { dedupFindings, computeVerdict, isBlocking } from "../aggregate";
import { runCodeChecks } from "../checks-code";
import { verifyQuote } from "../structured";
import { pruneEmailHistory } from "../brief";
import type { Finding } from "../types";

describe("classifyLink", () => {
  it("détecte l'AMPscript", () => {
    expect(classifyLink("%%=RedirectTo(@url)=%%")).toBe("ampscript");
    expect(classifyLink("%%view_email_url%%")).toBe("ampscript");
  });
  it("détecte les liens trackés SFMC", () => {
    expect(classifyLink("https://click.email.maisonlucet.com/?qs=abc")).toBe("tracked");
    expect(classifyLink("https://cl.exct.net/?qs=abc")).toBe("tracked");
  });
  it("détecte ancres et mailto", () => {
    expect(classifyLink("#")).toBe("anchor");
    expect(classifyLink("")).toBe("anchor");
    expect(classifyLink("mailto:contact@x.fr")).toBe("mailto");
  });
  it("statique par défaut", () => {
    expect(classifyLink("https://www.maisonlucet.com/soldes")).toBe("statique");
  });
});

describe("parseUtm / unwrapSafeLink", () => {
  it("parse les utm_*", () => {
    expect(parseUtm("https://x.fr/?utm_source=sfmc&utm_campaign=ete&autre=1")).toEqual({
      utm_source: "sfmc",
      utm_campaign: "ete",
    });
  });
  it("déwrappe SafeLinks", () => {
    const wrapped =
      "https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.x.fr%2Fsoldes&data=abc";
    const { url, wasWrapped } = unwrapSafeLink(wrapped);
    expect(wasWrapped).toBe(true);
    expect(url).toBe("https://www.x.fr/soldes");
  });
});

describe("parseEmailFacts", () => {
  const html = `<html><body>
    <div style="display:none;max-height:0">Mon préheader caché</div>
    <table><tr><td><p>Jusqu'à <strong>-40%</strong> avec le code <strong>ETE40</strong></p></td></tr>
    <tr><td><a href="https://x.fr/a?utm_campaign=c1">CTA</a></td></tr>
    <tr><td><img src="https://x.fr/img.png"><img src="https://x.fr/pix.gif" width="1" height="1"></td></tr>
    <tr><td><a href="#">Se désinscrire</a></td></tr></table>
    <!--[if mso]><a href="https://x.fr/outlook-only">Bouton VML</a><![endif]-->
  </body></html>`;
  const facts = parseEmailFacts(html);

  it("inclut le texte des balises inline (strong)", () => {
    expect(facts.textBlocks.join(" ")).toContain("-40%");
    expect(facts.textBlocks.join(" ")).toContain("ETE40");
  });
  it("détecte le préheader caché", () => {
    expect(facts.preheader).toContain("préheader caché");
  });
  it("trouve les liens des blocs MSO", () => {
    expect(facts.links.some((l) => l.href.includes("outlook-only") && l.inMsoBlock)).toBe(true);
  });
  it("détecte le pixel de tracking", () => {
    expect(facts.images.find((i) => i.src.includes("pix.gif"))?.isTrackingPixel).toBe(true);
  });
  it("désinscription href=# → non fonctionnelle", () => {
    expect(facts.hasUnsubscribeLink).toBe(false);
  });
});

describe("SSRF guard", () => {
  it("bloque les IP privées et link-local", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/metadata")).rejects.toThrow(/SSRF/);
    await expect(assertPublicUrl("http://10.0.0.1/")).rejects.toThrow(/SSRF/);
    await expect(assertPublicUrl("http://192.168.1.1/")).rejects.toThrow(/SSRF/);
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow(/SSRF/);
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toThrow(/internal/);
  });
  it("bloque les protocoles non-http", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/protocol/);
  });
});

describe("agrégation", () => {
  const f = (over: Partial<Finding>): Finding => ({
    id: Math.random().toString(36),
    agent: "a",
    categorie: "liens",
    severite: "MAJEUR",
    message: "Lien cassé vers la page",
    evidence: "e",
    locator: "lien#1",
    source: "regle",
    ...over,
  });
  it("dédup garde la sévérité max", () => {
    const out = dedupFindings([
      f({ severite: "MAJEUR", agent: "a" }),
      f({ severite: "CRITIQUE", agent: "b" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].severite).toBe("CRITIQUE");
    expect(out[0].agent).toContain("a");
    expect(out[0].agent).toContain("b");
  });
  it("dédup insensible au title : 2 titles différents, même fond → 1 survivant", () => {
    const out = dedupFindings([
      f({ title: "Problem in a link" }),
      f({ title: "Possible issue to review" }),
    ]);
    expect(out).toHaveLength(1);
  });
  it("verdict à TROIS états : CRITIQUE = NO_GO, autre actif = réserves, rien = GO", () => {
    const crit = f({ severite: "CRITIQUE" });
    // Seul un CRITIQUE actif bloque.
    expect(computeVerdict([crit]).verdict).toBe("NO_GO");
    expect(computeVerdict([{ ...crit, review: "faux_positif" }]).verdict).toBe("GO");
    // MAJEUR et MINEUR ne bloquent plus l'envoi : ils le grèvent de réserves,
    // que l'humain lève une par une (review) pour retrouver un GO franc.
    expect(computeVerdict([f({ severite: "MAJEUR" })]).verdict).toBe("GO_AVEC_RESERVES");
    expect(computeVerdict([f({ severite: "MINEUR" })]).verdict).toBe("GO_AVEC_RESERVES");
    expect(computeVerdict([{ ...f({ severite: "MINEUR" }), review: "accepte" }]).verdict).toBe("GO");
    expect(computeVerdict([]).verdict).toBe("GO");
    // Un CRITIQUE l'emporte sur des réserves présentes en même temps : le pire
    // gagne, sinon un mail bloquant s'afficherait comme simplement réservé.
    expect(computeVerdict([crit, f({ severite: "MINEUR" })]).verdict).toBe("NO_GO");
  });
  it("isBlocking ne bloque que NO_GO", () => {
    // Le garde-fou de l'énum : si un jour quelqu'un réécrit `isBlocking` en
    // `!== "GO"`, ce test tombe — et c'est précisément l'erreur à empêcher.
    expect(isBlocking("NO_GO")).toBe(true);
    expect(isBlocking("GO_AVEC_RESERVES")).toBe(false);
    expect(isBlocking("GO")).toBe(false);
  });
});

describe("checks code", () => {
  it("détecte AMPscript sans RedirectTo + placeholders + année périmée (QA étendu)", () => {
    // L'année de copyright est une règle qualité générique → gatée QA_EXTENDED
    // (périmètre par défaut = strict brief + bloqueurs d'envoi).
    process.env.QA_EXTENDED = "1";
    try {
      const html = `<html><body><div style="display:none">Preheader TBD</div>
        <a href="%%=v(@url)=%%">voir en ligne</a>
        <p>© ${new Date().getFullYear() - 1} Marque</p>
        <a href="https://fr.wikipedia.org/wiki/Soldes">Se désinscrire</a></body></html>`;
      const facts = parseEmailFacts(html);
      const { findings } = runCodeChecks({ facts, linkResults: [] });
      const msgs = findings.map((x) => x.message).join(" | ");
      expect(msgs).toContain("AMPscript");
      expect(msgs).toContain("placeholder");
      expect(msgs).toContain("Outdated");
    } finally {
      delete process.env.QA_EXTENDED;
    }
  });
  it("périmètre strict par défaut : pas de findings qualité générique (alt, année)", () => {
    const html = `<html><body>
      <img src="https://cdn.x/a.jpg">
      <p>© ${new Date().getFullYear() - 1} Marque</p>
      <a href="https://exemple.com/desinscription">Se désinscrire</a></body></html>`;
    const facts = parseEmailFacts(html);
    const { findings } = runCodeChecks({ facts, linkResults: [] });
    const msgs = findings.map((x) => x.message).join(" | ");
    expect(msgs).not.toContain("alt");
    expect(msgs).not.toContain("Outdated");
  });
});

describe("verifyQuote / pruneEmailHistory", () => {
  it("vérifie les quotes avec normalisation espaces", () => {
    expect(verifyQuote("code  ETE40", "Avec le code ETE40, la livraison")).toBe(true);
    expect(verifyQuote("code ETE99", "Avec le code ETE40")).toBe(false);
  });
  it("coupe l'historique de mail", () => {
    const filler = "Contenu du brief détaillé. ".repeat(12);
    const brief = `Le brief important est ici. ${filler}\n\nDe : Jean Dupont\nEnvoyé : mardi\nAncien message cité inutile`;
    const pruned = pruneEmailHistory(brief);
    expect(pruned).toContain("brief important");
    expect(pruned).not.toContain("Ancien message");
  });
});
