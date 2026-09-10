// Catégories libres et exemples par règle — les deux champs ouverts à la
// saisie par la refonte de /rules.
//
// Ce qu'ils ont en commun, et qui justifie de les tester ensemble : ce sont les
// seuls endroits où du texte saisi par une personne fonctionnelle voyage
// jusqu'au PROMPT d'un agent (les exemples) ou jusqu'au RANGEMENT de la page
// (les catégories). Deux défauts précis sont donc à interdire :
//
//  1. une catégorie FANTÔME — un id qui ne désigne ni une famille du catalogue,
//     ni une catégorie déclarée dans la même écriture. Les règles rangées
//     dedans disparaîtraient de l'écran tout en continuant à produire des
//     findings : un contrôle que plus personne ne peut retrouver pour l'éteindre ;
//  2. un exemple SANS BORNE — six exemples par règle, vingt règles : sans
//     plafond, le contexte de l'agent "Conformité guidelines" se remplit de
//     texte libre jusqu'à évincer l'email lui-même.
//
// Chaque « ça refuse bien » est doublé de son contrôle positif : un schéma
// cassé qui refuserait TOUT ferait autrement passer la moitié de ce fichier.

import { describe, expect, it } from "vitest";
import {
  findPii,
  RuleConfigWriteSchema,
  validateAgainstCatalog,
  type CustomCategory,
  type CustomRule,
  type RuleConfigWrite,
  type RuleExample,
} from "../rule-config";
import {
  CUSTOM_CATEGORY_LABEL_MAX,
  CUSTOM_CATEGORY_MAX,
  FAMILY_LABELS,
  FAMILY_ORDER,
  RULE_EXAMPLES_MAX,
  RULE_EXAMPLE_MAX_CHARS,
} from "../rule-catalog";

// --- Outils ---------------------------------------------------------------

type WritableCustomRule = CustomRule & { severity: "MAJEUR" | "MINEUR" };

function custom(over: Partial<WritableCustomRule> = {}): WritableCustomRule {
  return {
    id: "r1",
    title: "No superlatives",
    instruction: "The copy must not use superlatives such as best or unbeatable.",
    category: "content",
    examples: [],
    severity: "MAJEUR",
    enabled: true,
    ...over,
  };
}

function write(over: Partial<RuleConfigWrite> = {}): RuleConfigWrite {
  return { overrides: {}, customRules: [], customCategories: [], version: 0, ...over };
}

const parses = (body: RuleConfigWrite): boolean => RuleConfigWriteSchema.safeParse(body).success;

/** Miroir exact de l'appel de la route (`app/api/rules/route.ts`, PUT) : elle
 *  n'injecte AUCUNE liste, elle laisse le défaut de validateAgainstCatalog —
 *  AGENT_KEYS, lu du même lib/agent-catalog.ts que la liste servie à la page.
 *  Un test qui injecterait la sienne resterait vert si ce défaut désignait
 *  autre chose : c'est justement le seul endroit où le référentiel n'est plus
 *  visible dans l'appel. Que le paramètre soit honoré quand on l'injecte est
 *  mesuré dans agent-catalog.test.ts, pas ici. */
const validate = (body: RuleConfigWrite): string[] => validateAgainstCatalog(body);

/** N catégories distinctes et valides, pour éprouver le seul plafond. */
const categories = (n: number): CustomCategory[] =>
  Array.from({ length: n }, (_, i) => ({ id: `cat-${i}`, label: `Category ${i}` }));

const examples = (n: number, kind: RuleExample["kind"] = "ko"): RuleExample[] =>
  Array.from({ length: n }, (_, i) => ({ kind, text: `Example ${i}` }));

/** Règle témoin du catalogue : ni protégée, ni en lecture seule. */
const ORDINARY = "suspicious-links";

// --- Les bornes elles-mêmes ------------------------------------------------

describe("les plafonds annoncés", () => {
  it("valent bien ce que la page et l'API promettent", () => {
    // Écrits en dur : tous les tests ci-dessous se calent sur ces constantes, et
    // une constante relevée en silence les ferait tous suivre sans que personne
    // ne constate le changement de contrat.
    expect(CUSTOM_CATEGORY_MAX).toBe(12);
    expect(CUSTOM_CATEGORY_LABEL_MAX).toBe(40);
    expect(RULE_EXAMPLES_MAX).toBe(6);
    expect(RULE_EXAMPLE_MAX_CHARS).toBe(300);
  });
});

// --- Les familles du catalogue, qui servent de catégories implicites -------

describe("familles du catalogue", () => {
  it("FAMILY_ORDER et FAMILY_LABELS listent exactement les mêmes familles", () => {
    // Une famille présente dans FAMILY_LABELS mais absente de FAMILY_ORDER
    // compile parfaitement et devient INVISIBLE à l'écran : ses règles existent,
    // tournent, et aucun onglet ne les montre. L'inverse (dans l'ordre mais sans
    // libellé) affiche un onglet sans nom. Aucun des deux ne casse le build.
    expect([...FAMILY_ORDER].sort()).toEqual(Object.keys(FAMILY_LABELS).sort());
  });

  it("FAMILY_ORDER ne cite aucune famille deux fois", () => {
    expect(new Set(FAMILY_ORDER).size).toBe(FAMILY_ORDER.length);
  });

  it('"translation" existe, se lit "Translation" et se range juste après "brief"', () => {
    expect(FAMILY_LABELS.translation).toBe("Translation");
    expect(FAMILY_ORDER[FAMILY_ORDER.indexOf("brief") + 1]).toBe("translation");
  });

  it('"translation" est une catégorie valide, comme toute autre famille', () => {
    expect(
      validate(write({ customRules: [custom({ category: "translation" })] }))
    ).toEqual([]);
    expect(
      validate(write({ overrides: { [ORDINARY]: { category: "translation" } } }))
    ).toEqual([]);
  });

  it('une catégorie custom nommée "translation" est refusée comme doublon', () => {
    // Contrôle croisé : si la famille n'était PAS reconnue, ce doublon ne serait
    // pas détecté et le test précédent passerait pour la mauvaise raison.
    expect(
      validate(
        write({ customCategories: [{ id: "translation", label: "Traductions" }] })
      )
    ).toEqual([expect.stringContaining('Duplicate category id "translation"')]);
  });
});

// --- Schéma des catégories -------------------------------------------------

describe("RuleConfigWriteSchema — catégories", () => {
  it("accepte une catégorie conforme", () => {
    expect(parses(write({ customCategories: [{ id: "promo-2026", label: "Promotions" }] }))).toBe(
      true
    );
  });

  it("refuse un id hors du slug attendu", () => {
    const bads = ["Promo", "promo code", "promo_code", "promo!", "", "é", "p".repeat(41)];
    for (const id of bads) {
      expect(parses(write({ customCategories: [{ id, label: "Promotions" }] })), id).toBe(false);
    }
  });

  it("accepte les slugs légitimes voisins (contrôle positif)", () => {
    for (const id of ["a", "promo", "promo-2026", "2026", "p".repeat(40)]) {
      expect(parses(write({ customCategories: [{ id, label: "Promotions" }] })), id).toBe(true);
    }
  });

  it("refuse un libellé vide ou trop long, accepte la longueur maximale exacte", () => {
    expect(parses(write({ customCategories: [{ id: "promo", label: "" }] }))).toBe(false);
    expect(
      parses(
        write({
          customCategories: [{ id: "promo", label: "x".repeat(CUSTOM_CATEGORY_LABEL_MAX + 1) }],
        })
      )
    ).toBe(false);
    expect(
      parses(
        write({
          customCategories: [{ id: "promo", label: "x".repeat(CUSTOM_CATEGORY_LABEL_MAX) }],
        })
      )
    ).toBe(true);
  });

  it(`refuse au-delà de ${CUSTOM_CATEGORY_MAX} catégories, accepte le plafond exact`, () => {
    expect(parses(write({ customCategories: categories(CUSTOM_CATEGORY_MAX) }))).toBe(true);
    expect(parses(write({ customCategories: categories(CUSTOM_CATEGORY_MAX + 1) }))).toBe(false);
  });

  it("une charge utile sans customCategories parse et vaut liste vide", () => {
    // Rétro-compatibilité : la page d'avant n'envoyait pas ce champ.
    const parsed = RuleConfigWriteSchema.parse({ overrides: {}, customRules: [], version: 0 });
    expect(parsed.customCategories).toEqual([]);
  });
});

// --- validateAgainstCatalog — à quoi une catégorie a le droit de renvoyer ---

describe("validateAgainstCatalog — catégories", () => {
  it("une FAMILLE du catalogue est une catégorie valide", () => {
    // Les familles restent des catégories implicites : elles n'ont pas à être
    // recopiées dans customCategories pour être utilisables.
    for (const family of ["content", "links", "brand"]) {
      expect(Object.keys(FAMILY_LABELS), family).toContain(family);
      expect(validate(write({ customRules: [custom({ category: family })] })), family)
        .toEqual([]);
    }
  });

  it("une catégorie déclarée dans la MÊME écriture est valide", () => {
    // La catégorie et la règle qui l'utilise arrivent dans la même requête : les
    // valider l'une après l'autre en refusant la seconde rendrait impossible de
    // créer une catégorie et d'y ranger une règle en un seul enregistrement.
    expect(
      validate(
        write({
          customCategories: [{ id: "promo", label: "Promotions" }],
          customRules: [custom({ category: "promo" })],
        })
      )
    ).toEqual([]);
  });

  it("une catégorie INCONNUE est refusée, sur une règle custom", () => {
    expect(
      validate(write({ customRules: [custom({ category: "promo" })] }))
    ).toEqual([expect.stringContaining('Unknown category "promo"')]);
  });

  it("une catégorie INCONNUE est refusée, sur un override du catalogue", () => {
    expect(
      validate(write({ overrides: { [ORDINARY]: { category: "promo" } } }))
    ).toEqual([expect.stringContaining('Unknown category "promo"')]);
  });

  it("un override peut être rangé dans une famille ou dans une catégorie déclarée", () => {
    expect(
      validate(write({ overrides: { [ORDINARY]: { category: "brand" } } }))
    ).toEqual([]);
    expect(
      validate(
        write({
          customCategories: [{ id: "promo", label: "Promotions" }],
          overrides: { [ORDINARY]: { category: "promo" } },
        })
      )
    ).toEqual([]);
  });

  it("deux catégories portant le même id sont refusées", () => {
    expect(
      validate(
        write({
          customCategories: [
            { id: "promo", label: "Promotions" },
            { id: "promo", label: "Promos été" },
          ],
        })
      )
    ).toEqual([expect.stringContaining('Duplicate category id "promo"')]);
  });

  it("une catégorie qui reprend l'id d'une FAMILLE est refusée aussi", () => {
    // Deux entrées "content" dans la liste : la page en afficherait une et
    // rangerait les règles dans l'autre, sans que rien ne le signale.
    expect(
      validate(
        write({ customCategories: [{ id: "content", label: "Contenu maison" }] })
      )
    ).toEqual([expect.stringContaining('Duplicate category id "content"')]);
  });

  it("deux catégories distinctes passent (contrôle positif)", () => {
    expect(
      validate(
        write({
          customCategories: [
            { id: "promo", label: "Promotions" },
            { id: "legal", label: "Legal" },
          ],
        })
      )
    ).toEqual([]);
  });
});

// --- Schéma des exemples ---------------------------------------------------

describe("RuleConfigWriteSchema — exemples", () => {
  it("accepte les deux natures d'exemple", () => {
    expect(
      parses(
        write({
          customRules: [
            custom({
              examples: [
                { kind: "ko", text: "The best offer ever." },
                { kind: "ok", text: "A new offer." },
              ],
            }),
          ],
        })
      )
    ).toBe(true);
  });

  it("refuse une nature hors énumération", () => {
    // Payload non typé : c'est exactement ce qu'un appel API direct enverrait.
    for (const kind of ["meh", "OK", "bad", ""]) {
      const payload = {
        ...write(),
        customRules: [{ ...custom(), examples: [{ kind, text: "Something." }] }],
      };
      expect(RuleConfigWriteSchema.safeParse(payload).success, kind).toBe(false);
    }
  });

  it(`refuse au-delà de ${RULE_EXAMPLES_MAX} exemples, accepte le plafond exact`, () => {
    expect(parses(write({ customRules: [custom({ examples: examples(RULE_EXAMPLES_MAX) })] }))).toBe(
      true
    );
    expect(
      parses(write({ customRules: [custom({ examples: examples(RULE_EXAMPLES_MAX + 1) })] }))
    ).toBe(false);
  });

  it("le même plafond s'applique aux exemples posés sur une règle du catalogue", () => {
    expect(
      parses(write({ overrides: { [ORDINARY]: { examples: examples(RULE_EXAMPLES_MAX) } } }))
    ).toBe(true);
    expect(
      parses(write({ overrides: { [ORDINARY]: { examples: examples(RULE_EXAMPLES_MAX + 1) } } }))
    ).toBe(false);
  });

  it(`refuse un exemple de plus de ${RULE_EXAMPLE_MAX_CHARS} caractères`, () => {
    const at = (n: number): RuleExample => ({ kind: "ko", text: "x".repeat(n) });
    expect(parses(write({ customRules: [custom({ examples: [at(RULE_EXAMPLE_MAX_CHARS)] })] }))).toBe(
      true
    );
    expect(
      parses(write({ customRules: [custom({ examples: [at(RULE_EXAMPLE_MAX_CHARS + 1)] })] }))
    ).toBe(false);
  });

  it("une règle sans champ examples parse et vaut liste vide", () => {
    const parsed = RuleConfigWriteSchema.parse({
      overrides: {},
      customRules: [{ id: "r1", title: "No superlatives", enabled: true }],
      customCategories: [],
      version: 0,
    });
    expect(parsed.customRules[0].examples).toEqual([]);
  });
});

// --- findPii × exemples ----------------------------------------------------

describe("findPii lit aussi les exemples", () => {
  it("détecte une adresse email écrite dans un contre-exemple", () => {
    // Le contrôle ne portait que sur l'instruction : un exemple est un endroit
    // AU MOINS aussi naturel pour recopier un vrai email de test, et il part
    // dans le prompt de la même façon.
    const out = findPii([
      custom({ examples: [{ kind: "ko", text: "Contact qa-lead@example.com for sign-off." }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("an email address");
    expect(out[0]).toContain("No superlatives");
  });

  it("détecte un numéro de téléphone dans un exemple conforme", () => {
    expect(
      findPii([custom({ examples: [{ kind: "ok", text: "Call 06 12 34 56 78." }] })])
    ).toEqual([expect.stringContaining("a phone number")]);
  });

  it("des exemples sans donnée personnelle ne déclenchent rien (contrôle positif)", () => {
    expect(
      findPii([
        custom({
          examples: [
            { kind: "ko", text: "The best offer ever." },
            { kind: "ok", text: "A new offer." },
          ],
        }),
      ])
    ).toEqual([]);
  });

  it("au plus une alerte par ENDROIT — jamais une par motif trouvé", () => {
    // L'énoncé et les exemples sont deux endroits distincts, et le message le
    // dit : on ne va pas envoyer quelqu'un fouiller l'instruction quand le
    // numéro est dans un exemple. En revanche quatre motifs ne font pas quatre
    // alertes — la route rendrait une liste que personne ne lit.
    const out = findPii([
      custom({
        instruction: "Ping qa@example.com or call 06 12 34 56 78 when unsure.",
        examples: [
          { kind: "ko", text: "Contact sales@example.com." },
          { kind: "ko", text: "Call 07 98 76 54 32." },
        ],
      }),
    ]);
    expect(out).toHaveLength(2);
    for (const msg of out) expect(msg).toContain("No superlatives");
    expect(out.filter((m) => m.includes("example"))).toHaveLength(1);
  });

  it("un exemple attaché à une règle du CATALOGUE est scanné lui aussi", () => {
    // Les exemples ne vivent pas que sur les règles écrites à la main : un
    // override en porte aussi, et ils partent dans le même prompt.
    const out = findPii([], {
      [ORDINARY]: { examples: [{ kind: "ko", text: "Escalate to qa-lead@example.com." }] },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("an email address");
    // Le message cite le LIBELLÉ affiché dans la page, pas l'id : citer
    // "suspicious-links" obligerait à chercher la ligne à la main.
    expect(out[0]).toContain("No suspicious link");
  });

  it("un exemple de catalogue sans donnée personnelle ne déclenche rien (contrôle positif)", () => {
    expect(
      findPii([], { [ORDINARY]: { examples: [{ kind: "ko", text: "A shortened bit.ly link." }] } })
    ).toEqual([]);
  });

  it("une règle stockée SANS champ examples ne fait pas tomber le contrôle", () => {
    // Rétro-compatibilité : la config en base contient des règles écrites avant
    // l'existence du champ. `r.examples.some(...)` lèverait, et la route PUT
    // rendrait un 500 au lieu de valider.
    const legacy = [
      {
        id: "r1",
        title: "No superlatives",
        instruction: "Never write best.",
        severity: "MAJEUR",
        enabled: true,
      },
    ] as unknown as CustomRule[];
    expect(findPii(legacy)).toEqual([]);
  });
});
