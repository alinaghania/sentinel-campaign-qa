// runCodeChecks × configuration /rules.
//
// Deux propriétés sont vérifiées ici :
//  1. NON-RÉGRESSION — sans config, la sortie est bit à bit celle d'avant ;
//  2. la passe de configuration finale ne peut pas faire disparaître un contrôle
//     par accident (règle hors catalogue conservée, règle protégée intouchable).
//
// Les EmailFacts sont construits à la main : aucune fixture client n'est
// utilisée, les cas restent lisibles et minimaux.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { runCodeChecks } from "../checks-code";
import { DEFAULT_RULE_CONFIG, emptyRuleConfig, resolveRuleConfig } from "../rule-config";
import type { CustomRule, ResolvedRuleConfig, RuleOverride } from "../rule-config";
import { RULE_BY_ID, RULE_CATALOG } from "../rule-catalog";
// La résolution de config consulte le catalogue COMPLET (règles code + IA +
// périphériques), pas le seul catalogue déterministe : c'est cette map-là
// qu'il faut amputer pour simuler une règle disparue.
import { ALL_RULE_BY_ID } from "../rule-registry";
import type { RuleCatalogEntry } from "../rule-catalog";
import type { EmailFacts, Finding, LinkCheckResult } from "../types";

// --- Outils ---------------------------------------------------------------

function makeFacts(over: Partial<EmailFacts> = {}): EmailFacts {
  return {
    htmlSizeBytes: 20 * 1024,
    links: [],
    images: [],
    textBlocks: [],
    msoBlockCount: 0,
    hasUnsubscribeLink: true,
    personalizationTokens: [],
    ampscriptSnippets: [],
    ...over,
  };
}

function cfgWith(
  overrides: Record<string, RuleOverride>,
  customRules: CustomRule[] = []
): ResolvedRuleConfig {
  return resolveRuleConfig({ ...emptyRuleConfig(), overrides, customRules, version: 3 });
}

/** Mail de référence : déclenche 4 règles distinctes, une par famille utile. */
const REFERENCE_FACTS = makeFacts({
  subject: "Spring collection",
  textBlocks: ["Discover the new drop, copy TBD here"], // placeholders (protégée)
  htmlSizeBytes: 95 * 1024, // html-size : au-dessus du seuil d'alerte, sous la coupure
  personalizationTokens: ["%%frstname%%"], // personalization-tokens (protégée)
  links: [
    { index: 0, href: "#", text: "Shop now", kind: "anchor", utm: {}, inMsoBlock: false }, // empty-anchor-cta
  ],
});

const run = (config?: ResolvedRuleConfig | null): ReturnType<typeof runCodeChecks> =>
  runCodeChecks({ facts: REFERENCE_FACTS, linkResults: [], config });

/** L'id d'un finding est aléatoire : on compare tout le reste. */
const withoutIds = (findings: Finding[]): Array<Omit<Finding, "id">> =>
  findings.map(({ id: _id, ...rest }) => rest);

const rulesOf = (findings: Finding[]): Array<string | undefined> => findings.map((f) => f.ruleId);

afterEach(() => {
  delete process.env.QA_EXTENDED;
});

// --- (a) Non-régression ---------------------------------------------------

describe("runCodeChecks sans config = comportement historique", () => {
  it("produit exactement le même résultat qu'avec DEFAULT_RULE_CONFIG explicite", () => {
    const implicit = run();
    const explicit = run(DEFAULT_RULE_CONFIG);
    expect(withoutIds(implicit.findings)).toEqual(withoutIds(explicit.findings));
    expect(implicit.passed).toEqual(explicit.passed);
    // config: null (aucune config en base) doit être traité comme "absente".
    expect(withoutIds(run(null).findings)).toEqual(withoutIds(explicit.findings));
  });

  it("le mail de référence déclenche bien les règles attendues, et rien d'autre", () => {
    const { findings } = run();
    expect(rulesOf(findings).sort()).toEqual([
      "empty-anchor-cta",
      "html-size",
      "personalization-tokens",
      "placeholders",
    ]);
    // Périmètre strict par défaut : aucune règle de qualité générique.
    expect(rulesOf(findings)).not.toContain("copyright-year");
    expect(rulesOf(findings)).not.toContain("image-alt");
  });

  it("chaque finding et chaque contrôle conforme porte une étiquette de règle exploitable", () => {
    const { findings, passed } = run();
    for (const f of findings) {
      expect(f.ruleId, JSON.stringify(f.message.slice(0, 60))).toBeTruthy();
      expect(RULE_BY_ID[f.ruleId!], f.ruleId).toBeDefined();
    }
    // Les contrôles conformes peuvent être hors catalogue (constats bruts), mais
    // ceux qui portent un ruleId doivent référencer une règle réelle.
    for (const p of passed) {
      if (p.ruleId) expect(RULE_BY_ID[p.ruleId], p.ruleId).toBeDefined();
    }
  });
});

// --- (b) Règle éteinte ----------------------------------------------------

describe("une règle éteinte disparaît du rapport", () => {
  it("ses findings ne sont plus produits, les autres sont intacts", () => {
    const off = run(cfgWith({ "empty-anchor-cta": { enabled: false } }));
    expect(rulesOf(off.findings)).not.toContain("empty-anchor-cta");
    expect(rulesOf(off.findings).sort()).toEqual([
      "html-size",
      "personalization-tokens",
      "placeholders",
    ]);
  });

  it("ses contrôles CONFORMES disparaissent aussi (pas de ligne verte orpheline)", () => {
    const facts = makeFacts({ htmlSizeBytes: 10 * 1024 });
    const on = runCodeChecks({ facts, linkResults: [] });
    expect(on.passed.some((p) => p.ruleId === "html-size")).toBe(true);

    const off = runCodeChecks({
      facts,
      linkResults: [],
      config: cfgWith({ "html-size": { enabled: false } }),
    });
    expect(off.passed.some((p) => p.ruleId === "html-size")).toBe(false);
  });

  it("une règle PROTÉGÉE reste appliquée malgré un override d'extinction", () => {
    const off = run(
      cfgWith({
        placeholders: { enabled: false },
        "personalization-tokens": { enabled: false, severity: "MINEUR" },
      })
    );
    const placeholder = off.findings.find((f) => f.ruleId === "placeholders");
    const token = off.findings.find((f) => f.ruleId === "personalization-tokens");
    expect(placeholder?.severite).toBe("CRITIQUE");
    expect(token?.severite).toBe("MAJEUR");
  });
});

// --- (c) Sévérité redéfinie ----------------------------------------------

describe("une sévérité redéfinie est appliquée", () => {
  it("règle réglable : MAJEUR devient MINEUR, le message reste identique", () => {
    const base = run().findings.find((f) => f.ruleId === "empty-anchor-cta")!;
    const tuned = run(cfgWith({ "empty-anchor-cta": { severity: "MINEUR" } })).findings.find(
      (f) => f.ruleId === "empty-anchor-cta"
    )!;
    expect(base.severite).toBe("MAJEUR");
    expect(tuned.severite).toBe("MINEUR");
    expect(tuned.message).toBe(base.message);
  });

  it("règle à sévérité 'auto' : l'override est ignoré", () => {
    // html-size choisit CRITIQUE ou MINEUR selon la taille : la remplacer
    // produirait un verdict absurde (un mail coupé par Gmail classé MINEUR).
    const tuned = run(cfgWith({ "html-size": { severity: "CRITIQUE" } })).findings.find(
      (f) => f.ruleId === "html-size"
    )!;
    expect(tuned.severite).toBe("MINEUR");
  });
});

// --- (d) ruleId hors catalogue -------------------------------------------

describe("un ruleId inconnu du catalogue n'est JAMAIS filtré", () => {
  const REMOVED = "empty-anchor-cta";
  let saved: RuleCatalogEntry | undefined;

  afterEach(() => {
    if (saved) {
      RULE_BY_ID[REMOVED] = saved;
      ALL_RULE_BY_ID[REMOVED] = saved;
    }
    saved = undefined;
  });

  it("une règle retirée du catalogue continue de remonter, avec sa sévérité d'origine", () => {
    // Simule une coquille d'étiquette ou une règle renommée dans le code : la
    // config ne doit pas pouvoir faire disparaître un contrôle en silence.
    saved = RULE_BY_ID[REMOVED];
    delete RULE_BY_ID[REMOVED];
    delete ALL_RULE_BY_ID[REMOVED];

    const out = run(cfgWith({ [REMOVED]: { enabled: false, severity: "MINEUR" } }));
    const orphan = out.findings.find((f) => f.ruleId === REMOVED);
    expect(orphan).toBeDefined();
    expect(orphan!.severite).toBe("MAJEUR");
  });
});

// --- Paramètres pilotés depuis /rules ------------------------------------

describe("paramètres éditables", () => {
  it("html-size : abaisser la limite de coupure fait passer le finding en CRITIQUE", () => {
    const out = run(cfgWith({ "html-size": { params: { clipKb: 80, warnKb: 70 } } }));
    const size = out.findings.find((f) => f.ruleId === "html-size")!;
    expect(size.severite).toBe("CRITIQUE");
    expect(size.message).toContain("80KB");
  });

  it("placeholders : un terme ajouté est détecté LITTÉRALEMENT, jamais comme motif", () => {
    const facts = makeFacts({ textBlocks: ["Our coming soon page is live"] });
    expect(runCodeChecks({ facts, linkResults: [] }).findings).toHaveLength(0);

    const withTerm = runCodeChecks({
      facts,
      linkResults: [],
      config: cfgWith({ placeholders: { params: { extraTerms: ["coming soon"] } } }),
    });
    expect(withTerm.findings[0]?.ruleId).toBe("placeholders");
    expect(withTerm.findings[0]?.message).toContain("coming soon");

    // Un terme contenant des métacaractères ne doit ni exploser ni matcher tout.
    const escaped = runCodeChecks({
      facts,
      linkResults: [],
      config: cfgWith({ placeholders: { params: { extraTerms: [".*", "a(b"] } } }),
    });
    expect(escaped.findings).toHaveLength(0);
  });

  it("personalization-tokens : un token déclaré n'est plus signalé", () => {
    const facts = makeFacts({ personalizationTokens: ["%%civilite%%"] });
    expect(runCodeChecks({ facts, linkResults: [] }).findings).toHaveLength(1);

    const known = runCodeChecks({
      facts,
      linkResults: [],
      config: cfgWith({
        "personalization-tokens": { params: { extraKnownTokens: ["civilite"] } },
      }),
    });
    expect(known.findings).toHaveLength(0);
  });

  it("staging-links : un marqueur d'environnement ajouté est appliqué", () => {
    const linkResults: LinkCheckResult[] = [
      {
        href: "https://uat.maisonlucet.com/spring",
        text: "Shop",
        kind: "statique",
        utm: {},
        status: "ok",
      },
    ];
    const facts = makeFacts();
    expect(
      runCodeChecks({ facts, linkResults }).findings.some((f) => f.ruleId === "staging-links")
    ).toBe(false);

    const withMarker = runCodeChecks({
      facts,
      linkResults,
      config: cfgWith({ "staging-links": { params: { extraTerms: ["uat."] } } }),
    });
    expect(withMarker.findings.some((f) => f.ruleId === "staging-links")).toBe(true);
  });
});

// --- Règles "qualité générique" pilotables sans redéploiement -------------

describe("règles extendedOnly", () => {
  const lastYear = new Date().getFullYear() - 1;
  const facts = makeFacts({ footerText: `© ${lastYear} Maison Lucet` });

  it("éteintes par défaut", () => {
    expect(runCodeChecks({ facts, linkResults: [] }).findings).toHaveLength(0);
  });

  it("allumables depuis /rules SANS QA_EXTENDED (c'est tout l'intérêt de la page)", () => {
    const out = runCodeChecks({
      facts,
      linkResults: [],
      config: cfgWith({ "copyright-year": { enabled: true } }),
    });
    expect(out.findings.map((f) => f.ruleId)).toEqual(["copyright-year"]);
    expect(out.findings[0].message).toContain("Outdated copyright year");
  });

  it("un override explicite 'off' l'emporte sur QA_EXTENDED=1", () => {
    process.env.QA_EXTENDED = "1";
    expect(runCodeChecks({ facts, linkResults: [] }).findings).toHaveLength(1);
    const out = runCodeChecks({
      facts,
      linkResults: [],
      config: cfgWith({ "copyright-year": { enabled: false } }),
    });
    expect(out.findings).toHaveLength(0);
  });
});

// --- Cohérence code ↔ catalogue ------------------------------------------

const SRC = readFileSync(new URL("../checks-code.ts", import.meta.url), "utf8");

describe("cohérence lib/checks-code.ts ↔ lib/rule-catalog.ts", () => {
  const sectionIds = [...SRC.matchAll(/\bsection\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);

  it("le fichier source est bien lu (garde-fou de l'extraction)", () => {
    expect(sectionIds.length).toBeGreaterThan(20);
  });

  it("chaque section(\"…\") référence une règle du catalogue", () => {
    const unknown = [...new Set(sectionIds)].filter((id) => !RULE_BY_ID[id]);
    expect(unknown).toEqual([]);
  });

  it("chaque règle du catalogue est réellement étiquetée dans le code", () => {
    // Une règle affichée dans /rules mais jamais posée sur un finding serait un
    // interrupteur qui n'allume rien.
    const used = new Set(sectionIds);
    expect(RULE_CATALOG.filter((r) => !used.has(r.id)).map((r) => r.id)).toEqual([]);
  });

  it("le seul curseur dynamique reste `auth-${k}` (ids déjà couverts en clair)", () => {
    const dynamic = [...SRC.matchAll(/\bsection\(\s*`([^`]+)`\s*\)/g)].map((m) => m[1]);
    expect(dynamic).toEqual(["auth-${k}"]);
    for (const id of ["auth-spf", "auth-dkim", "auth-dmarc"]) {
      expect(RULE_BY_ID[id], id).toBeDefined();
      expect(sectionIds).toContain(id);
    }
  });

  it("chaque cfg.enabled/int/terms cible une règle et un paramètre existants", () => {
    const problems: string[] = [];
    for (const [, id] of SRC.matchAll(/\.enabled\(\s*"([^"]+)"\s*\)/g)) {
      if (!RULE_BY_ID[id]) problems.push(`enabled("${id}") : règle inconnue`);
    }
    const paramCall = (re: RegExp, kind: "int" | "terms"): void => {
      for (const [, id, key] of SRC.matchAll(re)) {
        const entry = RULE_BY_ID[id];
        if (!entry) {
          problems.push(`${kind}("${id}") : règle inconnue`);
          continue;
        }
        const spec = entry.params?.find((p) => p.key === key);
        if (!spec) problems.push(`${kind}("${id}", "${key}") : paramètre absent du catalogue`);
        else if (spec.kind !== kind) problems.push(`${kind}("${id}", "${key}") : type ${spec.kind}`);
      }
    };
    paramCall(/\.int\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g, "int");
    paramCall(/\.terms\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g, "terms");
    expect(problems).toEqual([]);
  });

  it("les seuils par défaut du catalogue et du code ne peuvent pas diverger", () => {
    // int() fait primer la valeur du CATALOGUE sur le fallback passé à l'appel :
    // relever GMAIL_CLIP_KB dans le code n'aurait donc AUCUN effet tant que le
    // catalogue annonce l'ancienne valeur. Les deux doivent rester alignés.
    const num = (token: string): number | null => {
      if (/^\d+$/.test(token)) return Number(token);
      const decl = new RegExp(`const\\s+${token}\\s*=\\s*(\\d+)\\s*;`).exec(SRC);
      return decl ? Number(decl[1]) : null;
    };
    const mismatches: string[] = [];
    for (const [, id, key, token] of SRC.matchAll(
      /\.int\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*|\d+)\s*\)/g
    )) {
      const spec = RULE_BY_ID[id]?.params?.find((p) => p.key === key);
      const codeValue = num(token);
      if (!spec || spec.kind !== "int" || codeValue === null) continue;
      if (spec.default !== codeValue) {
        mismatches.push(`${id}.${key} : catalogue ${spec.default} ≠ code ${codeValue} (${token})`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("tout paramètre déclaré au catalogue est effectivement lu par le code", () => {
    // Un réglage affiché mais jamais lu donnerait à l'utilisateur l'illusion
    // d'avoir changé quelque chose.
    const read = new Set(
      [...SRC.matchAll(/\.(?:int|terms)\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)].map(
        (m) => `${m[1]}.${m[2]}`
      )
    );
    const orphans = RULE_CATALOG.flatMap((r) =>
      (r.params ?? []).map((p) => `${r.id}.${p.key}`)
    ).filter((k) => !read.has(k));
    expect(orphans).toEqual([]);
  });
});
