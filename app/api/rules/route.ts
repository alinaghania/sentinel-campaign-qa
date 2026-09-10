// Configuration des règles éditée depuis /rules.
//
// GET  → catalogue figé (code) + écarts enregistrés + historique.
// PUT  → enregistre de NOUVEAUX écarts, avec verrou de version (409) pour ne
//        jamais écraser en silence la sauvegarde de quelqu'un d'autre :
//        l'accès à la plateforme est partagé (un seul mot de passe).

import { NextRequest, NextResponse } from "next/server";
import { Settings, updateSettings } from "@/lib/store";
import {
  HISTORY_MAX,
  RuleConfigWriteSchema,
  diffSummary,
  emptyRuleConfig,
  findPii,
  validateAgainstCatalog,
  type RuleConfig,
} from "@/lib/rule-config";
import { ALL_CATALOG } from "@/lib/rule-registry";

export const dynamic = "force-dynamic";

/** Entrées d'historique renvoyées d'emblée. Chacune embarque l'état COMPLET
 *  d'avant (overrides + règles custom) : à 50 versions × ~85 règles la réponse
 *  devenait le plus gros payload de l'app pour une liste que personne ne
 *  déroule. Le reste s'obtient avec ?history=all. */
const HISTORY_PAGE = 10;

export async function GET(req: NextRequest) {
  const cfg = (await Settings.get()) ?? emptyRuleConfig();
  const wantsAll = req.nextUrl.searchParams.get("history") === "all";
  return NextResponse.json({
    catalog: ALL_CATALOG,
    // Pas de `agentChoices` ici : la liste des agents proposables est importée
    // en dur par la page depuis lib/agent-catalog.ts (module sans dépendances,
    // donc franchissable côté client). La servir par le réseau ferait du
    // compilateur un spectateur — un agent retiré du catalogue laisserait un
    // <select> vide en production sans casser un seul typecheck. Importée, elle
    // casse `tsc` le jour même.
    overrides: cfg.overrides,
    customRules: cfg.customRules,
    // `?? []` : une config enregistrée avant l'existence des catégories n'a pas
    // le champ, et la page attend un tableau, pas `undefined`.
    customCategories: cfg.customCategories ?? [],
    version: cfg.version,
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
    history: wantsAll ? cfg.history : cfg.history.slice(0, HISTORY_PAGE),
    historyTotal: cfg.history.length,
  });
}

export async function PUT(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = RuleConfigWriteSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Some values are not valid.", details: parsed.error.issues.map((i) => i.message) },
      { status: 400 }
    );
  }
  const body = parsed.data;

  // Contrôles métier (bornes, règles protégées) + PII : vérifiés CÔTÉ SERVEUR,
  // un contrôle uniquement dans la page se contourne par un appel direct.
  //
  // Pas de 2e argument : validateAgainstCatalog lit par défaut AGENT_KEYS, du
  // même lib/agent-catalog.ts que la page importe pour peupler son formulaire.
  // Le serveur accepte donc exactement ce que l'écran propose, sans que rien ne
  // circule entre les deux. Le lui repasser d'ici ne ferait que rouvrir la
  // possibilité de passer autre chose que le référentiel.
  const errors = [
    ...validateAgainstCatalog(body),
    ...findPii(body.customRules, body.overrides),
  ];
  if (errors.length > 0) {
    return NextResponse.json({ error: errors[0], details: errors }, { status: 400 });
  }

  // Lecture → contrôle de version → écriture DANS LA MÊME chaîne sérialisée :
  // deux sauvegardes simultanées ne peuvent plus lire la même version et se
  // recouvrir (cf. updateSettings dans lib/store.ts).
  return updateSettings(async (stored) => {
    const prev = stored ?? emptyRuleConfig();
    if (body.version !== prev.version) {
      return NextResponse.json(
        {
          error:
            "Someone else saved changes while you were editing. Reload the page to see the latest rules, then re-apply your changes.",
          currentVersion: prev.version,
        },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const next: RuleConfig = {
      id: "default",
      overrides: body.overrides,
      customRules: body.customRules,
      customCategories: body.customCategories,
      version: prev.version + 1,
      updatedAt: now,
      updatedBy: body.updatedBy?.trim() || undefined,
      // L'historique garde l'état COMPLET d'avant : restaurer = réécrire cet
      // état, sans rejouer de diff (donc sans dérive possible).
      history: [
        {
          version: prev.version,
          at: prev.updatedAt,
          by: prev.updatedBy,
          summary: diffSummary(prev, body),
          // Le motif décrit le passage de prev à body : il est rangé avec
          // l'entrée qui porte le diff, pas avec l'état d'arrivée.
          reason: body.changeReason?.trim() || undefined,
          overrides: prev.overrides,
          customRules: prev.customRules,
          // Même raison que les deux champs au-dessus : restaurer une version
          // doit réécrire l'état COMPLET d'avant. Une catégorie absente de
          // l'entrée rendrait invisibles les règles qui s'y rattachent.
          customCategories: prev.customCategories ?? [],
        },
        ...prev.history,
      ].slice(0, HISTORY_MAX),
    };
    await Settings.put(next);

    return NextResponse.json({
      overrides: next.overrides,
      customRules: next.customRules,
      customCategories: next.customCategories,
      version: next.version,
      updatedAt: next.updatedAt,
      updatedBy: next.updatedBy,
      history: next.history.slice(0, HISTORY_PAGE),
      historyTotal: next.history.length,
    });
  });
}
