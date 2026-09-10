"use client";

// Page de configuration des règles vérifiées par les agents.
//
// Public visé : une personne FONCTIONNELLE (pas développeuse). Conséquences
// assumées sur l'UI :
//  - chaque règle est décrite en clair, jamais par son identifiant technique ;
//  - UNE SEULE liste plate mélange les règles du catalogue et celles écrites à
//    la main : pour la personne qui lit, ce sont les mêmes objets, seule leur
//    origine diffère — et cette origine ne l'intéresse pas ;
//  - la SÉVÉRITÉ n'est jamais affichée. Elle existe toujours dans le modèle et
//    la page la TRANSPORTE telle quelle, mais demander « critique ou majeur ? »
//    à quelqu'un qui veut juste couper un contrôle est une question sans
//    réponse honnête. Aucun `SEVERITY_LABELS` ici, c'est délibéré ;
//  - une règle qu'on ne PEUT pas modifier le dit et explique pourquoi, plutôt
//    que d'être absente (sinon on la croit oubliée) ;
//  - "Save" ne part que si quelque chose a changé, et l'écran dit toujours si
//    ce qui est affiché est enregistré ou non.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Lock,
  Plus,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
// ⚠️ Tout ce que cette page importe en VALEUR doit venir de `rule-catalog` ou
// de `agent-catalog`, les deux seuls modules de la famille qui ne dépendent
// d'AUCUNE API Node. `lib/rule-config.ts` (crypto, process.env) et
// `lib/agents.ts` (fs, path via ./store ; clé API via ./foundry) ne sont
// importables qu'en `import type` : une valeur importée depuis l'un des deux
// casserait le build client — et pas au typecheck, seulement au `next build`,
// donc bien plus tard.
import {
  CUSTOM_CATEGORY_LABEL_MAX,
  CUSTOM_CATEGORY_MAX,
  CUSTOM_RULE_MAX,
  CUSTOM_RULE_MAX_CHARS,
  CUSTOM_RULE_TITLE_MAX,
  FAMILY_LABELS,
  FAMILY_ORDER,
  RULE_EXAMPLES_MAX,
  RULE_EXAMPLE_MAX_CHARS,
  RULE_LABEL_MAX,
  RULE_DESCRIPTION_MAX,
  effectiveDescription,
  effectiveLabel,
  type RuleCatalogEntry,
  type RuleFamily,
} from "@/lib/rule-catalog";
// SOURCE UNIQUE de la liste d'agents, importée et jamais recopiée ni servie :
// le module ne dépend de rien, donc il franchit la frontière client, et le
// COMPILATEUR devient le filet — un agent retiré du catalogue casse ce fichier
// tout de suite. La même liste passée par le réseau ne casserait rien et
// laisserait un <select> vide en production.
import { AGENT_CHOICES } from "@/lib/agent-catalog";
import type {
  CustomCategory,
  CustomRule,
  ParamValue,
  RuleConfigHistoryEntry,
  RuleExample,
  RuleOverride,
} from "@/lib/rule-config";

interface RulesPayload {
  catalog: RuleCatalogEntry[];
  overrides: Record<string, RuleOverride>;
  customRules: CustomRule[];
  customCategories: CustomCategory[];
  version: number;
  updatedAt: string;
  updatedBy?: string;
  history: RuleConfigHistoryEntry[];
  /** Nombre total de versions conservées — l'API n'en renvoie que les 10
   *  premières, l'écran doit pouvoir dire qu'il en existe d'autres. */
  historyTotal?: number;
}

/** Les versions d'historique écrites avant l'existence des catégories n'en
 *  portent pas : `?? []` à la restauration plutôt qu'une entrée ignorée. */
type HistoryEntry = RuleConfigHistoryEntry & { customCategories?: CustomCategory[] };

/** Catégorie de repli d'une règle écrite à la main dont la catégorie est
 *  supprimée. "brand" existe toujours (famille du catalogue) : une règle sans
 *  catégorie valide disparaîtrait de toutes les pills et deviendrait
 *  introuvable. */
const FALLBACK_CATEGORY = "brand";

/** Ce que cet écran affirme du routage — vérifié dans le code, pas déduit de
 *  l'intention. Adressé par SYMBOLE et non par numéro de ligne : une adresse en
 *  ligne est une affirmation sur un fichier qu'un autre édite, elle pourrit sans
 *  que rien ne rougisse (les quatre d'avant avaient toutes bougé en un jour).
 *  Le moteur lit `CustomRule.agent`, et LUI SEUL :
 *    lib/analyze.ts, `extraRules:`     n'envoie à <editorial_rules> de l'agent
 *                                      guidelines que les règles retenues par
 *                                      `isGuidelinesRule` ;
 *    lib/rule-config.ts, `isGuidelinesRule`  ce prédicat : `agent ?? défaut`
 *                                      vaut la clé guidelines ;
 *    lib/agents.ts, `customRulesForAgent`    rend à tout AUTRE agent les règles
 *                                      dont `agent === sa clé` ;
 *    lib/agents.ts, `customRulesBlock`       elles entrent dans son bloc
 *                                      RÈGLES À VÉRIFIER + <custom_rules> ;
 *    lib/agent-catalog.ts, `GUIDELINES_AGENT_KEY`  le défaut quand le champ est
 *                                      absent (agents.ts le ré-exporte).
 *  La CATÉGORIE, elle, ne route rien : aucune lecture de `r.category` dans
 *  lib/analyze.ts ni lib/agents.ts — elle ne sert qu'à ranger et à filtrer ici.
 *  Ces deux phrases sont donc l'exact contraire l'une de l'autre, et c'est
 *  voulu : dire « la catégorie choisit l'agent » ferait croire à un réglage qui
 *  n'existe pas, et un réglage muet (règle écrite, cochée On, jamais vérifiée)
 *  est le pire défaut possible sur cette page — il ne se voit nulle part. */
const ROUTING_NOTE =
  "Categories only sort your rules. Open a rule to choose which agent checks it — until you do, it goes to the guidelines agent.";

/** Affichée sous le sélecteur : ce que fait le champ laissé vide. Séparée de
 *  ROUTING_NOTE pour ne pas répéter la phrase de tri dans chaque règle. */
const DEFAULT_AGENT_NOTE = "Left empty, the rule goes to the guidelines agent.";

/** key → libellé, DÉRIVÉ d'AGENT_CHOICES et jamais recopié : un agent renommé
 *  dans le catalogue l'est ici le même jour. Une clé ABSENTE rend `undefined`,
 *  et c'est un cas RÉEL malgré l'import : une règle enregistrée hier peut
 *  porter un agent retiré du catalogue depuis. L'écran le dit alors, au lieu
 *  d'inventer un nom ou de laisser croire qu'aucun agent n'est choisi. */
const AGENT_LABELS: Record<string, string> = Object.fromEntries(
  AGENT_CHOICES.map((choice) => [choice.key, choice.label])
);

/** Identifiant local d'une règle écrite à la main. Le compteur évite la
 *  collision de deux ajouts dans la même milliseconde (clic répété rapide). */
let customRuleSeq = 0;
function newCustomRuleId() {
  return `r${Date.now().toString(36)}${(customRuleSeq++).toString(36)}`;
}

/** Minuscules + accents retirés : « Cohérence » doit se trouver en tapant
 *  "coherence", sinon la recherche punit qui ne connaît pas l'orthographe
 *  exacte du libellé. */
function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Un id de catégorie est un CONTRAT stocké dans la config : il doit rester
 *  lisible et stable, d'où le slug plutôt qu'un identifiant aléatoire. */
function slugify(label: string) {
  return normalize(label)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Une ligne de la liste plate. Construite SANS la recherche pour que taper
 *  dans le champ ne reconstruise pas les objets stables passés aux lignes. */
type RuleItem =
  | {
      kind: "catalog";
      id: string;
      category: string;
      categoryLabel: string;
      haystack: string;
      /** Identité stable (vient du tableau `catalog`) : c'est ce qui permet au
       *  memo de RuleRow de tenir. */
      entry: RuleCatalogEntry;
      removed: boolean;
    }
  | {
      kind: "custom";
      id: string;
      category: string;
      categoryLabel: string;
      haystack: string;
      rule: CustomRule;
      removed: false;
    };

export default function RulesPage() {
  const [data, setData] = useState<RulesPayload | null>(null);
  const [overrides, setOverrides] = useState<Record<string, RuleOverride>>({});
  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [customCategories, setCustomCategories] = useState<CustomCategory[]>([]);
  const [author, setAuthor] = useState("");
  // Motif de la sauvegarde : UN motif par enregistrement, pas un par règle.
  // Exiger une justification règle par règle empêcherait toute sauvegarde tant
  // que les écarts déjà en place n'auraient pas été justifiés rétroactivement.
  const [changeReason, setChangeReason] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // --- état de l'écran (jamais envoyé au serveur) ---------------------------
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCategory, setDraftCategory] = useState<string>("brief");
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  // "Show all" démasque ce qui est habituellement du bruit : les règles
  // supprimées (restaurables) et celles qu'on ne peut pas éditer. Les cacher
  // par DÉFAUT et non les supprimer : une règle absente est crue oubliée.
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const loadSeq = useRef(0);

  async function load() {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch("/api/rules");
      if (!res.ok) throw new Error();
      const payload: RulesPayload = await res.json();
      if (seq !== loadSeq.current) return;
      setData(payload);
      setOverrides(payload.overrides);
      setCustomRules(payload.customRules);
      setCustomCategories(payload.customCategories ?? []);
      setLoadError(null);
    } catch {
      if (seq === loadSeq.current) setLoadError("Could not load the rules. Reload the page.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const dirty = useMemo(() => {
    if (!data) return false;
    return (
      JSON.stringify(overrides) !== JSON.stringify(data.overrides) ||
      JSON.stringify(customRules) !== JSON.stringify(data.customRules) ||
      JSON.stringify(customCategories) !== JSON.stringify(data.customCategories ?? [])
    );
  }, [data, overrides, customRules, customCategories]);

  // Avertissement navigateur : la config n'est PAS auto-sauvegardée, et une
  // demi-heure de réglages perdue au refresh serait inacceptable.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  // useCallback + updater fonctionnel : ces handlers ne changent JAMAIS
  // d'identité, sans quoi le memo des lignes ne servirait à rien (une nouvelle
  // fonction à chaque rendu = les 85+ lignes se réaffichent à chaque frappe,
  // y compris à chaque caractère tapé dans la recherche).
  const patch = useCallback((ruleId: string, change: Partial<RuleOverride>) => {
    setOverrides((prev) => {
      const next = { ...prev, [ruleId]: { ...prev[ruleId], ...change } };
      // Un override vide est retiré : on ne stocke que de VRAIS écarts, sinon
      // "Restore defaults" laisserait des coquilles derrière lui. TOUS les
      // champs sont testés — en oublier un (ex. `category`) suffit à laisser un
      // objet vide en base après un aller-retour.
      const o = next[ruleId];
      if (
        o.enabled === undefined &&
        o.severity === undefined &&
        o.params === undefined &&
        o.category === undefined &&
        o.removed === undefined &&
        o.examples === undefined &&
        o.label === undefined &&
        o.description === undefined
      ) {
        delete next[ruleId];
      }
      return next;
    });
  }, []);

  const patchParam = useCallback((ruleId: string, key: string, value: ParamValue) => {
    setOverrides((prev) => ({
      ...prev,
      [ruleId]: { ...prev[ruleId], params: { ...prev[ruleId]?.params, [key]: value } },
    }));
  }, []);

  const handleToggle = useCallback(
    (ruleId: string, enabled: boolean) => patch(ruleId, { enabled }),
    [patch]
  );

  // Supprimer une règle du CATALOGUE ne l'efface pas (le code la porte
  // toujours) : on l'éteint ET on la masque. Le seul écart possible est donc
  // un écart, pas une amputation — et il se défait.
  const handleDelete = useCallback(
    (ruleId: string) => patch(ruleId, { removed: true, enabled: false }),
    [patch]
  );

  // Restaurer = revenir au DÉFAUT du code, pas à l'état d'avant la suppression :
  // conserver `enabled: false` ferait réapparaître une règle éteinte, donc une
  // ligne restaurée qui ne vérifie toujours rien.
  const handleRestore = useCallback(
    (ruleId: string) => patch(ruleId, { removed: undefined, enabled: undefined }),
    [patch]
  );

  // La ligne fournit sa catégorie d'ORIGINE : le handler reste ainsi sans
  // dépendance (donc d'identité stable) alors qu'il doit savoir quand effacer
  // l'override au lieu d'enregistrer une recatégorisation qui n'en est pas une.
  const handleCategory = useCallback(
    (ruleId: string, category: string, defaultCategory: string) =>
      patch(ruleId, { category: category === defaultCategory ? undefined : category }),
    [patch]
  );

  const handleExamples = useCallback(
    (ruleId: string, examples: RuleExample[]) =>
      patch(ruleId, { examples: examples.length > 0 ? examples : undefined }),
    [patch]
  );

  // Réécriture de l'intitulé d'une règle du CATALOGUE. Le code garde la
  // mécanique de détection, le métier possède le texte affiché.
  // La ligne fournit le texte d'ORIGINE (même astuce que pour la catégorie :
  // le handler reste sans dépendance, donc d'identité stable) : retaper
  // exactement le texte du code, ou vider le champ, EFFACE l'écart au lieu
  // d'enregistrer une réécriture qui n'en est pas une. Sans ça, "Reset to
  // default text" resterait affiché sur une règle revenue à son texte d'origine.
  const handleText = useCallback(
    (ruleId: string, field: "label" | "description", value: string, original: string) => {
      const next = value.trim() === "" || value === original ? undefined : value;
      patch(ruleId, field === "label" ? { label: next } : { description: next });
    },
    [patch]
  );

  const handleResetText = useCallback(
    (ruleId: string) => patch(ruleId, { label: undefined, description: undefined }),
    [patch]
  );

  const handleCustomChange = useCallback((ruleId: string, change: Partial<CustomRule>) => {
    // `map` avec retour à l'identique pour les autres : leur identité d'objet
    // est préservée, donc leur ligne mémoïsée ne se réaffiche pas.
    setCustomRules((prev) => prev.map((r) => (r.id === ruleId ? { ...r, ...change } : r)));
  }, []);

  // Une règle écrite à la main n'existe que dans la config : la supprimer, c'est
  // vraiment la supprimer (rien dans le code ne la rejouerait).
  const handleCustomDelete = useCallback((ruleId: string) => {
    setCustomRules((prev) => prev.filter((r) => r.id !== ruleId));
  }, []);

  const handleToggleExpand = useCallback((ruleId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  }, []);

  async function save() {
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          overrides,
          customRules,
          customCategories,
          version: data.version,
          updatedBy: author.trim() || undefined,
          changeReason: changeReason.trim() || undefined,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setSaveError(payload.details?.length ? payload.details : [payload.error ?? "Save failed."]);
        return;
      }
      setData({ ...data, ...payload });
      setOverrides(payload.overrides);
      setCustomRules(payload.customRules);
      setCustomCategories(payload.customCategories ?? []);
      setChangeReason("");
      setSavedAt(new Date().toLocaleTimeString());
    } catch {
      setSaveError(["Could not reach the server. Check your connection and try again."]);
    } finally {
      setSaving(false);
    }
  }

  function restoreDefaults() {
    setOverrides({});
    setCustomRules([]);
    setCustomCategories([]);
    setSelectedCategory(null);
  }

  /** Retire les SEULS écarts orphelins, et rien d'autre.
   *
   *  Le bandeau des orphelins renvoyait vers `restoreDefaults`, qui vide aussi
   *  `customRules`, `customCategories` et TOUS les autres écarts. Le texte
   *  disait vrai du système (« nothing is broken ») et faux de la manœuvre
   *  qu'il conseillait : quelqu'un venu effacer une coquille cosmétique y
   *  perdait ses règles écrites à la main. Et comme ce bandeau n'apparaît que
   *  sur une config qui a de l'historique, son lecteur est exactement celui qui
   *  a le plus à perdre.
   *
   *  Le remède est donc dérivé de `orphans` et non d'une liste recopiée : ce
   *  qui disparaît est ce que le bandeau vient de compter, jamais autre chose. */
  function clearOrphans(ids: string[]) {
    setOverrides((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }

  function restoreVersion(entry: HistoryEntry) {
    setOverrides(entry.overrides);
    setCustomRules(entry.customRules);
    setCustomCategories(entry.customCategories ?? []);
    setSelectedCategory(null);
  }

  // Mémoïsé : `data?.catalog ?? []` rendrait un NOUVEAU tableau à chaque rendu,
  // et toutes les listes dérivées (donc la liste plate de 85+ lignes) seraient
  // reconstruites à chaque frappe dans la recherche.
  const catalog = useMemo(() => data?.catalog ?? [], [data]);

  // Les catégories proposables, séparées par NATURE : celles qui viennent du
  // code (les familles du catalogue) et celles créées ici. La distinction est
  // réelle — on peut supprimer les secondes, pas les premières — et elle est
  // rendue par deux <optgroup>. Une seule référence d'objet, partagée par
  // toutes les lignes : un objet reconstruit à chaque rendu casserait leur memo.
  const categoryGroups = useMemo(
    () => ({
      catalog: FAMILY_ORDER.map((f) => ({ id: f as string, label: FAMILY_LABELS[f] })),
      custom: customCategories.map((c) => ({ id: c.id, label: c.label })),
    }),
    [customCategories]
  );

  const categoryOptions = useMemo(
    () => [...categoryGroups.catalog, ...categoryGroups.custom],
    [categoryGroups]
  );

  /** Une catégorie créée ici range, elle ne route pas : rien dans le moteur ne
   *  lit `CustomRule.category` pour choisir un agent. Sert à afficher la bonne
   *  phrase sous le formulaire — voir le commentaire de `ROUTING_NOTE`. */
  const draftIsCustomCategory = customCategories.some((c) => c.id === draftCategory);

  const categoryLabelOf = useCallback(
    (id: string) =>
      FAMILY_LABELS[id as RuleFamily] ??
      customCategories.find((c) => c.id === id)?.label ??
      id,
    [customCategories]
  );

  /** Rang d'affichage d'une catégorie : familles dans l'ordre métier, puis les
   *  catégories créées à la main dans leur ordre de création. */
  const categoryRank = useCallback(
    (id: string) => {
      const familyIndex = FAMILY_ORDER.indexOf(id as RuleFamily);
      if (familyIndex >= 0) return familyIndex;
      const customIndex = customCategories.findIndex((c) => c.id === id);
      return customIndex >= 0 ? FAMILY_ORDER.length + customIndex : Number.MAX_SAFE_INTEGER;
    },
    [customCategories]
  );

  // Liste plate, catalogue et règles écrites à la main mélangés, regroupée par
  // catégorie. Ne dépend PAS de `search` : les objets passés aux lignes gardent
  // leur identité pendant qu'on tape.
  const items = useMemo(() => {
    const list: RuleItem[] = [];
    for (const entry of catalog) {
      const o = overrides[entry.id];
      const category = o?.category ?? entry.family;
      const categoryLabel = categoryLabelOf(category);
      list.push({
        kind: "catalog",
        id: entry.id,
        category,
        categoryLabel,
        // Recherche sur le texte EFFECTIF : un intitulé réécrit par le métier
        // doit se retrouver en tapant ce QU'IL a écrit. Chercher un titre qu'on
        // a soi-même saisi et ne pas le trouver ferait croire à sa disparition.
        haystack: normalize(
          `${effectiveLabel(entry, o)} ${effectiveDescription(entry, o)} ${categoryLabel}`
        ),
        entry,
        removed: o?.removed === true,
      });
    }
    for (const rule of customRules) {
      const categoryLabel = categoryLabelOf(rule.category);
      list.push({
        kind: "custom",
        id: rule.id,
        category: rule.category,
        categoryLabel,
        // Le libellé de l'agent est CHERCHABLE parce qu'il est AFFICHÉ sous le
        // titre : une recherche qui ignore un texte visible à l'écran passe
        // pour cassée. Le LIBELLÉ et pas la clé brute — et une clé absente de
        // la liste servie n'apparie rien, faute de texte affiché à apparier.
        haystack: normalize(
          `${rule.title} ${rule.instruction} ${categoryLabel} ${
            (rule.agent && AGENT_LABELS[rule.agent]) || ""
          }`
        ),
        rule,
        removed: false,
      });
    }
    // `sort` est stable en JS : l'ordre du catalogue est conservé à l'intérieur
    // d'une catégorie, et les règles écrites à la main arrivent après.
    return list.sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
  }, [catalog, overrides, customRules, categoryLabelOf, categoryRank]);

  /** Ce qui est affichable avant recherche et avant filtre de catégorie. Une
   *  règle supprimée ou non éditable n'apparaît qu'en mode "Show all". */
  const displayable = useMemo(
    () =>
      items.filter((item) => {
        if (showAll) return true;
        if (item.removed) return false;
        if (item.kind === "catalog" && item.entry.readOnly) return false;
        return true;
      }),
    [items, showAll]
  );

  const searched = useMemo(() => {
    const q = normalize(search.trim());
    if (!q) return displayable;
    return displayable.filter((item) => item.haystack.includes(q));
  }, [displayable, search]);

  const visible = useMemo(
    () => (selectedCategory ? searched.filter((i) => i.category === selectedCategory) : searched),
    [searched, selectedCategory]
  );

  /** Pills : une par catégorie qui contient au moins une règle affichée, plus
   *  les catégories créées à la main même vides — sinon une catégorie créée par
   *  erreur ne serait plus jamais supprimable. */
  const pills = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of searched) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    for (const c of customCategories) if (!counts.has(c.id)) counts.set(c.id, 0);
    return [...counts.entries()]
      .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]))
      .map(([id, count]) => ({
        id,
        count,
        label: categoryLabelOf(id),
        custom: customCategories.some((c) => c.id === id),
      }));
  }, [searched, customCategories, categoryRank, categoryLabelOf]);

  // Écarts pointant vers une règle disparue du code : signalés plutôt que
  // supprimés en douce (ils redeviennent actifs si la règle revient).
  const orphans = useMemo(
    () => Object.keys(overrides).filter((id) => !catalog.some((r) => r.id === id)),
    [overrides, catalog]
  );

  // Combien de contrôles sont actuellement ÉTEINTS, tel qu'affiché à l'écran.
  // Sans ce compteur, une règle coupée il y a six mois par quelqu'un d'autre
  // reste invisible : il faudrait la retrouver à la main dans 85 lignes.
  // Les règles supprimées en sont exclues : elles ont leur propre bandeau, les
  // compter deux fois ferait croire à deux problèmes distincts.
  const disabledRules = useMemo(
    () =>
      catalog.filter(
        (r) =>
          !r.protected &&
          !r.readOnly &&
          overrides[r.id]?.removed !== true &&
          (overrides[r.id]?.enabled ?? !r.extendedOnly) === false
      ),
    [catalog, overrides]
  );

  const removedCount = useMemo(
    () => catalog.filter((r) => overrides[r.id]?.removed === true).length,
    [catalog, overrides]
  );

  const changedCount = useMemo(() => {
    if (!data) return 0;
    let n = 0;
    const ids = new Set([...Object.keys(overrides), ...Object.keys(data.overrides)]);
    for (const id of ids) {
      if (JSON.stringify(overrides[id] ?? null) !== JSON.stringify(data.overrides[id] ?? null)) n++;
    }
    // Les règles écrites à la main comptent comme des changements au même
    // titre : un compteur qui n'en tiendrait pas compte dirait "0 change" sur
    // une page manifestement modifiée.
    const savedCustom = new Map(data.customRules.map((r) => [r.id, JSON.stringify(r)]));
    for (const r of customRules) {
      if (savedCustom.get(r.id) !== JSON.stringify(r)) n++;
      savedCustom.delete(r.id);
    }
    n += savedCustom.size;
    if (JSON.stringify(customCategories) !== JSON.stringify(data.customCategories ?? [])) n++;
    return n;
  }, [data, overrides, customRules, customCategories]);

  const atRuleLimit = customRules.length >= CUSTOM_RULE_MAX;
  const canAddRule = draftTitle.trim().length > 0 && !atRuleLimit;

  function addRule() {
    const title = draftTitle.trim();
    if (!title || atRuleLimit) return;
    setCustomRules((prev) => [
      ...prev,
      {
        id: newCustomRuleId(),
        title,
        instruction: "",
        category: draftCategory,
        examples: [],
        // La sévérité n'est PAS demandée : elle existe dans le modèle, on pose
        // la valeur médiane et l'écran n'en parle jamais.
        severity: "MAJEUR",
        enabled: true,
      },
    ]);
    setDraftTitle("");
  }

  function addCategory() {
    const label = newCategoryLabel.trim().slice(0, CUSTOM_CATEGORY_LABEL_MAX);
    if (!label) {
      setCategoryError("Give the category a name.");
      return;
    }
    if (customCategories.length >= CUSTOM_CATEGORY_MAX) {
      setCategoryError(`You already have ${CUSTOM_CATEGORY_MAX} categories — delete one first.`);
      return;
    }
    const id = slugify(label);
    if (!id) {
      setCategoryError("Use at least one letter or digit.");
      return;
    }
    // Doublon d'id ET doublon de libellé : deux pills au même nom sont
    // indiscernables à l'écran, même si leurs ids diffèrent.
    if (categoryOptions.some((c) => c.id === id)) {
      setCategoryError("That category already exists.");
      return;
    }
    if (categoryOptions.some((c) => normalize(c.label) === normalize(label))) {
      setCategoryError("Another category already uses that name.");
      return;
    }
    setCustomCategories((prev) => [...prev, { id, label }]);
    setNewCategoryLabel("");
    setCategoryError(null);
    setAddingCategory(false);
  }

  /** Supprimer une catégorie ne supprime aucune règle : chacune retombe sur sa
   *  catégorie d'origine (celle du code pour le catalogue, "Brand rules" pour
   *  une règle écrite à la main, dont l'origine n'existe pas). */
  function deleteCategory(id: string) {
    setOverrides((prev) => {
      const next = { ...prev };
      for (const [ruleId, o] of Object.entries(next)) {
        if (o.category !== id) continue;
        const cleaned: RuleOverride = { ...o, category: undefined };
        if (
          cleaned.enabled === undefined &&
          cleaned.severity === undefined &&
          cleaned.params === undefined &&
          cleaned.removed === undefined &&
          cleaned.examples === undefined &&
          cleaned.label === undefined &&
          cleaned.description === undefined
        ) {
          delete next[ruleId];
        } else {
          next[ruleId] = cleaned;
        }
      }
      return next;
    });
    setCustomRules((prev) =>
      prev.map((r) => (r.category === id ? { ...r, category: FALLBACK_CATEGORY } : r))
    );
    setCustomCategories((prev) => prev.filter((c) => c.id !== id));
    if (selectedCategory === id) setSelectedCategory(null);
    if (draftCategory === id) setDraftCategory("brief");
  }

  const filtering = search.trim().length > 0 || selectedCategory !== null;

  return (
    <div className="space-y-8 pb-32">
      <div className="border-b-2 border-fg pb-5">
        <h1 className="doc-title text-[34px]">Rules</h1>
        <p className="mt-1 max-w-3xl text-[12.5px] text-dim">
          What the agents check on every email. Turn one off, delete it, or add your own.
        </p>
      </div>

      {/* `border-fg` distingue le bandeau d'erreur d'une carte ordinaire. */}
      {loadError && (
        <p className="card border-fg p-4 text-[13px]">{loadError}</p>
      )}

      {/* --- 1. Ajouter une règle ------------------------------------------- */}
      <section>
        <h2 className="doc-section text-[15px]">Add a rule</h2>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="w-[190px]">
            <select
              className="input"
              aria-label="Category of the new rule"
              value={draftCategory}
              onChange={(e) => setDraftCategory(e.target.value)}
            >
              <CategoryOptionGroups groups={categoryGroups} />
            </select>
          </div>
          {/* Les largeurs vivent sur un conteneur : .input impose width:100% et
              l'emporterait sur une utilitaire Tailwind. */}
          <div className="min-w-[240px] flex-1">
            <input
              className="input"
              aria-label="What the rule says"
              placeholder="e.g. Promo code must be present"
              // Même borne que le schéma d'écriture (CUSTOM_RULE_TITLE_MAX,
              // lib/rule-catalog.ts) : une valeur plus large ici ferait saisir
              // un titre que Save refuserait ensuite en bloc, sans dire lequel.
              // Ne pas y remettre un littéral — c'est l'import qui garantit que
              // l'écran et le serveur coupent au même endroit.
              maxLength={CUSTOM_RULE_TITLE_MAX}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRule();
                }
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-accent"
            onClick={addRule}
            disabled={!canAddRule}
            title={
              atRuleLimit
                ? `Limit reached (${CUSTOM_RULE_MAX} rules) — delete one to add another.`
                : undefined
            }
          >
            <Plus size={15} /> Add rule
          </button>
        </div>
        {/* Ce que la catégorie fait — et ce qu'elle ne fait PAS. Sans cette
            phrase, choisir "Translation" laisse croire que la règle part chez
            l'agent de traduction : rien dans le moteur ne lit
            `CustomRule.category` pour router, c'est `CustomRule.agent` qui
            décide (sélecteur « Checked by » dans la règle dépliée). */}
        <p className="mt-2 max-w-3xl text-[11.5px] text-dim">
          {draftIsCustomCategory
            ? "“Your categories” are yours to organise with — they group rules, nothing more. "
            : "Built-in categories also hold the checks that ship with the app. "}
          {ROUTING_NOTE}
        </p>
        <p className="mt-1 max-w-3xl text-[11.5px] text-dim">
          {atRuleLimit
            ? `Limit reached (${CUSTOM_RULE_MAX} rules of your own) — delete one to add another. `
            : ""}
          Your own rules are read by an AI agent: write them in English, expect the occasional miss
          or false alarm, and never put personal data (names, emails, phone numbers) in them.
        </p>
      </section>

      {/* --- 2. Catégories -------------------------------------------------- */}
      <section className="border-y border-bd py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">Categories</h2>
            <p className="mt-[2px] text-[12.5px] text-dim">Organize your rules however you want.</p>
          </div>
          {addingCategory ? (
            <div className="flex items-center gap-2">
              <div className="w-[200px]">
                <input
                  className="input"
                  aria-label="New category name"
                  placeholder="e.g. Legal"
                  autoFocus
                  maxLength={CUSTOM_CATEGORY_LABEL_MAX}
                  value={newCategoryLabel}
                  onChange={(e) => {
                    setNewCategoryLabel(e.target.value);
                    setCategoryError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCategory();
                    }
                    if (e.key === "Escape") {
                      setAddingCategory(false);
                      setCategoryError(null);
                    }
                  }}
                />
              </div>
              <button type="button" className="btn btn-accent" onClick={addCategory}>
                Add
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setAddingCategory(false);
                  setCategoryError(null);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => setAddingCategory(true)}
              disabled={customCategories.length >= CUSTOM_CATEGORY_MAX}
              title={
                customCategories.length >= CUSTOM_CATEGORY_MAX
                  ? `You already have ${CUSTOM_CATEGORY_MAX} categories — delete one first.`
                  : undefined
              }
            >
              <Plus size={15} /> Add category
            </button>
          )}
        </div>
        {categoryError && <p className="mt-2 text-[12px]">{categoryError}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={selectedCategory === null}
            onClick={() => setSelectedCategory(null)}
            className={`rounded-full border px-3 py-1 text-[12px] ${
              selectedCategory === null ? "border-fg bg-fg text-white" : "border-bd text-dim"
            }`}
          >
            All {searched.length}
          </button>
          {pills.map((pill) => {
            const active = selectedCategory === pill.id;
            return (
              <span
                key={pill.id}
                className={`inline-flex items-center rounded-full border ${
                  active ? "border-fg bg-fg text-white" : "border-bd text-dim"
                }`}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedCategory(active ? null : pill.id)}
                  className="px-3 py-1 text-[12px]"
                >
                  {pill.label} {pill.count}
                </button>
                {pill.custom && (
                  <button
                    type="button"
                    aria-label={`Delete the category ${pill.label}`}
                    title="Delete this category — its rules go back to their original category."
                    onClick={() => deleteCategory(pill.id)}
                    className="pr-2 pl-[2px]"
                  >
                    <X size={12} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </section>

      {/* --- Bandeaux d'alerte ---------------------------------------------- */}
      {orphans.length > 0 && (
        <p className="flex items-start gap-2 text-[12px] text-dim">
          <AlertTriangle size={14} className="mt-[2px] shrink-0" />
          <span>
            {orphans.length} saved setting{orphans.length > 1 ? "s refer" : " refers"} to a check
            that no longer exists in the app. Nothing is broken:{" "}
            {orphans.length > 1 ? "they are" : "it is"} kept, never applied, and{" "}
            {orphans.length > 1 ? "come" : "comes"} back if the check returns.{" "}
            {/* Le bouton retire ces clés-là et rien d'autre — voir clearOrphans.
                Il dit ce qu'il enlève et combien, parce que le geste ne se
                relit pas : une fois la clé partie, plus rien ne la nomme. */}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-fg"
              onClick={() => clearOrphans(orphans)}
              disabled={saving}
              aria-label={`Remove ${orphans.length} orphaned setting${
                orphans.length > 1 ? "s" : ""
              } and nothing else`}
            >
              Remove {orphans.length > 1 ? "them" : "it"}
            </button>{" "}
            to tidy up (nothing else is touched; save to confirm).
          </span>
        </p>
      )}

      {disabledRules.length > 0 && (
        <p className="flex items-start gap-2 text-[12px] text-dim">
          <AlertTriangle size={14} className="mt-[2px] shrink-0" />
          <span>
            {/* "off" et non "turned off" : certaines sont éteintes par défaut,
                pas par décision de quelqu'un. Le fait qui compte est le même. */}
            <strong className="text-fg">
              {disabledRules.length} check{disabledRules.length > 1 ? "s are" : " is"} off
            </strong>{" "}
            {/* Intitulé EFFECTIF : citer le texte du code alors que le métier
                l'a réécrit désignerait une règle qu'il ne reconnaît plus. */}
            — {disabledRules.map((r) => effectiveLabel(r, overrides[r.id])).join(" · ")}. Nothing
            they would catch appears in
            any report.
          </span>
        </p>
      )}

      {removedCount > 0 && !showAll && (
        <p className="flex items-start gap-2 text-[12px] text-dim">
          <AlertTriangle size={14} className="mt-[2px] shrink-0" />
          <span>
            {removedCount} rule{removedCount > 1 ? "s" : ""} deleted — Show all to restore.
          </span>
        </p>
      )}

      {/* --- 3. Recherche + 4. Liste ---------------------------------------- */}
      <section>
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dim"
          />
          <input
            // `pl-9` dégage la place de la loupe, qui sinon se pose sur le
            // premier caractère du placeholder.
            className="input pl-9"
            type="search"
            aria-label="Search rules"
            placeholder="Search rules…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="mt-6 flex items-baseline justify-between gap-4">
          <h2 className="doc-section flex-1 text-[15px]">Your rules</h2>
          <button
            type="button"
            className="shrink-0 text-[12px] underline underline-offset-2"
            aria-pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show fewer" : "Show all"}
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="mt-6 text-[12.5px] text-dim">
            {items.length === 0 ? (
              <p>{data ? "No rule yet — add your first one above." : "Loading…"}</p>
            ) : (
              <p>
                {/* Le compte annoncé est celui des règles que le FILTRE écarte,
                    pas le total : dire "85 hidden" alors que "Show all" en
                    masque déjà une partie enverrait chercher un problème
                    ailleurs. */}
                No rule matches. {displayable.length} rule
                {displayable.length > 1 ? "s are" : " is"} hidden by your search
                {selectedCategory ? " and category filter" : ""}
                {items.length > displayable.length
                  ? `, and ${items.length - displayable.length} more by “Show all”`
                  : ""}
                .{" "}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => {
                    setSearch("");
                    setSelectedCategory(null);
                  }}
                >
                  Clear filters
                </button>
              </p>
            )}
          </div>
        ) : (
          <div className="mt-2 divide-y divide-bd border-t border-bd">
            {visible.map((item) =>
              item.kind === "catalog" ? (
                <CatalogRuleRow
                  key={item.id}
                  entry={item.entry}
                  override={overrides[item.id]}
                  categoryLabel={item.categoryLabel}
                  groups={categoryGroups}
                  expanded={expanded.has(item.id)}
                  onExpand={handleToggleExpand}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onRestore={handleRestore}
                  onCategory={handleCategory}
                  onExamples={handleExamples}
                  onParam={patchParam}
                  onText={handleText}
                  onResetText={handleResetText}
                />
              ) : (
                <CustomRuleRow
                  key={item.id}
                  rule={item.rule}
                  categoryLabel={item.categoryLabel}
                  groups={categoryGroups}
                  expanded={expanded.has(item.id)}
                  onExpand={handleToggleExpand}
                  onChange={handleCustomChange}
                  onDelete={handleCustomDelete}
                />
              )
            )}
          </div>
        )}

        {filtering && visible.length > 0 && visible.length < displayable.length && (
          <p className="mt-3 text-[11.5px] text-dim">
            Showing {visible.length} of {displayable.length} rules.{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setSearch("");
                setSelectedCategory(null);
              }}
            >
              Clear filters
            </button>
          </p>
        )}
      </section>

      {/* --- Historique ----------------------------------------------------- */}
      {data && data.history.length > 0 && (
        <section className="card p-5">
          <h2 className="doc-section text-[15px]">Change history</h2>
          <p className="mt-1 text-[12.5px] text-dim">
            Restoring loads that version into the page — review it, then press Save to apply.
          </p>
          <ul className="mt-4 divide-y divide-bd">
            {data.history.map((entry) => (
              <li key={entry.version} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px]">{entry.summary}</p>
                  {entry.reason && <p className="mt-[2px] text-[12px] italic">“{entry.reason}”</p>}
                  <p className="text-[11.5px] text-dim">
                    Version {entry.version}
                    {entry.by ? ` · ${entry.by}` : ""}
                    {entry.at ? ` · ${new Date(entry.at).toLocaleString()}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn inline-flex shrink-0 items-center gap-2"
                  onClick={() => restoreVersion(entry)}
                >
                  <RotateCcw size={14} /> Restore
                </button>
              </li>
            ))}
          </ul>
          {data.historyTotal != null && data.historyTotal > data.history.length && (
            <p className="mt-3 text-[11.5px] text-dim">
              Showing the {data.history.length} most recent of {data.historyTotal} versions.
            </p>
          )}
        </section>
      )}

      {/* --- Barre de sauvegarde -------------------------------------------- */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-bd bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-6 py-3">
          <div className="min-w-0 flex-1 text-[12px]">
            {saveError ? (
              <ul className="text-fg">
                {saveError.map((e, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <AlertTriangle size={14} className="mt-[2px] shrink-0" />
                    {e}
                  </li>
                ))}
              </ul>
            ) : dirty ? (
              <span>
                Unsaved changes
                {changedCount > 0 ? ` · ${changedCount} change${changedCount > 1 ? "s" : ""}` : ""}
              </span>
            ) : savedAt ? (
              <span className="inline-flex items-center gap-2 text-dim">
                <Check size={14} /> Saved at {savedAt}. New analyses use these rules; reports
                already produced are unchanged.
              </span>
            ) : (
              <span className="text-dim">
                {data
                  ? `Version ${data.version}${data.updatedBy ? ` · last edited by ${data.updatedBy}` : ""}`
                  : "Loading…"}
              </span>
            )}
          </div>
          {dirty && (
            <div className="w-[240px]">
              <input
                className="input"
                aria-label="Why are you changing this? (optional)"
                placeholder="Why this change? (optional)"
                maxLength={280}
                value={changeReason}
                onChange={(e) => setChangeReason(e.target.value)}
              />
            </div>
          )}
          <div className="w-[170px]">
            <input
              className="input"
              aria-label="Your name (optional)"
              placeholder="Your name (optional)"
              maxLength={80}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
          </div>
          <button type="button" className="btn" onClick={restoreDefaults} disabled={saving}>
            Restore defaults
          </button>
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => void save()}
            disabled={!dirty || saving || !data}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lignes
// ---------------------------------------------------------------------------

interface CategoryOption {
  id: string;
  label: string;
}

/** Les catégories séparées par nature. Un seul objet mémoïsé côté page, passé
 *  à toutes les lignes : c'est une prop d'identité stable pour le memo. */
interface CategoryGroups {
  catalog: CategoryOption[];
  custom: CategoryOption[];
}

/** Une règle du catalogue. Mémoïsée : la page en affiche 85+ et chaque frappe
 *  (recherche comprise) remonte l'état au parent — sans memo, les 85 lignes se
 *  réaffichent à chaque caractère tapé. D'où des props soit primitives, soit
 *  d'identité stable (`entry` vient du catalogue, `override` ne change que pour
 *  la règle touchée, `groups` est mémoïsé côté page). */
const CatalogRuleRow = memo(function CatalogRuleRow({
  entry,
  override,
  categoryLabel,
  groups,
  expanded,
  onExpand,
  onToggle,
  onDelete,
  onRestore,
  onCategory,
  onExamples,
  onParam,
  onText,
  onResetText,
}: {
  entry: RuleCatalogEntry;
  override?: RuleOverride;
  categoryLabel: string;
  groups: CategoryGroups;
  expanded: boolean;
  // Les handlers reçoivent l'id : ils restent ainsi partagés par toutes les
  // lignes, donc stables, donc le memo tient (cf. useCallback côté page).
  onExpand: (ruleId: string) => void;
  onToggle: (ruleId: string, enabled: boolean) => void;
  onDelete: (ruleId: string) => void;
  onRestore: (ruleId: string) => void;
  onCategory: (ruleId: string, category: string, defaultCategory: string) => void;
  onExamples: (ruleId: string, examples: RuleExample[]) => void;
  onParam: (ruleId: string, key: string, value: ParamValue) => void;
  onText: (ruleId: string, field: "label" | "description", value: string, original: string) => void;
  onResetText: (ruleId: string) => void;
}) {
  const removed = override?.removed === true;
  const enabled = entry.protected ? true : (override?.enabled ?? !entry.extendedOnly);
  const examples = override?.examples ?? [];
  // Texte EFFECTIF partout : la page affiche ce que le métier a écrit, jamais
  // le texte du code par-dessous. Le `??` vit dans rule-catalog, une seule fois,
  // pour que l'écran et le moteur ne puissent pas diverger un jour.
  const label = effectiveLabel(entry, override);
  const description = effectiveDescription(entry, override);
  const rewritten = override?.label !== undefined || override?.description !== undefined;

  // Règle affichée mais non modifiable : on montre sa valeur réelle et la
  // raison du verrou. La cacher ferait croire que le contrôle n'existe pas.
  if (entry.readOnly) {
    return (
      <div className="px-1 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {/* Règle readOnly : le serveur REFUSE aussi `label` et
                `description`, on n'offre donc pas de champ d'édition — et on
                affiche le texte du code, seul texte qui puisse exister ici. */}
            <p className="flex items-center gap-2 text-[13.5px] font-semibold">
              {entry.label}
              <Lock size={13} className="shrink-0 text-dim" />
            </p>
            <p className="mt-[2px] text-[12px] text-dim">{categoryLabel}</p>
            <p className="mt-1 max-w-3xl text-[12.5px] text-dim">{entry.description}</p>
            {entry.lockedValue && (
              <p className="mt-2 max-w-3xl text-[12px]">
                <span className="text-dim">Currently: </span>
                {entry.lockedValue}
              </p>
            )}
            {entry.lockedReason && (
              <p className="mt-1 max-w-3xl text-[11.5px] text-dim">
                Why you cannot change it here: {entry.lockedReason}
              </p>
            )}
          </div>
          <span className="shrink-0 text-[11.5px] uppercase tracking-[0.16em] text-dim">
            Not editable
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-1 py-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
          onClick={() => onExpand(entry.id)}
        >
          <span className="flex items-center gap-2 text-[13.5px] font-semibold">
            {label}
            {entry.protected && <Lock size={13} className="shrink-0 text-dim" />}
            {removed && (
              <span className="text-[11px] uppercase tracking-[0.16em] text-dim">Deleted</span>
            )}
            {/* Signalé sur la LIGNE, pas seulement dans le dépliant : sinon on
                lit un texte réécrit sans savoir qu'il l'a été, et on croit lire
                ce que fait le code. */}
            {rewritten && (
              <span className="text-[11px] uppercase tracking-[0.16em] text-dim">Renamed</span>
            )}
          </span>
          <span className="mt-[2px] block text-[12px] text-dim">{categoryLabel}</span>
        </button>

        <div className="flex shrink-0 items-center gap-4">
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={enabled}
              disabled={entry.protected || removed}
              aria-label={`Turn "${label}" on or off`}
              onChange={(e) => onToggle(entry.id, e.target.checked)}
            />
            {enabled ? "On" : "Off"}
          </label>
          {removed ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onRestore(entry.id)}
            >
              <RotateCcw size={14} /> Restore
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={entry.protected}
              title={
                entry.protected
                  ? "Always on — it catches problems that would reach the recipient."
                  : undefined
              }
              onClick={() => onDelete(entry.id)}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-4 border-l-2 border-bd pl-4">
          {entry.protected && (
            <p className="text-[11.5px] text-dim">
              Always on — it catches problems that would reach the recipient.
            </p>
          )}

          {/* Le métier possède le TEXTE, le code garde la mécanique de
              détection : réécrire un intitulé ne change jamais ce qui est
              cherché dans l'email. */}
          <div>
            <label className="block text-[12px] font-semibold" htmlFor={`${entry.id}-label`}>
              Rule name
            </label>
            <input
              id={`${entry.id}-label`}
              className="input mt-1"
              maxLength={RULE_LABEL_MAX}
              value={label}
              onChange={(e) => onText(entry.id, "label", e.target.value, entry.label)}
            />
            <AngleBracketHint value={label} />
          </div>

          <div>
            <label className="block text-[12px] font-semibold" htmlFor={`${entry.id}-description`}>
              What the agent checks
            </label>
            <textarea
              id={`${entry.id}-description`}
              className="input mt-1 min-h-[80px]"
              maxLength={RULE_DESCRIPTION_MAX}
              value={description}
              onChange={(e) => onText(entry.id, "description", e.target.value, entry.description)}
            />
            <AngleBracketHint value={description} />
          </div>

          {/* Visible uniquement si un texte a été réécrit — et le texte
              d'ORIGINE est affiché à côté : savoir qu'on lit une réécriture ne
              sert à rien si on ne peut pas voir ce qu'elle remplace. */}
          {rewritten && (
            <div className="text-[11.5px] text-dim">
              <button
                type="button"
                // `px-0` aligne le bouton sur le texte qui le suit.
                className="btn btn-ghost px-0"
                onClick={() => onResetText(entry.id)}
              >
                <RotateCcw size={13} /> Reset to default text
              </button>
              <p className="mt-1 max-w-3xl">
                Default name: “{entry.label}” — {entry.description}
              </p>
            </div>
          )}

          <CategorySelect
            id={entry.id}
            value={override?.category ?? entry.family}
            label={label}
            groups={groups}
            onChange={(value) => onCategory(entry.id, value, entry.family)}
          />

          <ExamplesEditor
            idPrefix={entry.id}
            examples={examples}
            onChange={(next) => onExamples(entry.id, next)}
          />

          {entry.params?.length ? (
            <ParamsEditor entry={entry} override={override} onParam={onParam} />
          ) : null}
        </div>
      )}
    </div>
  );
});

/** Une règle écrite à la main. Même contrainte de memo que ci-dessus : `rule`
 *  garde son identité tant que cette règle-là n'est pas modifiée. */
const CustomRuleRow = memo(function CustomRuleRow({
  rule,
  categoryLabel,
  groups,
  expanded,
  onExpand,
  onChange,
  onDelete,
}: {
  rule: CustomRule;
  categoryLabel: string;
  groups: CategoryGroups;
  expanded: boolean;
  onExpand: (ruleId: string) => void;
  onChange: (ruleId: string, change: Partial<CustomRule>) => void;
  onDelete: (ruleId: string) => void;
}) {
  // Trois états, pas deux : agent absent (défaut guidelines), agent connu,
  // agent INCONNU. Le troisième n'a rien de théorique même avec un catalogue
  // importé — une règle enregistrée hier porte une clé retirée depuis. Sans ce
  // cas, le <select> n'aurait aucune option correspondante, retomberait sur
  // « No agent chosen », et la sauvegarde suivante réécrirait la règle vers
  // autre chose SANS que personne l'ait décidé ; ou échouerait en 400 "Unknown
  // agent" (lib/rule-config.ts) sans que rien à l'écran l'ait annoncé.
  const agentIsKnown = rule.agent === undefined || rule.agent in AGENT_LABELS;
  const agentLabel = rule.agent === undefined ? undefined : AGENT_LABELS[rule.agent];
  // Un agent enregistré se lit TOUJOURS, même sans libellé connu : la clé brute
  // vaut mieux qu'une ligne muette, qui laisserait croire que la règle part au
  // défaut.
  const agentSummary =
    rule.agent === undefined
      ? undefined
      : `${agentLabel ?? rule.agent}${agentIsKnown ? "" : " (unknown)"}`;

  return (
    <div className="px-1 py-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
          onClick={() => onExpand(rule.id)}
        >
          <span className="block text-[13.5px] font-semibold">
            {rule.title || "Untitled rule"}
          </span>
          {/* La catégorie range, l'agent vérifie : les deux se lisent sans
              déplier, sinon savoir QUI contrôle une règle demande un clic par
              règle. */}
          <span className="mt-[2px] block text-[12px] text-dim">
            {categoryLabel}
            {agentSummary && ` · Checked by ${agentSummary}`}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-4">
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={rule.enabled}
              aria-label={`Turn "${rule.title || "this rule"}" on or off`}
              onChange={(e) => onChange(rule.id, { enabled: e.target.checked })}
            />
            {rule.enabled ? "On" : "Off"}
          </label>
          <button type="button" className="btn btn-ghost" onClick={() => onDelete(rule.id)}>
            Delete
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-4 border-l-2 border-bd pl-4">
          <div>
            <label
              className="block text-[12px] font-semibold"
              htmlFor={`${rule.id}-title`}
            >
              What the rule says
            </label>
            <input
              id={`${rule.id}-title`}
              className="input mt-1"
              maxLength={CUSTOM_RULE_TITLE_MAX}
              value={rule.title}
              onChange={(e) => onChange(rule.id, { title: e.target.value })}
            />
          </div>

          <div>
            <label
              className="block text-[12px] font-semibold"
              htmlFor={`${rule.id}-instruction`}
            >
              Details for the agent (optional)
            </label>
            <textarea
              id={`${rule.id}-instruction`}
              className="input mt-1 min-h-[90px]"
              placeholder="Explain it as you would to a new colleague. Example: the email must never use the word “cheap” — use “accessible” instead."
              maxLength={CUSTOM_RULE_MAX_CHARS}
              value={rule.instruction}
              onChange={(e) => onChange(rule.id, { instruction: e.target.value })}
            />
            <p className="mt-1 text-right text-[11px] text-dim">
              {rule.instruction.length} / {CUSTOM_RULE_MAX_CHARS}
            </p>
          </div>

          <CategorySelect
            id={rule.id}
            value={rule.category}
            label={rule.title || "this rule"}
            groups={groups}
            onChange={(value) => onChange(rule.id, { category: value })}
          />

          {/* Deux axes INDÉPENDANTS, d'où deux champs et non un seul : la
              catégorie range (pills, recherche), l'agent route (lib/agents.ts).
              Les libellés viennent tels quels du catalogue — les réécrire ici
              en ferait une copie qui dériverait au premier agent renommé. */}
          <div>
            <label className="block text-[12px] font-semibold" htmlFor={`${rule.id}-agent`}>
              Checked by
            </label>
            <select
              id={`${rule.id}-agent`}
              className="input mt-1"
              aria-label={`Agent that checks "${rule.title || "this rule"}"`}
              value={rule.agent ?? ""}
              // "" = champ absent, pas la chaîne vide : le serveur exige
              // `min(1)` sur `agent` (lib/rule-config.ts) et refuserait un
              // enregistrement portant une clé vide.
              onChange={(e) =>
                onChange(rule.id, { agent: e.target.value === "" ? undefined : e.target.value })
              }
            >
              <option value="">No agent chosen</option>
              {/* L'option INCONNUE est rendue avant les autres et porte la
                  valeur enregistrée : sans elle le <select> retomberait sur
                  "No agent chosen" et le prochain Save effacerait un choix
                  que personne n'a défait. */}
              {!agentIsKnown && rule.agent !== undefined && (
                <option value={rule.agent}>{rule.agent} — no longer available</option>
              )}
              {AGENT_CHOICES.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.label}
                </option>
              ))}
            </select>
            {agentIsKnown ? (
              <p className="mt-1 max-w-3xl text-[11.5px] text-dim">{DEFAULT_AGENT_NOTE}</p>
            ) : (
              <p className="mt-1 max-w-3xl text-[11.5px]">
                This agent is no longer available — pick another one, saving will fail otherwise.
              </p>
            )}
          </div>

          <ExamplesEditor
            idPrefix={rule.id}
            examples={rule.examples ?? []}
            onChange={(next) => onChange(rule.id, { examples: next })}
          />
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Blocs partagés par les deux types de ligne
// ---------------------------------------------------------------------------

/** Le serveur refuse `<` et `>` dans un intitulé réécrit (SAFE_TEXT_RE). Sans
 *  ce mot dit AU MOMENT de la frappe, la sauvegarde échoue plus tard, en bloc,
 *  sur un message qui nomme un identifiant technique : la personne ne saurait
 *  ni quelle règle ni quel caractère est en cause. On avertit sans bloquer —
 *  le serveur reste seul juge, donc un assouplissement côté serveur ne rendrait
 *  cette phrase que superflue, jamais fausse. */
function AngleBracketHint({ value }: { value: string }) {
  if (!/[<>]/.test(value)) return null;
  return (
    <p className="mt-1 text-[11.5px]">
      Remove the “&lt;” and “&gt;” characters — they are not allowed and the page will refuse to
      save.
    </p>
  );
}

/** Les deux natures de catégories, séparées dans le <select>. Les libellés
 *  restent DESCRIPTIFS ("Built-in" / "Your categories") et ne promettent aucun
 *  routage : cf. ROUTING_NOTE, le moteur ne lit pas la catégorie d'une règle
 *  pour choisir un agent. Un optgroup intitulé « Checked by an agent » ferait
 *  exactement la promesse que le code ne tient pas. */
function CategoryOptionGroups({ groups }: { groups: CategoryGroups }) {
  return (
    <>
      <optgroup label="Built-in categories">
        {groups.catalog.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </optgroup>
      {groups.custom.length > 0 && (
        <optgroup label="Your categories">
          {groups.custom.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

function CategorySelect({
  id,
  value,
  label,
  groups,
  onChange,
}: {
  id: string;
  value: string;
  label: string;
  groups: CategoryGroups;
  onChange: (value: string) => void;
}) {
  const known = [...groups.catalog, ...groups.custom].some((c) => c.id === value);
  return (
    <div>
      <label className="block text-[12px] font-semibold" htmlFor={`${id}-category`}>
        Category
      </label>
      <div className="mt-1 w-[220px]">
        <select
          id={`${id}-category`}
          className="input"
          aria-label={`Category of "${label}"`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <CategoryOptionGroups groups={groups} />
          {/* La catégorie enregistrée peut avoir été supprimée par quelqu'un
              d'autre : sans cette option, le select afficherait la PREMIÈRE de
              la liste et enregistrerait un déplacement que personne n'a demandé. */}
          {!known && <option value={value}>{value} (removed)</option>}
        </select>
      </div>
    </div>
  );
}

/** Exemples joints à une règle. Ils ne servent pas à décorer : l'agent les lit
 *  et s'en sert pour trancher les cas limites — c'est le seul moyen, sans
 *  toucher au code, d'expliquer où passe la frontière. */
function ExamplesEditor({
  idPrefix,
  examples,
  onChange,
}: {
  idPrefix: string;
  examples: RuleExample[];
  onChange: (next: RuleExample[]) => void;
}) {
  const full = examples.length >= RULE_EXAMPLES_MAX;

  return (
    <div>
      <p className="text-[12px] font-semibold">Examples</p>
      <p className="mt-[2px] max-w-2xl text-[11.5px] text-dim">
        The agent reads these when it judges the email — one or two borderline cases are worth more
        than a long explanation.
      </p>

      {examples.length > 0 && (
        <ul className="mt-2 space-y-2">
          {examples.map((example, i) => (
            <li key={i} className="flex items-center gap-2">
              <button
                type="button"
                aria-pressed={example.kind === "ko"}
                aria-label={
                  example.kind === "ko"
                    ? "This example breaks the rule — click to mark it as passing"
                    : "This example follows the rule — click to mark it as failing"
                }
                onClick={() =>
                  onChange(
                    examples.map((e, j) =>
                      j === i ? { ...e, kind: e.kind === "ko" ? "ok" : "ko" } : e
                    )
                  )
                }
                className="w-[74px] shrink-0 rounded-full border border-bd px-2 py-1 text-[11px]"
              >
                {example.kind === "ko" ? "Fails" : "Passes"}
              </button>
              <input
                id={`${idPrefix}-example-${i}`}
                className="input"
                aria-label={`Example ${i + 1}`}
                placeholder="Write the wording as it would appear in the email"
                maxLength={RULE_EXAMPLE_MAX_CHARS}
                value={example.text}
                onChange={(e) =>
                  onChange(examples.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                }
              />
              <button
                type="button"
                className="btn btn-ghost shrink-0 px-2"
                aria-label={`Delete example ${i + 1}`}
                onClick={() => onChange(examples.filter((_, j) => j !== i))}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="btn mt-2"
        disabled={full}
        title={full ? `Up to ${RULE_EXAMPLES_MAX} examples per rule.` : undefined}
        onClick={() => onChange([...examples, { kind: "ko", text: "" }])}
      >
        <Plus size={14} /> Add example
      </button>
      {full && (
        <span className="ml-3 text-[11.5px] text-dim">
          Limit reached ({RULE_EXAMPLES_MAX} examples).
        </span>
      )}
    </div>
  );
}

/** Paramètres d'une règle du catalogue. Repris tel quel de la version
 *  précédente de la page : les formes autorisées (int, terms, int-list,
 *  boolean) et la tolérance à la saisie en cours sont volontaires. */
function ParamsEditor({
  entry,
  override,
  onParam,
}: {
  entry: RuleCatalogEntry;
  override?: RuleOverride;
  onParam: (ruleId: string, key: string, value: ParamValue) => void;
}) {
  return (
    <div className="space-y-3">
      {entry.params?.map((spec) =>
        spec.kind === "int" ? (
          <div key={spec.key}>
            <div className="flex items-center gap-3">
              <label className="text-[12px] font-semibold" htmlFor={`${entry.id}-${spec.key}`}>
                {spec.label}
              </label>
              <div className="w-[110px]">
                <input
                  id={`${entry.id}-${spec.key}`}
                  type="number"
                  className="input"
                  min={spec.min}
                  max={spec.max}
                  value={
                    typeof override?.params?.[spec.key] === "number"
                      ? (override.params[spec.key] as number)
                      : spec.default
                  }
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) onParam(entry.id, spec.key, Math.round(n));
                  }}
                />
              </div>
              {spec.unit ? <span className="text-[12px] text-dim">{spec.unit}</span> : null}
            </div>
            <p className="mt-1 max-w-2xl text-[11.5px] text-dim">
              {spec.help} Allowed range: {spec.min}–{spec.max}
              {spec.unit ?? ""}.
            </p>
          </div>
        ) : spec.kind === "boolean" ? (
          <div key={spec.key}>
            <label className="flex items-center gap-2 text-[12px] font-semibold">
              <input
                type="checkbox"
                checked={
                  typeof override?.params?.[spec.key] === "boolean"
                    ? (override.params[spec.key] as boolean)
                    : spec.default
                }
                onChange={(e) => onParam(entry.id, spec.key, e.target.checked)}
              />
              {spec.label}
            </label>
            {spec.help && <p className="mt-1 max-w-2xl text-[11.5px] text-dim">{spec.help}</p>}
          </div>
        ) : spec.kind === "int-list" ? (
          <div key={spec.key}>
            <label className="block text-[12px] font-semibold" htmlFor={`${entry.id}-${spec.key}`}>
              {spec.label}
            </label>
            <input
              id={`${entry.id}-${spec.key}`}
              className="input mt-1"
              inputMode="numeric"
              placeholder="Separate with commas — e.g. 404, 410"
              value={(
                (Array.isArray(override?.params?.[spec.key])
                  ? (override.params[spec.key] as number[])
                  : spec.default) ?? []
              ).join(", ")}
              onChange={(e) =>
                onParam(
                  entry.id,
                  spec.key,
                  // On garde ce qui est un entier et on jette le reste : la
                  // saisie reste fluide pendant la frappe, et le serveur
                  // revalide les bornes de toute façon.
                  e.target.value
                    .split(",")
                    .map((t) => Number(t.trim()))
                    .filter((n) => Number.isInteger(n))
                    .slice(0, spec.maxItems)
                )
              }
            />
            <p className="mt-1 max-w-2xl text-[11.5px] text-dim">
              {spec.help} Whole numbers between {spec.min} and {spec.max}, up to {spec.maxItems} of
              them.
            </p>
          </div>
        ) : (
          <div key={spec.key}>
            <label className="block text-[12px] font-semibold" htmlFor={`${entry.id}-${spec.key}`}>
              {spec.label}
            </label>
            <input
              id={`${entry.id}-${spec.key}`}
              className="input mt-1"
              placeholder="Separate with commas"
              value={(
                (Array.isArray(override?.params?.[spec.key])
                  ? (override.params[spec.key] as string[])
                  : spec.default) ?? []
              ).join(", ")}
              onChange={(e) =>
                onParam(
                  entry.id,
                  spec.key,
                  e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .slice(0, spec.maxItems)
                )
              }
            />
            <p className="mt-1 max-w-2xl text-[11.5px] text-dim">
              {spec.help} Up to {spec.maxItems} entries.
            </p>
          </div>
        )
      )}
    </div>
  );
}
