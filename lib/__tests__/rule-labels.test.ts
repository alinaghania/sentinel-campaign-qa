// Réécriture métier d'une règle : `label` et `description`.
//
// (L'aiguillage `agent` vivait ici ; il est parti dans agent-catalog.test.ts,
// où il peut être croisé avec le référentiel des agents.)
//
// Ces deux champs ont un point commun qui décide de tout ce fichier : ils
// changent ce que la PERSONNE VOIT sans rien changer à ce que le moteur FAIT.
// D'où le seul défaut qui compte vraiment ici :
//
//   une règle renommée « Poids du mail » par le métier, refusée par le serveur
//   avec le message « "HTML stays under the Gmail clipping limit" … » nomme une
//   règle que la personne ne trouvera nulle part dans sa page. Elle cherchera,
//   ne trouvera pas, et conclura que l'erreur ne la concerne pas.
//
// Chaque assertion sur un message est donc écrite sur la CHAÎNE COMPLÈTE, avec
// son contrôle positif : le même appel SANS réécriture doit citer le libellé du
// code. Sans ce couple, un message qui aurait perdu le nom de la règle
// (`""` à la place du libellé) passerait les deux.
//
// ⚠️ Ce fichier est volontairement séparé : il vise un contrat en cours
// d'implémentation. Isolé, un export manquant fait tomber CE fichier seul et
// laisse les autres suites rendre des chiffres exploitables.

import { describe, expect, it } from "vitest";
import {
  emptyRuleConfig,
  findPii,
  resolveRuleConfig,
  RuleConfigWriteSchema,
  validateAgainstCatalog,
  type RuleConfigWrite,
  type RuleOverride,
} from "../rule-config";
// `effectiveLabel` / `effectiveDescription` vivent dans rule-catalog et non dans
// rule-config : la page cliente les consomme, et rule-config tire des choses
// qu'elle ne peut pas embarquer.
import {
  effectiveDescription,
  effectiveLabel,
  RULE_BY_ID,
  type RuleCatalogEntry,
} from "../rule-catalog";
import { ALL_RULE_BY_ID } from "../rule-registry";
// `activeRulesBlock` : le prompt réellement envoyé, cf. le dernier describe.
import { activeRulesBlock } from "../agents";

// --- Outils ---------------------------------------------------------------

function write(over: Partial<RuleConfigWrite> = {}): RuleConfigWrite {
  return { overrides: {}, customRules: [], customCategories: [], version: 0, ...over };
}

/** Entrée FABRIQUÉE : la sémantique de effectiveLabel ne dépend pas du
 *  catalogue, et l'éprouver sur une entrée réelle ferait échouer le test le jour
 *  où quelqu'un reformule une description — pour une raison sans rapport. */
const FAKE: RuleCatalogEntry = {
  id: "fake-rule",
  label: "Label written in code",
  description: "Description written in code.",
  family: "content",
  defaultSeverity: "MAJEUR",
  severityAdjustable: true,
};

/** Règles témoins du catalogue, avec leurs propriétés supposées. Elles sont
 *  vérifiées dans le premier test : sans ça, un catalogue qui aurait bougé
 *  ferait passer les assertions suivantes à vide. */
const SIZE = "html-size"; // paramétrable, sévérité auto, ni protégée ni verrouillée
const PROTECTED_RULE = "placeholders";
const ORDINARY = "suspicious-links";
const READ_ONLY = "links-unsubscribe-excluded";

describe("garde-fous des règles témoins", () => {
  it("les témoins ont bien les propriétés que ce fichier leur suppose", () => {
    expect(RULE_BY_ID[SIZE].label).toBe("HTML stays under the Gmail clipping limit");
    expect(RULE_BY_ID[SIZE].protected).toBeFalsy();
    expect(RULE_BY_ID[PROTECTED_RULE].label).toBe("No placeholder left in the copy");
    expect(RULE_BY_ID[PROTECTED_RULE].protected).toBe(true);
    expect(RULE_BY_ID[ORDINARY].label).toBe("No suspicious link");
    expect(ALL_RULE_BY_ID[READ_ONLY]?.readOnly).toBe(true);
  });
});

// --- effectiveLabel / effectiveDescription --------------------------------

describe("effectiveLabel / effectiveDescription", () => {
  it("sans override, le texte du CODE", () => {
    expect(effectiveLabel(FAKE)).toBe("Label written in code");
    expect(effectiveDescription(FAKE)).toBe("Description written in code.");
  });

  it("un override sans réécriture ne change rien", () => {
    // `{}` et `undefined` doivent se comporter pareil : un override existe dès
    // qu'on touche à la sévérité, il ne dit rien du libellé pour autant.
    //
    // Le témoin est typé `RuleOverride` complet — c'est ce que passent les vrais
    // appelants (app/rules/page.tsx) — et non un littéral réduit aux deux champs
    // de texte : le contrat à éprouver est justement qu'un override PORTEUR
    // D'AUTRE CHOSE laisse le libellé du code intact.
    const noRewrite: RuleOverride = { enabled: false, severity: "MINEUR" };
    expect(effectiveLabel(FAKE, {})).toBe("Label written in code");
    expect(effectiveLabel(FAKE, noRewrite)).toBe("Label written in code");
    expect(effectiveDescription(FAKE, noRewrite)).toBe("Description written in code.");
  });

  it("avec réécriture, le texte du MÉTIER", () => {
    expect(effectiveLabel(FAKE, { label: "Poids du mail" })).toBe("Poids du mail");
    expect(effectiveDescription(FAKE, { description: "Au-delà, Gmail coupe." })).toBe(
      "Au-delà, Gmail coupe."
    );
  });

  it("les deux champs sont indépendants", () => {
    // Renommer une règle ne doit pas effacer sa description, ni l'inverse : le
    // formulaire n'envoie que le champ modifié.
    expect(effectiveLabel(FAKE, { description: "Autre chose." })).toBe("Label written in code");
    expect(effectiveDescription(FAKE, { label: "Poids du mail" })).toBe(
      "Description written in code."
    );
  });

  it("s'applique aussi à une entrée réelle du catalogue", () => {
    expect(effectiveLabel(RULE_BY_ID[ORDINARY])).toBe("No suspicious link");
    expect(effectiveLabel(RULE_BY_ID[ORDINARY], { label: "Lien douteux" })).toBe("Lien douteux");
  });
});

// --- Schéma : bornes de la réécriture -------------------------------------

const parses = (body: RuleConfigWrite): boolean => RuleConfigWriteSchema.safeParse(body).success;

/** Miroir exact de l'appel de la route (`app/api/rules/route.ts`, PUT) : elle
 *  n'injecte AUCUNE liste, elle laisse le défaut de validateAgainstCatalog —
 *  AGENT_KEYS, lu du même lib/agent-catalog.ts que la liste servie à la page.
 *  Un test qui injecterait la sienne resterait vert si ce défaut désignait
 *  autre chose : c'est justement le seul endroit où le référentiel n'est plus
 *  visible dans l'appel. Que le paramètre soit honoré quand on l'injecte est
 *  mesuré dans agent-catalog.test.ts, pas ici. */
const validate = (body: RuleConfigWrite): string[] => validateAgainstCatalog(body);

describe("RuleConfigWriteSchema — label et description réécrits", () => {
  it("accepte une réécriture conforme", () => {
    expect(
      parses(
        write({
          overrides: { [SIZE]: { label: "Poids du mail", description: "Au-delà, Gmail coupe." } },
        })
      )
    ).toBe(true);
  });

  it("refuse un label vide ou de plus de 120 caractères, accepte la borne exacte", () => {
    expect(parses(write({ overrides: { [SIZE]: { label: "" } } }))).toBe(false);
    expect(parses(write({ overrides: { [SIZE]: { label: "x".repeat(121) } } }))).toBe(false);
    expect(parses(write({ overrides: { [SIZE]: { label: "x".repeat(120) } } }))).toBe(true);
    expect(parses(write({ overrides: { [SIZE]: { label: "x" } } }))).toBe(true);
  });

  it("refuse une description vide ou de plus de 400 caractères, accepte la borne exacte", () => {
    expect(parses(write({ overrides: { [SIZE]: { description: "" } } }))).toBe(false);
    expect(parses(write({ overrides: { [SIZE]: { description: "x".repeat(401) } } }))).toBe(false);
    expect(parses(write({ overrides: { [SIZE]: { description: "x".repeat(400) } } }))).toBe(true);
  });

  it("les deux champs restent OPTIONNELS", () => {
    // Rétro-compatibilité : la quasi-totalité des overrides enregistrés n'a ni
    // l'un ni l'autre, et un champ requis rendrait la config insauvegardable.
    expect(parses(write({ overrides: { [SIZE]: { params: { clipKb: 120 } } } }))).toBe(true);
  });
});

// --- validateAgainstCatalog : qui a le droit d'être réécrit ---------------

describe("validateAgainstCatalog — réécriture", () => {
  it("une règle ordinaire peut être renommée et redécrite", () => {
    expect(
      validate(
        write({ overrides: { [ORDINARY]: { label: "Lien douteux", description: "Explication." } } })
      )
    ).toEqual([]);
  });

  it("une règle en LECTURE SEULE ne peut être ni renommée ni redécrite", () => {
    // Elle affiche une valeur verrouillée et la RAISON du verrou : la renommer
    // ferait mentir cette explication, qui parle d'un réglage précis du code.
    expect(
      validate(write({ overrides: { [READ_ONLY]: { label: "Autre nom" } } })).length
    ).toBeGreaterThan(0);
    expect(
      validate(write({ overrides: { [READ_ONLY]: { description: "Autre texte." } } }))
        .length
    ).toBeGreaterThan(0);
  });

  it("une règle en lecture seule SANS réécriture passe (contrôle positif)", () => {
    // Sinon un validateur qui refuserait toute mention de cette règle ferait
    // passer le test ci-dessus sans rien vérifier.
    expect(validate(write({ overrides: { [READ_ONLY]: {} } }))).toEqual([]);
  });
});

// --- LE test du lot : les messages nomment la règle telle qu'elle est VUE --

describe("les messages nomment le libellé EFFECTIF, pas celui du code", () => {
  it("réglage inconnu : le message cite le nom réécrit", () => {
    expect(
      validate(
        write({
          overrides: { [SIZE]: { label: "Poids du mail", params: { clipKilobytes: 120 } } },
        })
      )
    ).toEqual(['Unknown setting "clipKilobytes" on "Poids du mail".']);
  });

  it("réglage inconnu, SANS réécriture : le message cite le nom du code", () => {
    // Contrôle positif indispensable : il prouve que le message est bien
    // construit à partir d'un libellé, et que le test précédent ne passe pas
    // parce que la chaîne aurait perdu le nom de la règle.
    expect(
      validate(write({ overrides: { [SIZE]: { params: { clipKilobytes: 120 } } } }))
    ).toEqual(['Unknown setting "clipKilobytes" on "HTML stays under the Gmail clipping limit".']);
  });

  it("refus d'éteindre une règle protégée : le message cite le nom réécrit", () => {
    expect(
      validate(
        write({
          overrides: {
            [PROTECTED_RULE]: { label: "Pas de texte de remplissage", enabled: false },
          },
        })
      )
    ).toEqual(['"Pas de texte de remplissage" cannot be disabled.']);
  });

  it("refus d'éteindre une règle protégée, SANS réécriture (contrôle positif)", () => {
    expect(
      validate(write({ overrides: { [PROTECTED_RULE]: { enabled: false } } }))
    ).toEqual(['"No placeholder left in the copy" cannot be disabled.']);
  });

  it("sévérité imposée sur une règle 'auto' : le message cite le nom réécrit", () => {
    expect(
      validate(
        write({ overrides: { [SIZE]: { label: "Poids du mail", severity: "CRITIQUE" } } })
      )
    ).toEqual(['"Poids du mail" chooses its own severity and cannot be overridden.']);
  });

  it("l'alerte PII sur un exemple cite le nom réécrit", () => {
    const out = findPii([], {
      [ORDINARY]: {
        label: "Lien douteux",
        examples: [{ kind: "ko", text: "Escalate to qa-lead@example.com." }],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Rule "Lien douteux"');
    expect(out[0]).not.toContain("No suspicious link");
  });

  it("l'alerte PII sans réécriture cite le nom du code (contrôle positif)", () => {
    const out = findPii([], {
      [ORDINARY]: { examples: [{ kind: "ko", text: "Escalate to qa-lead@example.com." }] },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Rule "No suspicious link"');
  });
});


// --- Le libellé réécrit doit atteindre le MODÈLE, pas seulement l'écran ------

// Jusqu'ici ce fichier ne mesurait la réécriture que sur `effectiveLabel` et sur
// des messages d'erreur. Or l'endroit où elle sert vraiment est le prompt : le
// modèle recopie `rule_id` mais RÉDIGE son constat avec le nom qu'on lui a
// annoncé. Annoncer le libellé du code ferait réapparaître l'ancien nom dans le
// rapport, alors que plus aucun écran ne l'affiche — et personne ne saurait dire
// d'où il sort. C'est `activeRulesBlock` qui décide, via `cfg.label`
// (lib/agents.ts:281) ; le tester sur `effectiveLabel` seul laisserait ce
// chaînon-là sans témoin.
describe("le libellé réécrit arrive jusqu'au prompt", () => {
  // Témoin : une règle du catalogue LLM confiée à l'agent assets. Libellés
  // écrits EN DUR — les relire depuis le catalogue rejouerait le code testé.
  const WITNESS = "llm-assets-alt-relevance";
  const CODE_LABEL = "Image alt text actually describes the image";
  const REWRITTEN = "L'alternative décrit vraiment l'image";

  const blockFor = (overrides: Record<string, RuleOverride>): string =>
    activeRulesBlock("assets", resolveRuleConfig({ ...emptyRuleConfig(), overrides }));

  it("CONTRÔLE POSITIF — sans réécriture, le prompt annonce le libellé du CODE", () => {
    // Sans lui, un `activeRulesBlock` qui ne nommerait jamais cette règle ferait
    // passer le test suivant : « l'ancien nom est absent » est vrai aussi quand
    // la ligne entière manque.
    expect(blockFor({})).toContain(`- ${WITNESS} : ${CODE_LABEL}`);
  });

  it("avec réécriture, le prompt annonce le NOUVEAU libellé et plus l'ancien", () => {
    const out = blockFor({ [WITNESS]: { label: REWRITTEN } });
    expect(out).toContain(`- ${WITNESS} : ${REWRITTEN}`);
    expect(out).not.toContain(CODE_LABEL);
  });

  it("une règle DÉSACTIVÉE ne s'annonce plus du tout", () => {
    // L'autre moitié du contrat : le libellé n'a pas à survivre à l'extinction
    // de sa règle. Une règle annoncée mais éteinte ferait produire au modèle un
    // finding qu'aucun écran ne réclame.
    expect(blockFor({ [WITNESS]: { enabled: false } })).not.toContain(WITNESS);
  });
});
