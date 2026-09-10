import { describe, expect, it } from "vitest";
import { evaluateAuthResults, extractAuthHeaders, parseAuthenticationResults } from "../auth-results";
import { runCodeChecks } from "../checks-code";
import { parseEmailFacts } from "../parse-email";

// En-tête réel (mail SFMC Gucci reçu sur acnkering@gmail.com, anonymisé a minima)
const GMAIL_AR =
  'mx.google.com; dkim=pass header.i=@email.gucci.com header.s=10dkim1 header.b=U+0El+Le; dkim=pass header.i=@s10.y.mc.salesforce.com header.s=fbldkim10 header.b=D+H+XESV; spf=pass (google.com: domain of bounce-j4aw.100223@bounce.email.gucci.com designates 13.111.87.6 as permitted sender) smtp.mailfrom=bounce-J4AW.100223@bounce.email.gucci.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=email.gucci.com';

// En-tête Outlook.com réel : PAS d'authserv-id (violation RFC 8601), compauth propriétaire
const OUTLOOK_AR =
  "spf=pass (sender IP is 13.111.87.6) smtp.mailfrom=bounce.email.gucci.com; dkim=pass (signature was verified) header.d=email.gucci.com;dmarc=pass action=none header.from=email.gucci.com;compauth=pass reason=100";

const mime = (ar: string | string[] | null, body = "<html>hi</html>") => {
  const ars = ar === null ? [] : (Array.isArray(ar) ? ar : [ar]).map((v) => `Authentication-Results: ${v}`);
  return [
    "Delivered-To: acnkering@gmail.com",
    "Received: by mx.google.com with SMTP id x1;",
    " Tue, 21 Jul 2026 09:00:00 -0700 (PDT)",
    ...ars,
    "From: Gucci <news@email.gucci.com>",
    "Subject: test",
    "Content-Type: text/html; charset=utf-8",
    "",
    body,
  ].join("\r\n");
};

describe("parseAuthenticationResults", () => {
  it("parse un AR Gmail réel : authserv-id, 2 signatures dkim, props", () => {
    const p = parseAuthenticationResults(GMAIL_AR);
    expect(p.authservId).toBe("mx.google.com");
    const dkim = p.results.filter((r) => r.method === "dkim");
    expect(dkim).toHaveLength(2);
    expect(dkim[0].result).toBe("pass");
    expect(dkim[0].props["header.i"]).toBe("@email.gucci.com");
    expect(dkim[1].props["header.s"]).toBe("fbldkim10");
    expect(p.results.find((r) => r.method === "spf")?.props["smtp.mailfrom"]).toMatch(/@bounce\.email\.gucci\.com$/i);
    expect(p.results.find((r) => r.method === "dmarc")?.props["header.from"]).toBe("email.gucci.com");
  });

  it("tolère l'AR Outlook sans authserv-id (violation RFC) + compauth", () => {
    const p = parseAuthenticationResults(OUTLOOK_AR);
    expect(p.authservId).toBeNull();
    expect(p.results.find((r) => r.method === "spf")?.result).toBe("pass");
    expect(p.results.find((r) => r.method === "dmarc")?.props["action"]).toBe("none");
    expect(p.results.find((r) => r.method === "compauth")?.props["reason"]).toBe("100");
  });

  it("survit aux commentaires imbriqués et parenthèses non fermées", () => {
    const p = parseAuthenticationResults("mx.google.com; spf=pass (comment (nested) and (unclosed smtp.mailfrom=evil.com; dkim=fail");
    expect(p.results.find((r) => r.method === "spf")?.result).toBe("pass");
    // tout ce qui suit la parenthèse non fermée est du commentaire
    expect(p.results.find((r) => r.method === "dkim")).toBeUndefined();
    expect(p.results.find((r) => r.method === "spf")?.props["smtp.mailfrom"]).toBeUndefined();
  });

  it('"mx.google.com; none" → aucun résultat', () => {
    const p = parseAuthenticationResults("mx.google.com; none");
    expect(p.authservId).toBe("mx.google.com");
    expect(p.results).toHaveLength(0);
  });
});

describe("evaluateAuthResults", () => {
  it("mail Gmail sain : trusted, spf/dkim/dmarc pass, policy REJECT, 2 signatures", () => {
    const a = evaluateAuthResults(mime(GMAIL_AR), "gmail");
    expect(a.present).toBe(true);
    expect(a.trusted).toBe(true);
    expect(a.authservId).toBe("mx.google.com");
    expect(a.spf?.result).toBe("pass");
    expect(a.spf?.mailfrom).toBe("bounce.email.gucci.com");
    expect(a.dkim).toHaveLength(2);
    expect(a.dkim[0]).toMatchObject({ result: "pass", domain: "email.gucci.com", alignedWithFrom: true });
    expect(a.dkim[1].domain).toBe("s10.y.mc.salesforce.com");
    expect(a.dmarc).toMatchObject({ result: "pass", fromDomain: "email.gucci.com", policy: "REJECT" });
  });

  it("anti-spoofing : un AR forgé par l'expéditeur (sous celui de Gmail) est ignoré", () => {
    const forged = "mx.fake.example; spf=pass; dkim=pass; dmarc=pass header.from=attacker.com";
    const a = evaluateAuthResults(mime([GMAIL_AR.replace("dmarc=pass", "dmarc=fail"), forged]), "gmail");
    expect(a.trusted).toBe(true);
    expect(a.dmarc?.result).toBe("fail"); // celui de mx.google.com, pas le forgé
  });

  it("AR présent mais authserv-id inattendu pour la source → trusted=false", () => {
    const a = evaluateAuthResults(mime("somerelay.example; spf=pass smtp.mailfrom=x.com; dmarc=pass header.from=x.com"), "gmail");
    expect(a.present).toBe(true);
    expect(a.trusted).toBe(false);
  });

  it(".eml uploadé : AR évalué mais jamais trusted", () => {
    const a = evaluateAuthResults(mime(GMAIL_AR), "upload");
    expect(a.present).toBe(true);
    expect(a.trusted).toBe(false);
    expect(a.dmarc?.result).toBe("pass");
  });

  it("outlook : AR sans authserv-id accepté comme trusted", () => {
    const a = evaluateAuthResults(mime(OUTLOOK_AR), "outlook");
    expect(a.trusted).toBe(true);
    expect(a.dmarc?.result).toBe("pass");
    expect(a.compauth).toMatchObject({ result: "pass", reason: "100" });
  });

  it("aucun AR → present=false", () => {
    const a = evaluateAuthResults(mime(null), "gmail");
    expect(a.present).toBe(false);
    expect(a.trusted).toBe(false);
  });

  it("dkim=pass sans header.d : replie sur le domaine de header.i", () => {
    const a = evaluateAuthResults(mime("mx.google.com; dkim=pass header.i=@brand.com; dmarc=pass header.from=brand.com"), "gmail");
    expect(a.dkim[0].domain).toBe("brand.com");
    expect(a.dkim[0].alignedWithFrom).toBe(true);
  });

  it("rawMime dégénéré (pas de ligne vide) : s'arrête à la 1re ligne non-header", () => {
    const junk = "Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=a@b.com\nceci n'est pas un header dkim=fail\n<html>corps sans séparation</html>";
    const headers = extractAuthHeaders(junk);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("spf=pass");
  });
});

describe("runCodeChecks — verdict délivrabilité", () => {
  const facts = parseEmailFacts("<html><body><p>Bonjour</p></body></html>");
  const run = (rawMime: string | null, source: "gmail" | "outlook" | "upload") =>
    runCodeChecks({
      facts,
      linkResults: [],
      headerChecks: rawMime === null ? { authResults: { present: false, trusted: false, dkim: [] } } : { authResults: evaluateAuthResults(rawMime, source) },
      source,
    });

  it("mail sain → 3 checks verts SPF/DKIM/DMARC détaillés, zéro finding auth", () => {
    const { findings, passed } = run(mime(GMAIL_AR), "gmail");
    const auth = passed.filter((p) => /SPF|DKIM|DMARC/.test(p.label));
    expect(auth.map((p) => p.label)).toEqual([
      "DMARC: pass (header.from=email.gucci.com, p=REJECT)",
      "DKIM: pass (d=email.gucci.com, d=s10.y.mc.salesforce.com)",
      "SPF: pass (smtp.mailfrom=bounce.email.gucci.com)",
    ]);
    expect(findings.filter((f) => f.locator?.startsWith("header:"))).toHaveLength(0);
  });

  it("dmarc=fail (trusted) → CRITIQUE", () => {
    const { findings } = run(mime(GMAIL_AR.replace("dmarc=pass", "dmarc=fail")), "gmail");
    const d = findings.find((f) => f.locator === "header:dmarc");
    expect(d?.severite).toBe("CRITIQUE");
    expect(d?.title).toBe("Problem in the email authentication");
  });

  it("dmarc=fail sur un .eml importé → plafonné MAJEUR (provenance invérifiable)", () => {
    const { findings } = run(mime(GMAIL_AR.replace("dmarc=pass", "dmarc=fail")), "upload");
    const d = findings.find((f) => f.locator === "header:dmarc");
    expect(d?.severite).toBe("MAJEUR");
  });

  it("spf=softfail avec dmarc=pass → MINEUR informatif, pas bloquant", () => {
    const { findings } = run(mime(GMAIL_AR.replace("spf=pass", "spf=softfail")), "gmail");
    const s = findings.find((f) => f.locator === "header:spf");
    expect(s?.severite).toBe("MINEUR");
    expect(s?.message).toContain("not blocking");
    // SPF toléré = observation, pas un problème d'authentification (DMARC passe)
    expect(s?.title).toBe("Possible issue to review");
  });

  it("dmarc=none → MAJEUR bulk senders (pas CRITIQUE)", () => {
    const ar = "mx.google.com; spf=pass smtp.mailfrom=bounce.x.com; dkim=pass header.d=x.com; dmarc=none header.from=x.com";
    const { findings } = run(mime(ar), "gmail");
    const d = findings.find((f) => f.locator === "header:dmarc");
    expect(d?.severite).toBe("MAJEUR");
    expect(d?.message).toContain("bulk sender");
    expect(d?.title).toBe("Problem in the email authentication");
  });

  it("dmarc=bestguesspass (Outlook) → MAJEUR, pas un pass", () => {
    const { findings, passed } = run(mime(OUTLOOK_AR.replace("dmarc=pass", "dmarc=bestguesspass")), "outlook");
    expect(findings.find((f) => f.locator === "header:dmarc")?.severite).toBe("MAJEUR");
    expect(passed.some((p) => p.label.startsWith("DMARC"))).toBe(false);
  });

  it("temperror → MINEUR (transitoire)", () => {
    const { findings } = run(mime(GMAIL_AR.replace("dmarc=pass (p=REJECT sp=REJECT dis=NONE)", "dmarc=temperror")), "gmail");
    const d = findings.find((f) => f.locator === "header:dmarc");
    expect(d?.severite).toBe("MINEUR");
    // Erreur transitoire côté récepteur = non vérifiable, pas un problème campagne
    expect(d?.title).toBe("Email authentication could not be verified");
  });

  it("AR absent sur un mail Gmail → MINEUR non vérifiable ; sur un upload → silence", () => {
    const gmail = run(null, "gmail");
    expect(gmail.findings.find((f) => f.locator === "header:auth")?.severite).toBe("MINEUR");
    const upload = run(null, "upload");
    expect(upload.findings.filter((f) => f.locator?.startsWith("header:"))).toHaveLength(0);
  });

  it('"; none" → un seul MINEUR non vérifiable, pas 3 findings', () => {
    const { findings } = run(mime("mx.google.com; none"), "gmail");
    const auth = findings.filter((f) => f.locator?.startsWith("header:"));
    expect(auth).toHaveLength(1);
    expect(auth[0].severite).toBe("MINEUR");
  });

  it("spf=fail sans rattrapage DMARC → CRITIQUE", () => {
    const ar = "mx.google.com; spf=fail smtp.mailfrom=bounce.x.com; dkim=pass header.d=x.com; dmarc=fail header.from=x.com";
    const { findings } = run(mime(ar), "gmail");
    expect(findings.find((f) => f.locator === "header:spf")?.severite).toBe("CRITIQUE");
  });

  it("spf=none sans rattrapage DMARC → MAJEUR (absence de verdict, pas un échec)", () => {
    const ar = "mx.google.com; spf=none smtp.mailfrom=bounce.x.com; dkim=pass header.d=x.com; dmarc=fail header.from=x.com";
    const { findings } = run(mime(ar), "gmail");
    expect(findings.find((f) => f.locator === "header:spf")?.severite).toBe("MAJEUR");
  });

  it("aucune signature DKIM valide + dmarc≠pass → CRITIQUE ; plafonné MAJEUR en upload", () => {
    const ar = "mx.google.com; dkim=fail header.d=x.com; spf=pass smtp.mailfrom=bounce.x.com; dmarc=fail header.from=x.com";
    expect(run(mime(ar), "gmail").findings.find((f) => f.locator === "header:dkim")?.severite).toBe("CRITIQUE");
    expect(run(mime(ar), "upload").findings.find((f) => f.locator === "header:dkim")?.severite).toBe("MAJEUR");
  });

  it("dmarc=permerror → MAJEUR (enregistrement malformé)", () => {
    const ar = "mx.google.com; spf=pass smtp.mailfrom=bounce.x.com; dkim=pass header.d=x.com; dmarc=permerror header.from=x.com";
    const { findings } = run(mime(ar), "gmail");
    expect(findings.find((f) => f.locator === "header:dmarc")?.severite).toBe("MAJEUR");
  });

  it("dkim signé uniquement exacttarget + dmarc fail → MAJEUR Private Domain", () => {
    const ar = "mx.google.com; dkim=pass header.d=s10.exacttarget.com; spf=pass smtp.mailfrom=bounce.s10.exacttarget.com; dmarc=fail header.from=news.brand.com";
    const { findings } = run(mime(ar), "gmail");
    expect(findings.some((f) => f.locator === "header:dkim" && f.severite === "MAJEUR" && /Private Domain/.test(f.message))).toBe(true);
  });
});
