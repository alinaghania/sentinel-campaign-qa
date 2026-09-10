// runAgent : tool use forcé (strict) + validation Zod + 1 retry self-heal.
// En cas d'échec après retry → { ok: false } : l'agrégateur affiche
// "vérification non effectuée", jamais de faux "tout va bien".

import { z } from "zod";
import { callMessages, ContentBlock, FoundryMessage } from "./foundry";
import { toInputSchema } from "./schemas";

export type AgentResult<T> =
  | {
      ok: true;
      data: T;
      // Trace pour le terminal live : tokens réels (cumulés sur les self-heals),
      // nombre de tentatives, nom de l'outil appelé.
      usage: { input_tokens: number; output_tokens: number };
      attempts: number;
      toolName: string;
    }
  | { ok: false; error: string };

export async function runAgent<S extends z.ZodType>(opts: {
  model: string;
  system: string;
  user: string | ContentBlock[];
  schema: S;
  toolName?: string;
  toolDescription?: string;
  maxTokens?: number;
  maxHeals?: number;
  timeoutMs?: number;
  strict?: boolean;
}): Promise<AgentResult<z.infer<S>>> {
  const toolName = opts.toolName ?? "emit_report";
  const tool = {
    name: toolName,
    description:
      opts.toolDescription ??
      "Rends ton rapport d'analyse structuré. C'est ta SEULE sortie autorisée.",
    input_schema: toInputSchema(opts.schema),
    // strict garantit input==schéma, mais Foundry plafonne à 16 paramètres
    // à union (nullable) — les gros schémas passent en strict:false
    // (la validation Zod + self-heal reste le filet).
    strict: opts.strict ?? true,
  };

  let messages: FoundryMessage[] = [
    { role: "user", content: opts.user },
  ];
  const maxHeals = opts.maxHeals ?? 1;
  // Cumul des tokens sur toutes les tentatives (self-heal inclus).
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (let attempt = 0; attempt <= maxHeals; attempt++) {
    let res;
    try {
      res = await callMessages({
        model: opts.model,
        system: opts.system,
        messages,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: 0,
        tools: [tool],
        tool_choice: { type: "tool", name: toolName },
        timeoutMs: opts.timeoutMs,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Fallback auto : limite Foundry sur les unions en mode strict
      if (tool.strict && /union|strict|anyOf/i.test(msg)) {
        tool.strict = false;
        attempt--;
        continue;
      }
      return { ok: false, error: msg };
    }

    if (res.usage) {
      usage.input_tokens += res.usage.input_tokens;
      usage.output_tokens += res.usage.output_tokens;
    }

    if (res.stop_reason === "max_tokens") {
      // Sortie tronquée : self-heal en demandant une sortie PLUS COURTE
      // (monter la limite ne suffit pas si le modèle est verbeux).
      if (attempt < maxHeals) {
        messages = [
          ...messages,
          { role: "assistant", content: [{ type: "text", text: "(sortie tronquée — limite de tokens atteinte)" }] },
          {
            role: "user",
            content:
              "Ta sortie a été TRONQUÉE (limite de tokens). Recommence via l'outil en BEAUCOUP plus concis : maximum 5 findings et 8 checks_passed, messages ≤ 200 caractères, evidence ≤ 120 caractères. Garde uniquement l'essentiel.",
          },
        ];
        continue;
      }
      return { ok: false, error: "Sortie tronquée (max_tokens)" };
    }

    const block = res.content.find(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
    );
    if (!block) {
      return { ok: false, error: "Pas de tool_use dans la réponse" };
    }

    const parsed = opts.schema.safeParse(block.input);
    if (parsed.success)
      return { ok: true, data: parsed.data, usage, attempts: attempt + 1, toolName };

    if (attempt < maxHeals) {
      // Self-heal : renvoyer les erreurs Zod précises au modèle.
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((i) => `- ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      messages = [
        ...messages,
        { role: "assistant", content: res.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: `Sortie invalide. Corrige exactement ces erreurs et rappelle ${toolName} :\n${issues}`,
            },
          ],
        },
      ];
      continue;
    }
    return {
      ok: false,
      error: `Validation échouée après retry: ${parsed.error.issues[0]?.message ?? "?"}`,
    };
  }
  return { ok: false, error: "unreachable" };
}

// Vérification anti-hallucination : le quote doit être un substring du source
// (normalisation espaces/nbsp). Quote introuvable → champ rétrogradé.
export function verifyQuote(quote: string | null, source: string): boolean {
  if (!quote) return false;
  const norm = (s: string) =>
    s.replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return norm(source).includes(norm(quote));
}
