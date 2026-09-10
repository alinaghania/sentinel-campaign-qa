// Schémas Zod partagés — source de vérité unique pour tous les agents.
// Zod v4 : z.toJSONSchema natif. On strippe les mots-clés non supportés par
// l'input_schema Anthropic en mode strict (maxLength, maxItems, minimum...)
// et on garde la validation complète côté client via safeParse.

import { z } from "zod";
import { FINDING_TITLES_AGENT } from "./finding-titles";

export const SeveriteSchema = z.enum(["CRITIQUE", "MAJEUR", "MINEUR", "OK"]);

export const AgentFindingSchema = z.object({
  categorie: z.enum([
    "assets",
    "liens",
    "tracking",
    "brief",
    "guidelines",
    "contenu",
    "rendu",
    "delivrabilite",
    "technique",
  ]),
  severite: SeveriteSchema,
  title: z
    .enum(FINDING_TITLES_AGENT)
    .optional()
    .describe(
      "Titre du finding, choisi dans la liste — celui qui nomme le PROBLÈME constaté"
    ),
  message: z.string().min(1),
  evidence: z.string().max(300),
  locator: z.string(),
  suggestion: z.string().optional(),
  /** Identifiant de la règle vérifiée, choisi dans la liste fournie à l'agent
   *  dans son message utilisateur. OPTIONNEL et volontairement `string` plutôt
   *  qu'un enum fermé : un enum forcerait un retry coûteux à chaque fois que le
   *  modèle sort de la liste, et surtout un finding sans ruleId reconnu doit
   *  simplement rester non filtrable — jamais faire échouer le rapport.
   *  Un id inconnu est écarté au post-traitement (le finding, lui, est gardé). */
  rule_id: z
    .string()
    .max(60)
    .optional()
    .describe(
      "Identifiant de la règle vérifiée, copié EXACTEMENT depuis la liste RÈGLES À VÉRIFIER. Omets-le si le constat ne correspond à aucune règle de la liste."
    ),
  expected: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Valeur ATTENDUE (brief/référence) copiée VERBATIM — uniquement si le finding est un écart brief↔email comparable"
    ),
  received: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Valeur REÇUE (email) copiée VERBATIM depuis les faits — uniquement avec expected ; vérifiée automatiquement par recherche de sous-chaîne"
    ),
});

export const AgentReportSchema = z.object({
  raisonnement: z
    .string()
    .describe("2-3 phrases max : ce que tu as observé avant de conclure"),
  findings: z.array(AgentFindingSchema).max(30),
  checks_passed: z
    .array(z.object({ label: z.string() }))
    .max(30)
    .describe("Contrôles vérifiés et conformes"),
});
export type AgentReportOut = z.infer<typeof AgentReportSchema>;

const BriefFieldSchema = z.object({
  value: z.string().nullable(),
  quote: z
    .string()
    .nullable()
    .describe(
      "Extrait VERBATIM du brief justifiant la valeur. null si value est null. Sera vérifié automatiquement."
    ),
  confidence: z.enum(["high", "medium", "low"]),
});

export const BriefExtractionSchema = z.object({
  campaign_name: BriefFieldSchema,
  market: BriefFieldSchema,
  email_type: BriefFieldSchema,
  target_audience: BriefFieldSchema,
  send_datetime: BriefFieldSchema,
  subject_line: BriefFieldSchema,
  preheader: BriefFieldSchema,
  key_message: BriefFieldSchema,
  offer: BriefFieldSchema,
  promo_code: BriefFieldSchema,
  cta_label: BriefFieldSchema,
  landing_urls: BriefFieldSchema,
  utm_campaign: BriefFieldSchema,
  legal_mentions: BriefFieldSchema,
  // Champs xlsm Kering (feuille Common / EMAIL) — optionnels, tolérants :
  // le LLM peut les omettre sur les briefs qui ne les contiennent pas.
  campaign_type: BriefFieldSchema.optional(),
  campaign_subtype: BriefFieldSchema.optional(),
  campaign_category: BriefFieldSchema.optional(),
  salesforce_campaign_name: BriefFieldSchema.optional(),
  missing_fields: z.array(z.string()),
});
export type BriefExtractionOut = z.infer<typeof BriefExtractionSchema>;

export const CompiledRuleSchema = z.object({
  id: z.string().describe("kebab-case, ex: no-tutoiement"),
  title: z.string(),
  description: z.string(),
  category: z.enum(["lexical", "tone", "format", "structure", "legal", "links"]),
  engine: z.enum(["code", "llm", "hybrid"]),
  severity: z.enum(["error", "warning", "suggestion"]),
  params: z
    .object({
      check: z
        .enum([
          "forbidden_terms",
          "required_text",
          "regex",
          "max_length",
          "link_domains",
        ])
        .optional(),
      tokens: z.array(z.string()).optional(),
      exactText: z.string().optional(),
      max: z.number().optional(),
    })
    .optional(),
  examples: z
    .object({ good: z.array(z.string()), bad: z.array(z.string()) })
    .optional(),
  exceptions: z.array(z.string()).optional(),
});

export const GuidelinesCompilationSchema = z.object({
  rules: z.array(CompiledRuleSchema).max(40),
  contradictions: z
    .array(z.string())
    .describe("Contradictions détectées entre guidelines, à confirmer par l'humain"),
});
export type GuidelinesCompilationOut = z.infer<typeof GuidelinesCompilationSchema>;

// --- JSON Schema pour l'API (strip des mots-clés non supportés en strict) ---

const UNSUPPORTED_KEYS = new Set([
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "format",
  "default",
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYS.has(k)) continue;
      out[k] = stripUnsupported(v);
    }
    if (out.type === "object") {
      out.additionalProperties = false;
      if (out.properties && !out.required) {
        out.required = Object.keys(out.properties as Record<string, unknown>);
      }
    }
    return out;
  }
  return node;
}

// ── Plan de parsing du "structure scout" (lib/brief-scout) ──
// Le LLM ne produit QUE des coordonnées/mappings vérifiables — jamais de
// contenu. Blocs de BASE en enum fermée ; les variantes ("(male & others)",
// "(female)", "(WOMEN)"…) passent par variant_suffix libre borné.
export const SCOUT_CANONICAL_BLOCKS = [
  "Subject line",
  "Subject line default",
  "Preheader",
  "Title",
  "COPY 1",
  "COPY 2",
  "CTA 1",
  "CTA 2",
  "CTA 3",
  "Banner",
  "Hero",
  "Header",
  "Footer",
] as const;

export const BriefParsePlanSchema = z.object({
  content_sheet: z.string().min(1).max(60).describe("Nom EXACT d'une feuille du classeur contenant la grille de contenu email"),
  header_row: z.number().int().min(1).max(500).describe("Ligne (1-based, numéros R<n> fournis) de l'en-tête des colonnes"),
  label_col: z.string().regex(/^[A-Z]{1,2}$/).describe("Colonne des libellés de champs (lettre Excel)"),
  value_col_is_placeholder: z.boolean().describe("true si la colonne VALUE recopie le template (placeholders) et doit être ignorée"),
  lang_columns: z
    .array(z.object({
      col: z.string().regex(/^[A-Z]{1,2}$/),
      lang: z.string().min(2).max(30).describe("Code ou libellé de langue tel qu'affiché (ex MX, en-GB, FR)"),
    }))
    .min(1)
    .max(15)
    .describe("Colonnes contenant le CONTENU RÉEL, une par langue/marché"),
  field_mappings: z
    .array(z.object({
      row: z.number().int().min(1).max(2000),
      raw_label: z.string().min(1).max(200).describe("Libellé EXACT de la cellule (recopié tel quel — revérifié par code)"),
      canonical_block: z.enum(SCOUT_CANONICAL_BLOCKS).nullable().describe("null si le champ n'a pas d'équivalent (métadonnée…) — alors skip_reason requis"),
      variant_suffix: z.string().max(40).nullable().describe('Variante du bloc, ex "(male & others)", "(female)", "(WOMEN)" — null sinon'),
      is_url_row: z.boolean().describe("true si la ligne porte une URL attendue (lien CTA/packshot/hero)"),
      url_market: z.string().regex(/^[A-Z]{2,5}$/).nullable().describe("Marché du lien (WW, CN, JP…) si is_url_row, sinon null"),
      skip_reason: z.string().max(120).nullable(),
    }))
    .min(1)
    .max(60),
  sample_checks: z
    .array(z.object({
      cell: z.string().regex(/^[A-Z]{1,2}\d{1,4}$/).describe("Adresse A1 sur content_sheet"),
      snippet: z.string().min(3).max(60).describe("Extrait EXACT (≤60 chars) du CONTENU RÉEL de cette cellule"),
    }))
    .min(2)
    .max(5)
    .describe("Ancres de vérification : le code rejette le plan si les extraits ne sont pas retrouvés"),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(500),
});
export type BriefParsePlan = z.infer<typeof BriefParsePlanSchema>;

export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  delete (json as Record<string, unknown>)["$schema"];
  return stripUnsupported(json) as Record<string, unknown>;
}
