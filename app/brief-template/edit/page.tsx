// Éditeur du référentiel de brief.
//
// Trois principes tiennent tout cet écran :
//
// 1. La validation affichée est LA MÊME FONCTION que celle du serveur
//    (`checkTemplateCoherence`, importée). Pas une reformulation, pas une
//    approximation « pour l'UX » — l'import fait que le compilateur casse le
//    jour où l'une des deux bouge. Deux validations parallèles produisent tôt ou
//    tard un formulaire qui se remplit et refuse de s'enregistrer, ou l'inverse.
//
// 2. `key` ne s'édite pas. C'est un contrat qui voyage dans les rapports déjà
//    rendus et dans les réglages de règles. Le champ affiché et modifiable est
//    `label` — c'est exactement pour ça que les deux existent séparément.
//
// 3. Rien n'est enregistré tant qu'une ERREUR subsiste, et les avertissements,
//    eux, n'empêchent rien mais restent visibles. Un template qui ne peut pas
//    mesurer ne rendrait pas d'erreur à l'usage : il rendrait des verdicts
//    d'allure normale sur toutes les campagnes suivantes.
"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import type { BriefTemplateField, BriefTemplateFieldKind } from "@/lib/brief-template";
import { colLetter } from "@/lib/brief-template";
import { LANG_LABEL, canonColumn, displayLang } from "@/lib/lang-codes";
import {
  TEMPLATE_ALIAS_MAX,
  TEMPLATE_LABEL_MAX,
  checkTemplateCoherence,
  type TemplateProblem,
} from "@/lib/template-edit";

interface Geometry {
  headerRow: number;
  fieldCol: number;
  descCol: number;
  valueCol: number;
  firstLangCol: number;
}

interface Loaded {
  id: string;
  version: number;
  revision: string;
  label: string;
  channel: string;
  updatedAt: string;
  origin: "stored" | "code" | "stored_invalid" | "pinned_missing";
  problems: TemplateProblem[];
  languageColumns: string[];
  languages: { code: string; name: string }[];
  geometry: Geometry;
  fields: BriefTemplateField[];
  templates: { id: string; label: string; editedYet: boolean }[];
}

/** Brouillon en cours d'édition. Distinct de `Loaded` : le second est ce qui a
 *  été LU, et il ne bouge pas — c'est lui qui sert de référence pour détecter un
 *  renommage de clé et pour poser `baseVersion`. Fusionner les deux ferait
 *  comparer le brouillon à lui-même, et le contrôle de renommage, qui est le
 *  plus important, ne pourrait plus jamais se déclencher. */
interface Draft {
  label: string;
  channel: string;
  geometry: Geometry;
  languageColumns: string[];
  languages: { code: string; name: string }[];
  fields: BriefTemplateField[];
}

const KINDS: BriefTemplateFieldKind[] = ["text", "url", "meta"];

/** Codes PROPOSÉS à la saisie. Dérivés du catalogue de `lang-codes`, jamais
 *  recopiés : une liste écrite ici cesserait de suivre le catalogue le jour où
 *  une langue y est ajoutée, et proposerait des codes que la plateforme sait
 *  lire tout en en cachant d'autres. Les codes de MARCHÉ (MX, ZHS, ZHT) sont
 *  ajoutés explicitement — ils ne sont pas des langues, ce sont des colonnes,
 *  et ce sont justement ceux qu'on ne devine pas. */
const KNOWN_LANG_CODES = [...new Set([...Object.keys(LANG_LABEL), "MX", "ZHS", "ZHT"])].sort();

export default function EditBriefTemplatePage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [id, setId] = useState("default");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newLang, setNewLang] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setDraft(null);
    setLoadError(null);
    fetch(`/api/brief-template?id=${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Loaded;
      })
      .then((d) => {
        if (cancelled) return;
        setLoaded(d);
        setDraft({
          label: d.label,
          channel: d.channel,
          geometry: d.geometry,
          languageColumns: [...d.languageColumns],
          languages: d.languages.map((l) => ({ ...l })),
          fields: d.fields.map((f) => ({ ...f })),
        });
      })
      // Un écran d'édition qui échoue à charger doit le DIRE. Vide, il se lirait
      // « ce template n'a aucun champ » — et quelqu'un le remplirait à neuf.
      .catch((e: unknown) => !cancelled && setLoadError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // `...draft.geometry` à plat : la validation raisonne sur la forme STOCKÉE, où
  // les cinq nombres sont au premier niveau. Le brouillon les groupe seulement
  // pour le formulaire. `loaded` sert de référence pour le contrôle de
  // renommage de clé — c'est l'état LU, jamais le brouillon.
  const check = useMemo(
    () =>
      draft && loaded
        ? checkTemplateCoherence({ ...draft, ...draft.geometry }, loaded)
        : null,
    [draft, loaded]
  );
  const errors = check?.problems.filter((p) => p.severity === "error") ?? [];
  const warnings = check?.problems.filter((p) => p.severity === "warning") ?? [];

  function patchField(index: number, patch: Partial<BriefTemplateField>) {
    setDraft((d) =>
      d ? { ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) } : d
    );
  }

  // ── Les quatre gestes sur les langues ────────────────────────────────────
  //
  // Ils tiennent tous à une seule contrainte : `languageColumns` et `languages`
  // sont DEUX listes, et elles se désaccordent silencieusement. La première
  // décide quelle cellule du classeur porte quelle langue ; la seconde ne porte
  // que le nom lisible. Éditer l'une sans l'autre — ce que faisait la zone de
  // texte à virgules qui occupait cette section — laisse une colonne sans nom
  // ou un nom sans colonne, et l'écart ne se voit qu'au moment où quelqu'un
  // remplit le brief et ne sait pas quel marché il est en train d'écrire.
  // Les deux contrôles qui le disent (template-edit.ts, points 7 et 12) restent
  // en place : ces gestes-ci évitent de les déclencher, ils ne les remplacent
  // pas — rien n'oblige à passer par cet écran pour écrire un template.

  /** Renommer un code DÉPLACE son nom avec lui. Sans ça, renommer "JP" en "JA"
   *  laisserait le nom "Japanese" accroché à une colonne qui n'existe plus, et
   *  la nouvelle colonne apparaîtrait sans nom — deux avertissements pour une
   *  frappe, et aucun des deux ne décrit l'intention. */
  function renameLanguage(index: number, raw: string) {
    const next = raw.toUpperCase();
    setDraft((d) => {
      if (!d) return d;
      const prev = d.languageColumns[index];
      return {
        ...d,
        languageColumns: d.languageColumns.map((c, i) => (i === index ? next : c)),
        languages: d.languages.map((l) => (l.code === prev ? { ...l, code: next } : l)),
      };
    });
  }

  function nameLanguage(code: string, name: string) {
    setDraft((d) => {
      if (!d) return d;
      const exists = d.languages.some((l) => l.code === code);
      return {
        ...d,
        // Un nom vidé RETIRE l'entrée au lieu d'en garder une vide : le schéma
        // de sauvegarde exige un nom non vide (`min(1)`), et une entrée vide
        // ferait échouer l'enregistrement sur un champ que l'écran présente
        // comme facultatif.
        languages: !name.trim()
          ? d.languages.filter((l) => l.code !== code)
          : exists
            ? d.languages.map((l) => (l.code === code ? { ...l, name } : l))
            : [...d.languages, { code, name }],
      };
    });
  }

  /** Retirer une colonne retire aussi son nom — mais SEULEMENT si plus aucune
   *  colonne ne porte ce code. Deux colonnes homonymes sont déjà une erreur
   *  bloquante (contrôle 6) ; supprimer la seconde ne doit pas emporter le nom
   *  de la première au passage. */
  function removeLanguage(index: number) {
    setDraft((d) => {
      if (!d) return d;
      const code = d.languageColumns[index];
      const columns = d.languageColumns.filter((_, i) => i !== index);
      return {
        ...d,
        languageColumns: columns,
        languages: columns.includes(code)
          ? d.languages
          : d.languages.filter((l) => l.code !== code),
      };
    });
  }

  function addLanguage() {
    const code = newLang.trim().toUpperCase();
    if (!code || !draft) return;
    // Un code déjà présent n'est pas ajouté une seconde fois : le doublon est
    // une ERREUR bloquante (deux colonnes, une seule adresse de cellule), et la
    // fabriquer d'un clic depuis un bouton d'ajout serait un piège.
    if (draft.languageColumns.includes(code)) {
      setNewLang("");
      return;
    }
    setDraft({
      ...draft,
      languageColumns: [...draft.languageColumns, code],
      // Le nom est PRÉ-REMPLI depuis le catalogue quand la plateforme reconnaît
      // le code, et laissé vide sinon. Inventer un nom pour un code inconnu
      // afficherait une langue gérée là où la colonne sera perdue.
      languages: canonColumn(code)
        ? [...draft.languages, { code, name: displayLang(code) }]
        : draft.languages,
    });
    setNewLang("");
  }

  async function save() {
    if (!draft || !loaded) return;
    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const res = await fetch(`/api/brief-template/${encodeURIComponent(loaded.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: draft.label,
          channel: draft.channel,
          ...draft.geometry,
          languageColumns: draft.languageColumns,
          languages: draft.languages,
          fields: draft.fields,
          // Verrou : la version LUE, pas une version recalculée. Un décalage
          // veut dire que quelqu'un a enregistré pendant qu'on éditait.
          baseVersion: loaded.version,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        revision?: string;
        previousRevision?: string;
        details?: string[];
        problems?: TemplateProblem[];
      };
      if (!res.ok) {
        setSaveError(
          [body.error, ...(body.details ?? []), ...(body.problems ?? []).map((p) => p.message)]
            .filter(Boolean)
            .join(" · ")
        );
        return;
      }
      // On AFFICHE les deux révisions. C'est la seule information qui permette
      // de relier les rapports d'hier à ceux de demain : deux verdicts qui
      // portent des révisions différentes n'ont pas été mesurés contre le même
      // référentiel, même quand les deux disent « conforme ».
      setSaveResult(
        body.previousRevision && body.previousRevision !== body.revision
          ? `Saved. Reports from now on record revision ${body.revision}; earlier ones record ${body.previousRevision}.`
          : `Saved. The declaration did not change, so the revision is still ${body.revision} and no cached report is invalidated.`
      );
      setId((x) => x); // pas de rechargement : on garde ce que l'utilisateur voit
      const fresh = (await (await fetch(`/api/brief-template?id=${loaded.id}`)).json()) as Loaded;
      setLoaded(fresh);
    } catch (e: unknown) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function discardEdit() {
    if (!loaded) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/brief-template/${encodeURIComponent(loaded.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        setSaveError(b.error ?? `HTTP ${res.status}`);
        return;
      }
      window.location.reload();
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="card border-l-4 border-l-[color:var(--critical)] p-4 text-[13px]">
        <p className="font-bold">This template could not be loaded, so nothing is shown below.</p>
        <p className="mt-1 text-dim">{loadError}</p>
      </div>
    );
  }
  if (!draft || !loaded) return <p className="text-[13px] text-dim">Loading template…</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="eyebrow">Campaign brief</p>
          <h1 className="doc-title text-[32px]">Edit template</h1>
          <p className="mt-1 text-[13px] text-dim">
            The structure below is what the QA measures every brief against — which fields must be
            there, which ones must be translated, and where each one lives in the workbook.
          </p>
        </div>
        <a href="/brief-template" className="btn btn-ghost ml-auto gap-2">
          <ArrowLeft size={14} />
          Back to reference
        </a>
      </div>

      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-[12px]">
            <span className="block text-dim">Template</span>
            <select className="input mt-1" value={id} onChange={(e) => setId(e.target.value)}>
              {loaded.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.editedYet ? "" : " (built-in)"}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px]">
            <span className="block text-dim">Name</span>
            <input
              className="input mt-1 w-64"
              maxLength={TEMPLATE_LABEL_MAX}
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </label>
          <label className="text-[12px]">
            <span className="block text-dim">Channel</span>
            <input
              className="input mt-1 w-32"
              value={draft.channel}
              onChange={(e) => setDraft({ ...draft, channel: e.target.value })}
            />
          </label>
          <div className="text-[12px]">
            <span className="block text-dim">Revision in force</span>
            <span className="font-mono font-bold">{loaded.revision}</span>
          </div>
          <div className="text-[12px]">
            <span className="block text-dim">Version</span>
            <span className="font-mono font-bold">v{loaded.version}</span>
          </div>
        </div>
        <p className="text-[11px] text-dim">
          The version is a label for people. The revision is what every report records — it changes
          only when something that can change a verdict changes, so re-saving without editing
          invalidates nothing.
        </p>
      </div>

      {loaded.origin === "stored_invalid" && (
        <div className="card flex gap-3 border-l-4 border-l-[color:var(--critical)] p-4 text-[12px]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">
              The saved edit cannot measure anything, so the built-in reference is judging briefs
              right now. Fix the errors below and save, or discard the edit.
            </p>
            <button className="btn btn-ghost mt-2 gap-2" onClick={discardEdit} disabled={saving}>
              <RotateCcw size={14} />
              Discard the saved edit
            </button>
          </div>
        </div>
      )}

      {/* Un id demandé qui n'existe plus. Sans cet encart, l'écran affichait le
          template livré exactement comme il l'affiche quand rien n'a jamais été
          enregistré : « ce que vous aviez choisi a disparu » se lisait « rien
          n'a été choisi ». Les deux mènent au même contenu, pas au même geste. */}
      {loaded.origin === "pinned_missing" && (
        <div className="card flex gap-3 border-l-4 border-l-[color:var(--critical)] p-4 text-[12px]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="font-bold">
            This template no longer exists — the built-in reference is shown, and it is what judges
            briefs pinned to this id. Saving here creates it again under the same id.
          </p>
        </div>
      )}

      {/* Les deux polarités séparées et JAMAIS fusionnées en un compteur : une
          erreur bloque, un avertissement informe, et les additionner en « 4
          problèmes » ferait passer un blocage pour une remarque. */}
      {errors.length > 0 && (
        <div className="card border-l-4 border-l-[color:var(--critical)] p-4 text-[12px]">
          <p className="font-bold">
            {errors.length} {errors.length === 1 ? "problem stops" : "problems stop"} this template
            from measuring. Saving is blocked until they are fixed.
          </p>
          <ul className="mt-1.5 space-y-1 text-dim">
            {errors.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="card border-l-4 border-l-[color:var(--major)] p-4 text-[12px]">
          <p className="font-bold">
            {warnings.length} {warnings.length === 1 ? "thing is" : "things are"} worth knowing.
            They do not stop you saving.
          </p>
          <ul className="mt-1.5 space-y-1 text-dim">
            {warnings.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="doc-section">Fields</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-bd text-left">
                <th className="px-3 py-2 font-bold">Label</th>
                <th className="px-3 py-2 font-bold">
                  Key
                  <span className="block font-normal text-dim">fixed — used by reports</span>
                </th>
                <th className="px-3 py-2 font-bold">Row</th>
                <th className="px-3 py-2 font-bold">Type</th>
                <th className="px-3 py-2 font-bold">Required</th>
                <th className="px-3 py-2 font-bold">Translated</th>
                <th className="px-3 py-2 font-bold">
                  Also accepted as
                  <span className="block font-normal text-dim">one per line</span>
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {draft.fields.map((f, i) => (
                <tr key={f.key} className="border-b border-bd align-top last:border-0">
                  <td className="px-3 py-2">
                    <input
                      className="input w-56"
                      maxLength={TEMPLATE_LABEL_MAX}
                      value={f.label}
                      onChange={(e) => patchField(i, { label: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-dim">{f.key}</td>
                  <td className="px-3 py-2">
                    <input
                      className="input w-16"
                      type="number"
                      min={1}
                      value={f.rowOffset}
                      onChange={(e) => patchField(i, { rowOffset: Number(e.target.value) })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className="input"
                      value={f.kind}
                      onChange={(e) =>
                        patchField(i, { kind: e.target.value as BriefTemplateFieldKind })
                      }
                    >
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => patchField(i, { required: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={f.translatable}
                      onChange={(e) => patchField(i, { translatable: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <textarea
                      className="input h-14 w-48"
                      value={(f.aliases ?? []).join("\n")}
                      onChange={(e) =>
                        patchField(i, {
                          aliases: e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .slice(0, TEMPLATE_ALIAS_MAX),
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    {/* Supprimer un champ est une ERREUR tant que sa clé
                        existait avant : le contrôle de renommage le dit, et
                        c'est voulu — on veut que la suppression d'un champ que
                        des rapports citent soit un geste conscient. */}
                    <button
                      className="btn btn-ghost"
                      title="Remove this field"
                      onClick={() =>
                        setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          className="btn btn-ghost gap-2"
          onClick={() => {
            // Clé dérivée du rang, jamais du libellé : un libellé se retape, et
            // une clé qui suivrait le libellé se renommerait toute seule au
            // premier remaniement — précisément ce que `key` existe pour éviter.
            const n = draft.fields.length + 1;
            const rows = draft.fields.map((f) => f.rowOffset);
            setDraft({
              ...draft,
              fields: [
                ...draft.fields,
                {
                  key: `field-${Date.now().toString(36)}`,
                  label: `New field ${n}`,
                  description: "",
                  master: "",
                  rowOffset: (rows.length ? Math.max(...rows) : 0) + 1,
                  kind: "text",
                  required: false,
                  translatable: true,
                },
              ],
            });
          }}
        >
          <Plus size={14} />
          Add a field
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="doc-section">Languages</h2>
        <p className="text-[12px] text-dim">
          One row per language column, in workbook order, starting at the first language column.
          Order matters: it is what maps each code to a cell. <b>Reads as</b> is the language the
          platform will actually understand the code to be — it is the thing to check before saving,
          because a code it cannot read is a column that silently arrives empty.
        </p>
        <div className="card overflow-x-auto p-0">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-bd text-left">
                <th className="px-3 py-2 font-bold">
                  Column
                  <span className="block font-normal text-dim">in the workbook</span>
                </th>
                <th className="px-3 py-2 font-bold">
                  Code
                  <span className="block font-normal text-dim">as written in the header</span>
                </th>
                <th className="px-3 py-2 font-bold">
                  Reads as
                  <span className="block font-normal text-dim">what the platform understands</span>
                </th>
                <th className="px-3 py-2 font-bold">
                  Language name
                  <span className="block font-normal text-dim">shown to whoever fills the brief</span>
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {draft.languageColumns.map((code, i) => {
                const canon = canonColumn(code);
                const named = draft.languages.find((l) => l.code === code);
                return (
                  <tr key={i} className="border-b border-bd align-top last:border-0">
                    <td className="px-3 py-2 font-mono text-dim">
                      {colLetter(draft.geometry.firstLangCol + i)}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className="input w-24 font-mono"
                        value={code}
                        list="known-language-codes"
                        onChange={(e) => renameLanguage(i, e.target.value)}
                      />
                    </td>
                    {/* Le code non résolu ne s'écrit pas en gris comme une case
                        vide : une colonne perdue et une colonne pas encore
                        remplie se ressemblent, et une seule des deux fait
                        disparaître du contenu déjà écrit. */}
                    <td className="px-3 py-2">
                      {canon ? (
                        <span>
                          {displayLang(code)}
                          {canon !== code.trim().toUpperCase() && (
                            <span className="ml-1 font-mono text-dim">({canon})</span>
                          )}
                        </span>
                      ) : (
                        <span className="font-bold text-[color:var(--major)]">
                          not recognised — this column will be dropped
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className="input w-56"
                        maxLength={TEMPLATE_LABEL_MAX}
                        placeholder={canon ? displayLang(code) : "name this column"}
                        value={named?.name ?? ""}
                        onChange={(e) => nameLanguage(code, e.target.value)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        className="btn btn-ghost"
                        title="Remove this language column"
                        onClick={() => removeLanguage(i)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* Les codes connus sont PROPOSÉS, jamais imposés : le classeur d'un
            client peut nommer sa colonne autrement, et une liste fermée
            l'obligerait à renommer sa propre source pour être lu. */}
        <datalist id="known-language-codes">
          {KNOWN_LANG_CODES.map((c) => (
            <option key={c} value={c}>
              {displayLang(c)}
            </option>
          ))}
        </datalist>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[12px]">
            <span className="block text-dim">Add a language — code as written in the workbook</span>
            <input
              className="input mt-1 w-40 font-mono"
              list="known-language-codes"
              placeholder="e.g. DE"
              value={newLang}
              onChange={(e) => setNewLang(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addLanguage()}
            />
          </label>
          <button className="btn btn-ghost gap-2" onClick={addLanguage} disabled={!newLang.trim()}>
            <Plus size={14} />
            Add language
          </button>
          {newLang.trim() &&
            (canonColumn(newLang) ? (
              <span className="text-[12px] text-dim">
                Will be read as <b>{displayLang(newLang)}</b>.
              </span>
            ) : (
              <span className="text-[12px] font-bold text-[color:var(--major)]">
                The platform does not know this code — the column would be dropped when a brief is
                read.
              </span>
            ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="doc-section">Workbook geometry</h2>
        <p className="text-[12px] text-dim">
          Column numbers are 0-based, as stored. Changing them moves every cell address the
          reference page prints and every cell the generated workbook writes.
        </p>
        <div className="card flex flex-wrap gap-4 p-4 text-[12px]">
          {(
            [
              ["headerRow", "Header row"],
              ["fieldCol", "FIELD column"],
              ["descCol", "DESCRIPTION column"],
              ["valueCol", "VALUE column"],
              ["firstLangCol", "First language column"],
            ] as const
          ).map(([k, label]) => (
            <label key={k}>
              <span className="block text-dim">{label}</span>
              <input
                className="input mt-1 w-24"
                type="number"
                min={0}
                value={draft.geometry[k]}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    geometry: { ...draft.geometry, [k]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-accent gap-2" onClick={save} disabled={saving || errors.length > 0}>
          <Save size={14} />
          {saving ? "Saving…" : "Save template"}
        </button>
        {(loaded.origin === "stored" || loaded.origin === "stored_invalid") && (
          <button className="btn btn-ghost gap-2" onClick={discardEdit} disabled={saving}>
            <RotateCcw size={14} />
            Discard edit, go back to built-in
          </button>
        )}
        {saveError && <span className="text-[12px] text-[color:var(--critical)]">{saveError}</span>}
        {saveResult && <span className="text-[12px] text-dim">{saveResult}</span>}
      </div>
    </div>
  );
}
