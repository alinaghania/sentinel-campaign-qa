// Page de référence du brief : quelle cellule du classeur porte quoi.
//
// Composant SERVEUR. Il lit le template EFFECTIF — `resolveTemplate()` et non
// `DEFAULT_TEMPLATE`, depuis que le référentiel est éditable : cette page dit
// au métier « le sujet va en C7 », et le lui dire depuis le code pendant que le
// moteur juge sur une édition enregistrée serait la pire des deux erreurs, une
// consigne fausse donnée avec assurance.
//
// Aucune adresse n'est écrite ici — toutes viennent de `layout()`, la même
// fonction qui génère le classeur téléchargeable. Écrire "C7" à la main dans
// cette page créerait une seconde source de vérité qui se périmerait sans bruit.
import { AlertTriangle, FileDown, SlidersHorizontal } from "lucide-react";
import { BRIEF_SHEET, layout, type BriefTemplateFieldKind } from "@/lib/brief-template";
import { canonLang, LANG_LABEL } from "@/lib/lang-codes";
import { resolveTemplate } from "@/lib/template-resolve";

export const metadata = { title: "Brief template — Sentinel" };

const KIND_HINT: Record<BriefTemplateFieldKind, string> = {
  text: "Translated copy",
  url: "Link — checked against the email",
  meta: "Brief metadata — not email content",
};

export default async function BriefTemplatePage() {
  const resolved = await resolveTemplate();
  const tpl = resolved.template;
  const lay = layout(tpl);

  // Langues que Sentinel sait RELIRE, mesuré et non supposé : une colonne dont
  // le code canonique est absent de LANG_LABEL est écartée à la lecture du
  // classeur (lib/brief-grid.ts:236-237), et deux colonnes qui partagent un
  // code canonique se recouvrent. Annoncer "remplissez MX ici" sans le dire
  // ferait de cette page une consigne que l'outil ne peut pas honorer.
  const seen = new Set<string>();
  const readable = new Map<string, "read" | "collides" | "unsupported">();
  for (const code of tpl.languageColumns) {
    const canon = canonLang(code);
    if (!canon || !(canon in LANG_LABEL)) {
      readable.set(code, "unsupported");
      continue;
    }
    readable.set(code, seen.has(canon) ? "collides" : "read");
    seen.add(canon);
  }
  const notRead = tpl.languageColumns.filter((c) => readable.get(c) !== "read");

  // Libellés alternatifs acceptés, LUS du référentiel et non recopiés : un
  // libellé qui répond à plusieurs champs est une décision prise dans le code,
  // et le métier doit pouvoir la lire là où il lit le reste du template. La
  // taire ferait de la reconnaissance de "Hero Asset / CTA URL" une faveur
  // invisible — accordée dans un fichier, invérifiable depuis l'écran.
  const aliasRows = new Map<string, string[]>();
  for (const f of tpl.fields) {
    for (const a of f.aliases ?? []) aliasRows.set(a, [...(aliasRows.get(a) ?? []), f.label]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="eyebrow">Campaign brief</p>
          <h1 className="doc-title text-[32px]">{tpl.label}</h1>
          <p className="mt-1 text-[13px] text-dim">
            Fill sheet <span className="font-mono font-bold text-fg">{BRIEF_SHEET}</span> at the exact
            cells below. The structure never changes — only the content does.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <a href="/brief-template/edit" className="btn btn-ghost gap-2">
            <SlidersHorizontal size={14} />
            Edit template
          </a>
          <a href="/api/brief-template/download" className="btn btn-accent gap-2">
            <FileDown size={14} />
            Download blank template
          </a>
        </div>
      </div>

      {/* TROISIÈME ÉTAT, et le seul qui vaille un bandeau rouge : une édition
          EXISTE et ne peut pas mesurer, donc on juge avec le template du code.
          Sans cette phrase, l'écran afficherait paisiblement le référentiel par
          défaut et quelqu'un croirait appliquer une politique enregistrée qui ne
          s'applique pas. C'est un silence qui ressemble à un feu vert. */}
      {resolved.source === "stored_invalid" && (
        <div className="card flex gap-3 border-l-4 border-l-[color:var(--critical)] p-4">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="text-[12px]">
            <p className="font-bold">
              A saved edit of this template cannot be used, so the built-in reference is being
              applied instead. What you see below is NOT what was saved.
            </p>
            <ul className="mt-1.5 space-y-1 text-dim">
              {resolved.problems
                .filter((p) => p.severity === "error")
                .map((p, i) => (
                  <li key={i}>{p.message}</li>
                ))}
            </ul>
            <p className="mt-1.5 text-dim">
              Open <a href="/brief-template/edit" className="underline">Edit template</a> to fix it,
              or delete the edit to keep the built-in reference on purpose.
            </p>
          </div>
        </div>
      )}

      <div className="card p-4">
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-[12px]">
          <span>
            <span className="text-dim">Channel</span>{" "}
            <span className="font-mono font-bold">{tpl.channel}</span>
          </span>
          <span>
            <span className="text-dim">Version</span>{" "}
            <span className="font-mono font-bold">v{tpl.version}</span>
          </span>
          <span>
            <span className="text-dim">Header row</span>{" "}
            <span className="font-mono font-bold">{tpl.headerRow + 1}</span>
          </span>
          <span>
            <span className="text-dim">Fields</span>{" "}
            <span className="font-mono font-bold">{lay.rows.length}</span>
          </span>
          <span>
            <span className="text-dim">Language columns</span>{" "}
            <span className="font-mono font-bold">{tpl.languageColumns.length}</span>
          </span>
        </div>
      </div>

      {/* Réserve affichée SUR la page, pas dans une note de bas de page : le
          métier remplirait sinon des colonnes que l'analyse n'ouvre jamais. */}
      {notRead.length > 0 && (
        <div className="card flex gap-3 border-l-4 border-l-[color:var(--major)] p-4">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="text-[12px]">
            <p className="font-bold">
              {notRead.length} of the {tpl.languageColumns.length} language columns are not read
              back by the QA today.
            </p>
            <ul className="mt-1.5 space-y-1 text-dim">
              {notRead.map((code) => (
                <li key={code}>
                  <span className="font-mono font-bold text-fg">{code}</span>{" "}
                  {readable.get(code) === "unsupported"
                    ? "— no language code known to the analysis: the column is skipped when the workbook is read."
                    : `— shares a canonical code with an earlier column (${canonLang(code)}): only the first one is kept.`}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-dim">
              Fill them anyway if the market needs them — they are part of the brief. They are
              simply not compared against the email yet.
            </p>
          </div>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="doc-section">Where each field goes</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-bd text-left">
                <th className="px-3 py-2 font-bold">Field</th>
                <th className="px-3 py-2 font-bold">
                  Label cell
                  <span className="block font-normal text-dim">column FIELD</span>
                </th>
                <th className="px-3 py-2 font-bold">
                  Master cell
                  <span className="block font-normal text-dim">column VALUE</span>
                </th>
                <th className="px-3 py-2 font-bold">Type</th>
                <th className="px-3 py-2 font-bold">Required</th>
              </tr>
            </thead>
            <tbody>
              {lay.rows.map((row) => (
                <tr key={row.key} className="border-b border-bd last:border-0 align-top">
                  <td className="px-3 py-2">
                    <div className="font-bold">{row.label}</div>
                    {row.description && (
                      <div className="mt-0.5 max-w-md text-dim">{row.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono font-bold">{row.fieldCell}</td>
                  <td className="px-3 py-2 font-mono font-bold">{row.valueCell}</td>
                  <td className="px-3 py-2 text-dim">{KIND_HINT[row.kind]}</td>
                  <td className="px-3 py-2">{row.required ? "Yes" : "Optional"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {aliasRows.size > 0 && (
        <section className="space-y-3">
          <h2 className="doc-section">Labels accepted in place of the ones above</h2>
          <p className="text-[12px] text-dim">
            Markets do not always split a row the way the template does. These labels are
            recognised as written. When one of them answers several fields at once, the QA says
            so on the report — the fields are counted as present, but their contents cannot be
            checked against one another, because they share a single cell.
          </p>
          <div className="card overflow-x-auto p-0">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-bd text-left">
                  <th className="px-3 py-2 font-bold">Label written in the brief</th>
                  <th className="px-3 py-2 font-bold">Answers</th>
                </tr>
              </thead>
              <tbody>
                {[...aliasRows.entries()].map(([alias, labels]) => (
                  <tr key={alias} className="border-b border-bd last:border-0">
                    <td className="px-3 py-2 font-bold">{alias}</td>
                    <td className="px-3 py-2 text-dim">
                      {labels.join(" + ")}
                      {labels.length > 1 && " (one cell for both)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="doc-section">Where each translation goes</h2>
        <p className="text-[12px] text-dim">
          One column per language, starting at{" "}
          <span className="font-mono font-bold text-fg">{lay.langHeaderCells[tpl.languageColumns[0]]}</span>.
          Only translatable fields are listed — URLs and brief metadata are filled once, in the
          VALUE column.
        </p>
        <div className="card overflow-x-auto p-0">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-bd text-left">
                <th className="sticky left-0 bg-panel px-3 py-2 font-bold">Field</th>
                {tpl.languageColumns.map((code) => (
                  <th key={code} className="px-3 py-2 font-bold whitespace-nowrap">
                    <span className={readable.get(code) === "read" ? "" : "text-dim"}>{code}</span>
                    <span className="block font-mono text-[10px] font-normal text-dim">
                      {lay.langHeaderCells[code]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lay.rows
                .filter((r) => r.translatable)
                .map((row) => (
                  <tr key={row.key} className="border-b border-bd last:border-0">
                    <td className="sticky left-0 bg-panel px-3 py-2 font-bold whitespace-nowrap">
                      {row.label}
                    </td>
                    {tpl.languageColumns.map((code) => (
                      <td
                        key={code}
                        className={`px-3 py-2 font-mono ${
                          readable.get(code) === "read" ? "font-bold" : "text-dim"
                        }`}
                      >
                        {row.langCells[code]}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[11px] text-dim">
        Reference extracted from <span className="font-mono">{tpl.source}</span>, version{" "}
        {tpl.version} of {new Date(tpl.updatedAt).toISOString().slice(0, 10)}, revision{" "}
        <span className="font-mono">{resolved.revision}</span>
        {resolved.source === "code" && " (built-in, never edited)"}. The downloadable workbook is
        generated from this same reference, so the two cannot drift apart. The revision is what
        reports record: two verdicts that carry different revisions were not measured against the
        same template, even when both say “conformant”.
      </p>
    </div>
  );
}
