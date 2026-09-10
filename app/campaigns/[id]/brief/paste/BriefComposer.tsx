"use client";

// Le brief ET son référentiel, sur un seul écran.
//
// C'était deux pages. Une pour COLLER le brief dans un tableau aux colonnes
// figées, une autre, ailleurs, pour changer ces colonnes. Le métier qui recevait
// un brief avec une langue de plus n'avait aucun moyen de le voir : le tableau
// ne montrait pas la colonne manquante, il montrait un tableau complet — avec
// une colonne de moins. Un manque ne se remarque pas ; un tableau, si.
//
// TROIS PRINCIPES tiennent cet écran, et ils viennent tous de la même idée : ce
// qui est ENREGISTRÉ et ce qui est SAISI ne sont pas la même matière.
//
// 1. La structure se SAUVE, le contenu s'IMPORTE. Deux verbes, deux boutons,
//    jamais fusionnés. Le classeur est composé côté serveur À PARTIR DE LA
//    STRUCTURE ENREGISTRÉE — pas de celle affichée. Importer avec une colonne
//    ajoutée mais non enregistrée renverrait donc « colonne inconnue », un refus
//    juste dont le message ne dirait rien de la cause. L'import est bloqué tant
//    que la structure diffère, et la phrase le dit.
//
// 2. La validation affichée est LA MÊME FONCTION que celle du serveur
//    (`checkTemplateCoherence`, importée). Deux validations parallèles finissent
//    par produire un formulaire qui se remplit sans erreur et refuse de
//    s'enregistrer, ou l'inverse.
//
// 3. Le texte déjà tapé SUIT sa colonne. Renommer un code de langue déplace le
//    contenu avec lui ; retirer une colonne retire son contenu. Sans ça, `fill`
//    garderait des clés que le serveur ne connaît plus et refuserait tout
//    l'import pour du texte que l'écran n'affiche plus.
import { ImagePlus, Loader2, Plus, Save, Table2, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { BriefTemplateField } from "@/lib/brief-template";
import { colLetter, layout } from "@/lib/brief-template";
import { LANG_LABEL, canonColumn, displayLang } from "@/lib/lang-codes";
import { TEMPLATE_LABEL_MAX, checkTemplateCoherence, type TemplateProblem } from "@/lib/template-edit";
import { looksLikeBlock, parseTsv } from "@/lib/tsv";
import { GLOSSARY_MAX_CHARS, GLOSSARY_NOTE_MAX_CHARS } from "@/lib/glossary";

/** Code de la colonne MASTER (contenu non traduit) tel que l'attend
 *  /api/brief-template/compose. La chaîne vide est une VALEUR de son
 *  vocabulaire, pas un trou : la nommer ici évite de la réécrire à sept
 *  endroits où une faute de frappe serait silencieuse. */
const MASTER = "";

interface Geometry {
  headerRow: number;
  fieldCol: number;
  descCol: number;
  valueCol: number;
  firstLangCol: number;
}

/** La DÉCLARATION du référentiel : tout ce qui, en changeant, change une
 *  mesure. Ni version, ni date, ni provenance — ceux-là sont des faits
 *  d'enregistrement, posés par le serveur. */
interface Declaration {
  label: string;
  channel: string;
  geometry: Geometry;
  languageColumns: string[];
  languages: { code: string; name: string; note?: string }[];
  fields: BriefTemplateField[];
  /** Glossaire GÉNÉRAL. Toujours une chaîne côté écran — jamais `undefined` :
   *  un champ contrôlé qui bascule entre `undefined` et `""` fait perdre le
   *  curseur à React et se tape en désordre. La distinction des trois états se
   *  joue côté serveur (buildStoredTemplate), pas dans un `<textarea>`. */
  glossary: string;
}

export interface OwnershipInfo {
  templateId: string;
  campaignsPinned: number;
  mode: "in-place" | "copy";
  reason: string;
}

/** Codes PROPOSÉS à la saisie. Dérivés du catalogue de `lang-codes`, jamais
 *  recopiés. Les codes de MARCHÉ (MX, ZHS, ZHT) sont ajoutés explicitement : ce
 *  ne sont pas des langues mais des colonnes, et ce sont justement ceux qu'on ne
 *  devine pas. */
const KNOWN_LANG_CODES = [...new Set([...Object.keys(LANG_LABEL), "MX", "ZHS", "ZHT"])].sort();

const sameDeclaration = (a: Declaration, b: Declaration) =>
  JSON.stringify(a) === JSON.stringify(b);

export default function BriefComposer({
  campaignId,
  sheet,
  initial,
  templateId,
  version,
  revision,
  ownership,
}: {
  campaignId: string;
  sheet: string;
  initial: Declaration;
  templateId: string;
  version: number;
  revision: string;
  ownership: OwnershipInfo;
}) {
  const router = useRouter();

  // ── État ────────────────────────────────────────────────────────────────
  // `saved` est ce qui JUGE en ce moment ; `draft` est ce qu'on est en train
  // d'écrire. Les fusionner ferait comparer le brouillon à lui-même, et le
  // contrôle de disparition de clé — le plus important — ne pourrait plus
  // jamais se déclencher.
  const [saved, setSaved] = useState<Declaration>(initial);
  const [draft, setDraft] = useState<Declaration>(initial);
  const [stamp, setStamp] = useState({ templateId, version, revision, mode: ownership.mode });
  const [own, setOwn] = useState(ownership);

  const [structureOpen, setStructureOpen] = useState(false);
  const [ackRemovals, setAckRemovals] = useState(false);
  const [newLang, setNewLang] = useState("");

  const [fill, setFill] = useState<Record<string, Record<string, string>>>({});
  const [mockups, setMockups] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [savingTpl, setSavingTpl] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Ce que la structure du brouillon implique ───────────────────────────
  const columns = useMemo(() => [MASTER, ...draft.languageColumns], [draft.languageColumns]);
  // Les adresses A1 viennent de `layout()`, la seule fonction qui a le droit de
  // produire un numéro de ligne. Les recalculer ici ferait une deuxième
  // arithmétique, et une deuxième arithmétique diverge.
  const lay = useMemo(
    () =>
      layout({
        channel: draft.channel,
        ...draft.geometry,
        languageColumns: draft.languageColumns,
        fields: draft.fields,
      }),
    [draft]
  );

  const dirty = !sameDeclaration(draft, saved);

  /** Clés présentes dans le référentiel EN VIGUEUR et absentes du brouillon. */
  const removedKeys = useMemo(() => {
    const now = new Set(draft.fields.map((f) => f.key));
    return saved.fields.filter((f) => !now.has(f.key)).map((f) => f.key);
  }, [draft.fields, saved.fields]);

  // Le contrôle 9 est opposé au référentiel en vigueur, MOINS les clés dont la
  // suppression est cochée. Le serveur fait exactement le même retrait, à partir
  // de la même liste (`removedFieldKeys`) : c'est ce qui garantit que l'écran ne
  // promet rien que l'enregistrement refuse.
  const check = useMemo(() => {
    const ack = new Set(ackRemovals ? removedKeys : []);
    return checkTemplateCoherence(
      { ...draft, ...draft.geometry },
      { fields: saved.fields.filter((f) => !ack.has(f.key)) }
    );
  }, [draft, saved.fields, ackRemovals, removedKeys]);
  const errors = check.problems.filter((p) => p.severity === "error");
  const warnings = check.problems.filter((p) => p.severity === "warning");

  // ── Le contenu saisi ────────────────────────────────────────────────────
  const valueAt = (rowKey: string, col: string) => fill[rowKey]?.[col] ?? "";

  const setCell = useCallback((rowKey: string, col: string, text: string) => {
    setFill((prev) => ({ ...prev, [rowKey]: { ...(prev[rowKey] ?? {}), [col]: text } }));
  }, []);

  /** Collage d'un BLOC : le geste réel du métier — sélectionner plusieurs
   *  cellules dans Excel, les copier, les déposer ici. Le découpage respecte les
   *  guillemets d'Excel (`parseTsv`) : un corps de mail sur trois lignes est UNE
   *  cellule, pas trois lignes du tableau. */
  const pasteBlock = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>, rowIdx: number, colIdx: number) => {
      const text = e.clipboardData.getData("text/plain");
      if (!looksLikeBlock(text)) return;
      e.preventDefault();
      const grid = parseTsv(text);
      setFill((prev) => {
        const next = { ...prev };
        grid.forEach((cells, dr) => {
          const target = draft.fields[rowIdx + dr];
          if (!target) return; // débordement bas : ignoré, jamais rebouclé
          const row = { ...(next[target.key] ?? {}) };
          cells.forEach((cell, dc) => {
            const col = columns[colIdx + dc];
            if (col === undefined) return; // débordement droit
            row[col] = cell;
          });
          next[target.key] = row;
        });
        return next;
      });
    },
    [draft.fields, columns]
  );

  const filledCells = useMemo(
    () =>
      Object.values(fill).reduce(
        (n, row) => n + Object.values(row).filter((v) => v.trim() !== "").length,
        0
      ),
    [fill]
  );

  // ── Les gestes sur la structure ─────────────────────────────────────────
  //
  // Chacun touche DEUX choses : la déclaration, et le texte déjà tapé qui y est
  // accroché. Ne toucher que la première laisserait `fill` porter des clés que
  // le serveur ne connaît plus — et il refuse l'import entier pour une seule
  // clé inconnue, en nommant une colonne que l'écran n'affiche plus.

  function patchField(index: number, patch: Partial<BriefTemplateField>) {
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));
  }

  function patchLanguage(index: number, patch: { note?: string }) {
    setDraft((d) => ({
      ...d,
      languages: d.languages.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  }

  function addField() {
    // Clé dérivée du rang, jamais du libellé : un libellé se retape, et une clé
    // qui suivrait le libellé se renommerait toute seule au premier remaniement
    // — précisément ce que `key` existe pour éviter.
    const rows = draft.fields.map((f) => f.rowOffset);
    setDraft((d) => ({
      ...d,
      fields: [
        ...d.fields,
        {
          key: `field-${Date.now().toString(36)}`,
          label: `New field ${d.fields.length + 1}`,
          description: "",
          master: "",
          rowOffset: (rows.length ? Math.max(...rows) : 0) + 1,
          kind: "text",
          required: false,
          translatable: true,
        },
      ],
    }));
    setStructureOpen(true);
  }

  function removeField(index: number) {
    const key = draft.fields[index].key;
    setDraft((d) => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }));
    setFill((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** Renommer un code DÉPLACE son nom ET son contenu avec lui. Sans ça,
   *  corriger "JP" en "JA" laisserait le nom accroché à une colonne disparue et
   *  le texte déjà collé dans une colonne que plus personne ne lit. */
  function renameLanguage(index: number, rawCode: string) {
    const next = rawCode.toUpperCase();
    const prevCode = draft.languageColumns[index];
    if (prevCode === next) return;
    setDraft((d) => ({
      ...d,
      languageColumns: d.languageColumns.map((c, i) => (i === index ? next : c)),
      languages: d.languages.map((l) => (l.code === prevCode ? { ...l, code: next } : l)),
    }));
    setFill((prev) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [k, row] of Object.entries(prev)) {
        if (!(prevCode in row)) {
          out[k] = row;
          continue;
        }
        const { [prevCode]: moved, ...rest } = row;
        out[k] = { ...rest, [next]: moved };
      }
      return out;
    });
  }

  function nameLanguage(code: string, name: string) {
    setDraft((d) => {
      const exists = d.languages.some((l) => l.code === code);
      return {
        ...d,
        // Un nom vidé RETIRE l'entrée au lieu d'en garder une vide : le schéma
        // d'enregistrement exige un nom non vide, et une entrée vide ferait
        // échouer la sauvegarde sur un champ présenté comme facultatif.
        languages: !name.trim()
          ? d.languages.filter((l) => l.code !== code)
          : exists
            ? d.languages.map((l) => (l.code === code ? { ...l, name } : l))
            : [...d.languages, { code, name }],
      };
    });
  }

  function removeLanguage(index: number) {
    const code = draft.languageColumns[index];
    const columnsLeft = draft.languageColumns.filter((_, i) => i !== index);
    setDraft((d) => ({
      ...d,
      languageColumns: columnsLeft,
      // Le nom ne part que si plus AUCUNE colonne ne porte ce code : deux
      // colonnes homonymes sont déjà une erreur bloquante, et supprimer la
      // seconde ne doit pas emporter le nom de la première au passage.
      languages: columnsLeft.includes(code)
        ? d.languages
        : d.languages.filter((l) => l.code !== code),
    }));
    if (columnsLeft.includes(code)) return;
    setFill((prev) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [k, row] of Object.entries(prev)) {
        const { [code]: _dropped, ...rest } = row;
        out[k] = rest;
      }
      return out;
    });
  }

  function addLanguage() {
    const code = newLang.trim().toUpperCase();
    if (!code) return;
    // Un code déjà présent n'est pas ajouté deux fois : le doublon est une
    // erreur bloquante (deux colonnes, une seule adresse de cellule), et la
    // fabriquer d'un clic depuis un bouton d'ajout serait un piège.
    if (draft.languageColumns.includes(code)) {
      setNewLang("");
      return;
    }
    setDraft((d) => ({
      ...d,
      languageColumns: [...d.languageColumns, code],
      // Le nom est PRÉ-REMPLI quand la plateforme reconnaît le code, laissé vide
      // sinon. Inventer un nom pour un code inconnu afficherait une langue gérée
      // là où la colonne sera perdue.
      languages: canonColumn(code) ? [...d.languages, { code, name: displayLang(code) }] : d.languages,
    }));
    setNewLang("");
    setStructureOpen(true);
  }

  // ── Enregistrer la structure ────────────────────────────────────────────
  async function saveTemplate() {
    if (savingTpl || errors.length > 0) return;
    setSavingTpl(true);
    setSaveNote(null);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/template`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: draft.label,
          channel: draft.channel,
          ...draft.geometry,
          languageColumns: draft.languageColumns,
          languages: draft.languages,
          fields: draft.fields,
          // Le glossaire part TOUJOURS, y compris vide : cet écran le gère, donc
          // sa chaîne vide veut bien dire « vidé » et non « je ne connais pas ce
          // champ ». Ne l'envoyer que non vide rendrait la suppression
          // impossible — la case se viderait à l'écran et le texte reviendrait.
          glossary: draft.glossary,
          ...(ackRemovals && removedKeys.length > 0 ? { removedFieldKeys: removedKeys } : {}),
          // Verrou : la version LUE. Un décalage veut dire que quelqu'un a
          // enregistré pendant qu'on éditait. Envoyé même quand le serveur va
          // copier — c'est lui qui décide, et il l'ignore alors.
          baseVersion: stamp.version,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        details?: string[];
        problems?: TemplateProblem[];
        templateId?: string;
        created?: boolean;
        version?: number;
        revision?: string;
        previousRevision?: string;
      };
      if (!res.ok) {
        setError(
          [body.error, ...(body.details ?? []), ...(body.problems ?? []).map((p) => p.message)]
            .filter(Boolean)
            .join(" · ")
        );
        return;
      }
      setSaved(draft);
      setAckRemovals(false);
      setStamp({
        templateId: body.templateId!,
        version: body.version!,
        revision: body.revision!,
        mode: "in-place",
      });
      // Après une copie, la campagne est SEULE sur son référentiel : le prochain
      // enregistrement modifiera sur place. Le dire tout de suite évite de
      // laisser à l'écran une phrase qui décrit l'état d'avant.
      setOwn({
        templateId: body.templateId!,
        campaignsPinned: 1,
        mode: "in-place",
        reason: "This template belongs to this campaign alone, so saving edits it in place.",
      });
      // Les deux révisions sont NOMMÉES. C'est la seule information qui relie
      // les rapports d'hier à ceux de demain : deux verdicts qui portent des
      // révisions différentes n'ont pas été mesurés contre le même référentiel,
      // même quand les deux disent « conforme ».
      setSaveNote(
        body.created
          ? `Saved as a new template for this campaign. Reports from now on record revision ${body.revision}; earlier ones record ${body.previousRevision}.`
          : body.previousRevision !== body.revision
            ? `Saved. Reports from now on record revision ${body.revision}; earlier ones record ${body.previousRevision}.`
            : `Saved. The declaration did not change, so the revision is still ${body.revision} and no cached report is invalidated.`
      );
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingTpl(false);
    }
  }

  function revertTemplate() {
    setDraft(saved);
    setAckRemovals(false);
    setSaveNote(null);
  }

  // ── Importer le brief ───────────────────────────────────────────────────
  async function submit() {
    if (filledCells === 0 || busy || dirty) return;
    setError(null);
    try {
      setBusy("Composing the workbook…");
      const composed = await fetch("/api/brief-template/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `campaignId` : la campagne est épinglée à SON référentiel. Sans lui,
        // le serveur composerait contre le repli pendant que cette page affiche
        // les lignes du template de la campagne — les valeurs tomberaient dans
        // d'autres cellules que celles où le juge va les lire.
        body: JSON.stringify({ fill, fileName: "pasted-brief", campaignId }),
      });
      if (!composed.ok) {
        // Le serveur REFUSE les clés qu'il ne connaît pas plutôt que de les
        // ignorer ; on affiche ce refus tel quel au lieu de le résumer.
        const detail = await composed.json().catch(() => null);
        throw new Error(
          detail?.unknownFields?.length || detail?.unknownColumns?.length
            ? `Template mismatch — unknown fields: ${(detail.unknownFields ?? []).join(", ") || "none"}; unknown columns: ${(detail.unknownColumns ?? []).join(", ") || "none"}`
            : "The workbook could not be composed."
        );
      }
      const blob = await composed.blob();

      setBusy("Importing it through the Excel parser…");
      const form = new FormData();
      form.append("file", new File([blob], "pasted-brief.xlsx", { type: blob.type }));
      const imported = await fetch(`/api/campaigns/${campaignId}/brief`, {
        method: "POST",
        body: form,
      });
      if (!imported.ok) throw new Error("The composed brief could not be imported.");

      // Mockups APRÈS l'import : celui-ci remet à zéro les visuels extraits de
      // l'ancien fichier. Les uploads manuels y survivent, mais les envoyer
      // après supprime la question.
      for (const [i, file] of mockups.entries()) {
        setBusy(`Uploading mockup ${i + 1}/${mockups.length}…`);
        const mf = new FormData();
        mf.append("file", file);
        const up = await fetch(`/api/campaigns/${campaignId}/mockup`, { method: "POST", body: mf });
        // Un mockup refusé ne doit pas jeter le brief, qui est déjà importé.
        if (!up.ok)
          setError(`Mockup "${file.name}" was not uploaded — add it again from the brief page.`);
      }

      router.push(`/campaigns/${campaignId}/brief`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(null);
    }
  }

  const locked = busy !== null || savingTpl;

  return (
    <>
      {/* ── Le référentiel en vigueur ───────────────────────────────────── */}
      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="text-[12px]">
            <span className="block text-dim">Template</span>
            <input
              className="input mt-1 w-64"
              maxLength={TEMPLATE_LABEL_MAX}
              value={draft.label}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </div>
          <div className="text-[12px]">
            <span className="block text-dim">Revision in force</span>
            <span className="font-mono font-bold">{stamp.revision}</span>
          </div>
          <div className="text-[12px]">
            <span className="block text-dim">Version</span>
            <span className="font-mono font-bold">v{stamp.version}</span>
          </div>
          <button
            className="btn btn-ghost ml-auto gap-2"
            onClick={() => setStructureOpen((v) => !v)}
            disabled={locked}
          >
            <Table2 size={14} />
            {structureOpen ? "Hide template controls" : "Edit template"}
          </button>
        </div>
        {/* Ce qu'un enregistrement FERA, mesuré par le serveur sur l'état réel
            du stockage et jamais deviné ici : « je modifie le mien » et « j'en
            crée un » ne doivent pas se ressembler au moment du clic. */}
        <p className="text-[11px] text-dim">{own.reason}</p>
      </div>

      {/* ── Ce qui empêche, ce qui informe ──────────────────────────────── */}
      {removedKeys.length > 0 && (
        <div className="card mt-4 border-l-4 border-l-[color:var(--critical)] p-4 text-[12px]">
          <p className="font-bold">
            {removedKeys.length === 1 ? "One field is" : `${removedKeys.length} fields are`} about to
            disappear: {removedKeys.join(", ")}.
          </p>
          <p className="mt-1 text-dim">
            Field keys are a contract — reports already rendered for this campaign cite them, and
            rule settings hang off them. Removing them does not correct those reports; it leaves them
            citing a field that no longer exists.
          </p>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={ackRemovals}
              disabled={locked}
              onChange={(e) => setAckRemovals(e.target.checked)}
            />
            <span>Yes, remove {removedKeys.length === 1 ? "it" : "them"} on purpose.</span>
          </label>
        </div>
      )}
      {errors.length > 0 && (
        <div className="card mt-4 border-l-4 border-l-[color:var(--critical)] p-4 text-[12px]">
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
        <div className="card mt-4 border-l-4 border-l-[color:var(--major)] p-4 text-[12px]">
          <p className="font-bold">
            {warnings.length} {warnings.length === 1 ? "thing is" : "things are"} worth knowing. They
            do not stop you saving.
          </p>
          <ul className="mt-1.5 space-y-1 text-dim">
            {warnings.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Le tableau : structure et contenu au même endroit ───────────── */}
      <div className="card mt-4 overflow-x-auto">
        <table className="w-max min-w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-bd">
              <th className="sticky left-0 z-10 min-w-[230px] bg-panel px-3 py-2 text-left align-bottom">
                <span className="eyebrow">Field</span>
              </th>
              {columns.map((col, i) => {
                const isMaster = col === MASTER;
                const canon = isMaster ? null : canonColumn(col);
                return (
                  <th
                    key={isMaster ? "master" : `${col}-${i}`}
                    className="min-w-[190px] px-2 py-2 text-left align-bottom"
                  >
                    {structureOpen && !isMaster ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1">
                          <input
                            className="input w-20 font-mono font-bold uppercase"
                            value={col}
                            list="known-language-codes"
                            aria-label={`Language code, column ${colLetter(draft.geometry.firstLangCol + i - 1)}`}
                            disabled={locked}
                            onChange={(e) => renameLanguage(i - 1, e.target.value)}
                          />
                          <button
                            className="btn btn-ghost px-1.5"
                            title={`Remove the ${col} column`}
                            aria-label={`Remove the ${col} column`}
                            disabled={locked}
                            onClick={() => removeLanguage(i - 1)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <input
                          className="input w-full font-normal"
                          maxLength={TEMPLATE_LABEL_MAX}
                          placeholder={canon ? displayLang(col) : "name this column"}
                          aria-label={`Language name for ${col}`}
                          value={draft.languages.find((l) => l.code === col)?.name ?? ""}
                          disabled={locked}
                          onChange={(e) => nameLanguage(col, e.target.value)}
                        />
                        {/* Un code non résolu ne s'écrit pas en gris comme une
                            case vide : une colonne perdue et une colonne pas
                            encore remplie se ressemblent, et une seule des deux
                            fait disparaître du contenu déjà écrit. */}
                        {canon ? (
                          <span className="block font-normal text-[10.5px] text-dim">
                            reads as {displayLang(col)}
                          </span>
                        ) : (
                          <span className="block text-[10.5px] font-bold text-[color:var(--major)]">
                            not recognised — this column will be dropped
                          </span>
                        )}
                      </div>
                    ) : (
                      <>
                        <span className="block font-bold uppercase tracking-[0.14em]">
                          {isMaster ? "Value (master)" : col}
                        </span>
                        {!isMaster && (
                          <span className="block font-normal text-[10.5px] text-dim">
                            {draft.languages.find((l) => l.code === col)?.name ?? displayLang(col)}
                          </span>
                        )}
                      </>
                    )}
                    {/* Adresse de la colonne dans le classeur, pour qui remplit
                        l'Excel à la main plutôt qu'ici. Jamais écrite en dur. */}
                    <span className="mt-0.5 block font-mono text-[10.5px] font-normal text-dim">
                      {isMaster ? lay.headerCells.value : lay.langHeaderCells[col]}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {draft.fields.map((f, rowIdx) => {
              const row = lay.rows[rowIdx];
              return (
                <tr key={f.key} className="border-b border-bd align-top last:border-0">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-panel px-3 py-2 text-left font-semibold"
                    title={f.description || undefined}
                  >
                    {structureOpen ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1">
                          <input
                            className="input w-44 font-semibold"
                            maxLength={TEMPLATE_LABEL_MAX}
                            aria-label={`Field label, row ${rowIdx + 1}`}
                            value={f.label}
                            disabled={locked}
                            onChange={(e) => patchField(rowIdx, { label: e.target.value })}
                          />
                          <button
                            className="btn btn-ghost px-1.5"
                            title={`Remove the field ${f.label}`}
                            aria-label={`Remove the field ${f.label}`}
                            disabled={locked}
                            onClick={() => removeField(rowIdx)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <div className="flex gap-3 text-[11px] font-normal text-dim">
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={f.required}
                              disabled={locked}
                              onChange={(e) => patchField(rowIdx, { required: e.target.checked })}
                            />
                            required
                          </label>
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={f.translatable}
                              disabled={locked}
                              onChange={(e) =>
                                patchField(rowIdx, { translatable: e.target.checked })
                              }
                            />
                            translated
                          </label>
                        </div>
                      </div>
                    ) : (
                      <>
                        {f.label}
                        {f.required && <span className="text-dim"> *</span>}
                      </>
                    )}
                    <span className="mt-0.5 block font-mono text-[10.5px] font-normal text-dim">
                      {row?.fieldCell} · value {row?.valueCell}
                    </span>
                  </th>
                  {columns.map((col, colIdx) => {
                    // Une colonne de langue sur un champ non traduisible (URL,
                    // métadonnée) reste ÉDITABLE : le template en décide, pas
                    // cette page. La griser dirait « interdit » là où le
                    // classeur dit seulement « inhabituel ».
                    const dim = col !== MASTER && !f.translatable;
                    return (
                      <td key={col === MASTER ? "master" : `${col}-${colIdx}`} className="px-1 py-1">
                        <textarea
                          rows={1}
                          className={`input font-normal ${dim ? "text-dim" : ""}`}
                          value={valueAt(f.key, col)}
                          aria-label={`${f.label} — ${col === MASTER ? "master value" : col}`}
                          title={col === MASTER ? row?.valueCell : row?.langCells[col]}
                          disabled={locked}
                          onChange={(e) => setCell(f.key, col, e.target.value)}
                          onPaste={(e) => pasteBlock(e, rowIdx, colIdx)}
                        />
                      </td>
                    );
                  })}
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

      {structureOpen && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <button className="btn btn-ghost gap-2" onClick={addField} disabled={locked}>
            <Plus size={14} />
            Add a row
          </button>
          <label className="text-[12px]">
            <span className="block text-dim">Add a language column — code as in the workbook</span>
            <input
              className="input mt-1 w-40 font-mono"
              list="known-language-codes"
              placeholder="e.g. DE"
              value={newLang}
              disabled={locked}
              onChange={(e) => setNewLang(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addLanguage()}
            />
          </label>
          <button
            className="btn btn-ghost gap-2"
            onClick={addLanguage}
            disabled={locked || !newLang.trim()}
          >
            <Plus size={14} />
            Add column
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
      )}

      {/* ── GLOSSAIRE ───────────────────────────────────────────────────
             Ce que le tableau au-dessus ne peut pas dire. Il donne la
             STRUCTURE — quelle ligne, quelle colonne, quelle cellule — et rien
             de ce que les lignes VEULENT DIRE chez ce client : qu'un « Body
             Copy 2 » est facultatif hors soldes, que MX est le Mexique et non
             l'Espagne, qu'un CTA sans point final est la norme de la marque.
             Ce savoir-là vivait dans la tête des gens ; les agents ne l'ont
             jamais eu, et ils ont donc signalé comme écarts des choses
             parfaitement voulues.

             Ce n'est PAS de la documentation : ce texte part dans le prompt de
             chaque agent (lib/glossary.ts) et entre dans la révision du
             référentiel. Une phrase ajoutée ici peut changer un verdict — d'où
             la phrase qui le dit, à l'écran, plutôt qu'un titre neutre. */}
      <section className="mt-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Glossary</p>
            <h2 className="doc-title text-[19px]">What this brief means</h2>
          </div>
          <span className="max-w-[46ch] text-right text-[12px] text-dim">
            Read by the agents on every analysis — not a comment field. What you
            write here changes what they are told about this brief.
          </span>
        </div>

        <label className="mt-3 block text-[12px]">
          <span className="block text-dim">
            General notes — conventions of this client, what counts as filled in, who writes what.
          </span>
          <textarea
            className="input mt-1 min-h-[110px] w-full font-normal leading-relaxed"
            value={draft.glossary}
            maxLength={GLOSSARY_MAX_CHARS}
            disabled={locked || !structureOpen}
            placeholder={
              structureOpen
                ? "e.g. The brief is written by the agency, never by the brand. An empty cell in a declared language means “not supplied”, never “same as master”."
                : undefined
            }
            onChange={(e) => setDraft((d) => ({ ...d, glossary: e.target.value }))}
          />
        </label>
        {!structureOpen && (
          <p className="mt-1 text-[12px] text-dim">
            Turn on <b>Edit template</b> above to change the glossary.
          </p>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-bd text-left text-dim">
                <th className="w-[26%] px-2 py-1.5 font-normal">Row / column</th>
                <th className="w-[16%] px-2 py-1.5 font-normal">Rules</th>
                <th className="px-2 py-1.5 font-normal">What it means here</th>
              </tr>
            </thead>
            <tbody>
              {draft.fields.map((f, i) => (
                <tr key={f.key} className="border-b border-bd/60 align-top">
                  <th scope="row" className="px-2 py-1.5 text-left font-medium">
                    {f.label}
                    <span className="mt-0.5 block font-mono text-[10.5px] font-normal text-dim">
                      {f.key}
                    </span>
                  </th>
                  <td className="px-2 py-1.5 text-[12px] text-dim">
                    {/* Les deux politiques sont AFFICHÉES ici et pas seulement
                        dans les cases à cocher plus haut : c'est la question
                        qu'on se pose en écrivant une note (« ce champ est-il
                        obligatoire ? »), et aller la chercher ailleurs fait
                        qu'on ne se la pose pas. */}
                    {[f.required ? "required" : "optional", f.translatable ? "translated" : "not translated"].join(" · ")}
                  </td>
                  <td className="px-1 py-1">
                    <textarea
                      rows={1}
                      className="input font-normal"
                      value={f.note ?? ""}
                      maxLength={GLOSSARY_NOTE_MAX_CHARS}
                      aria-label={`Glossary note for ${f.label}`}
                      disabled={locked || !structureOpen}
                      onChange={(e) => patchField(i, { note: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
              {draft.languages.map((l, i) => (
                <tr key={`lang-${l.code}`} className="border-b border-bd/60 align-top">
                  <th scope="row" className="px-2 py-1.5 text-left font-medium">
                    <span className="font-mono">{l.code}</span> — {l.name}
                    <span className="mt-0.5 block text-[10.5px] font-normal text-dim">
                      language column
                    </span>
                  </th>
                  <td className="px-2 py-1.5 text-[12px] text-dim">
                    {/* Un code que la plateforme ne reconnaît pas est dit ICI
                        aussi : la colonne est écrite dans le classeur mais
                        aucune langue ne lui répond, et le glossaire est
                        l'endroit où l'on relit ce que chaque colonne signifie. */}
                    {canonColumn(l.code) ? `reads as ${displayLang(l.code)}` : "not recognised"}
                  </td>
                  <td className="px-1 py-1">
                    <textarea
                      rows={1}
                      className="input font-normal"
                      value={l.note ?? ""}
                      maxLength={GLOSSARY_NOTE_MAX_CHARS}
                      aria-label={`Glossary note for column ${l.code}`}
                      disabled={locked || !structureOpen}
                      onChange={(e) => patchLanguage(i, { note: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Enregistrer la structure. Verbe distinct de l'import, bouton
             distinct, et le seul qui touche au référentiel. ─────────────── */}
      {(dirty || saveNote) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {dirty && (
            <>
              <button
                className="btn btn-accent gap-2"
                onClick={saveTemplate}
                disabled={locked || errors.length > 0}
              >
                <Save size={14} />
                {savingTpl
                  ? "Saving…"
                  : own.mode === "copy"
                    ? "Save as this campaign's template"
                    : "Save template"}
              </button>
              <button className="btn btn-ghost" onClick={revertTemplate} disabled={locked}>
                Revert structure
              </button>
              <span className="text-[12px] text-dim">
                The structure on screen is not the one that judges yet.
              </span>
            </>
          )}
          {saveNote && !dirty && <span className="text-[12px] text-dim">{saveNote}</span>}
        </div>
      )}

      {/* ── Les visuels ─────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 border border-dashed border-bd px-3 py-2.5 text-[12.5px] text-dim transition-colors hover:border-fg hover:text-fg">
          <ImagePlus size={14} className="shrink-0" />
          <span>
            {mockups.length > 0 ? `${mockups.length} mockup(s) selected` : "Mockups (PNG/JPG) — optional"}
          </span>
          <input
            type="file"
            className="hidden"
            accept="image/*"
            multiple
            disabled={locked}
            onChange={(e) => setMockups((prev) => [...prev, ...Array.from(e.target.files ?? [])])}
          />
        </label>
        {mockups.map((m, i) => (
          <span key={`${m.name}-${i}`} className="flex items-center gap-1.5 border border-bd px-2 py-1 text-[12px]">
            <span className="break-all">{m.name}</span>
            <button
              type="button"
              aria-label={`Remove ${m.name}`}
              className="text-dim transition-colors hover:text-fg"
              disabled={locked}
              onClick={() => setMockups((prev) => prev.filter((_, j) => j !== i))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>

      {error && (
        <p className="mt-3 text-[12.5px]" style={{ color: "#b3261e" }}>
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="btn btn-accent"
          onClick={submit}
          disabled={filledCells === 0 || locked || dirty}
        >
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" /> {busy}
            </>
          ) : (
            "Import this brief"
          )}
        </button>
        <span className="text-[12px] text-dim">
          {/* Pourquoi l'import est bloqué quand la structure a bougé : le
              classeur est composé côté serveur À PARTIR DE LA STRUCTURE
              ENREGISTRÉE. Laisser importer rendrait « colonne inconnue » — un
              refus juste dont le message ne dirait rien de la cause. */}
          {dirty
            ? "Save the template first — the workbook is composed from the saved structure, not from what is on screen."
            : `${filledCells} cell${filledCells === 1 ? "" : "s"} filled · sheet "${sheet}" of ${saved.label}`}
        </span>
      </div>
    </>
  );
}
