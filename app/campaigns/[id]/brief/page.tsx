"use client";

// PREVIEW + ÉDITION MANUELLE du brief juste après l'import (étape 2 de la
// création de campagne) : la grille parsée de l'Excel est corrigeable cellule
// par cellule (le brief est la SEULE vérité de la QA — une cellule mal parsée
// = faux findings). Puis "Confirm & select emails" → Inbox pour attacher les
// mails, ce qui déclenche l'analyse automatiquement.
import { ArrowRight, Check, FileSpreadsheet, ImagePlus, Loader2, Sparkles, TriangleAlert, Upload } from "lucide-react";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BriefGrid, Campaign } from "@/lib/types";

export default function BriefEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [grid, setGrid] = useState<BriefGrid | null>(null);
  const [sfName, setSfName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mockupBusy, setMockupBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Édition locale non sauvegardée : le polling du scout ne doit JAMAIS
  // remplacer la grille sous les doigts de l'utilisatrice. useRef (pas
  // useState) : la callback du setInterval lirait sinon une valeur PÉRIMÉE
  // capturée au montage de l'effet.
  const dirtyRef = useRef(false);
  const [scoutBusy, setScoutBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${id}`);
    if (!res.ok) return;
    const { campaign: c } = (await res.json()) as { campaign: Campaign };
    setCampaign(c);
    // Copie locale éditable (deep clone : on mute cellule par cellule).
    setGrid(c.briefGrid ? (JSON.parse(JSON.stringify(c.briefGrid)) as BriefGrid) : null);
    setSfName(c.salesforceCampaignName ?? "");
    dirtyRef.current = false;
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  // L'extraction LLM (nom Salesforce…) tourne en arrière-plan après l'import :
  // tant que le champ est vide, on re-vérifie quelques fois sans bloquer.
  useEffect(() => {
    if (!campaign || sfName) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/campaigns/${id}`);
      if (!res.ok) return;
      const { campaign: c } = (await res.json()) as { campaign: Campaign };
      if (c.salesforceCampaignName) {
        setSfName((prev) => prev || c.salesforceCampaignName || "");
        clearInterval(t);
      }
    }, 4000);
    const stop = setTimeout(() => clearInterval(t), 60_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
    // briefImportId dans les deps : après un "Replace brief file", le polling
    // repart pour récupérer le nom Salesforce du NOUVEAU fichier.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.id, campaign?.briefImportId]);

  // Le structure scout LLM et l'audit tournent en arrière-plan : tant que le
  // scout est "running", on rafraîchit son état + les warnings. La grille
  // locale n'est remplacée QUE si elle n'a pas d'édition en cours (dirty).
  const scoutRunning = campaign?.briefScout?.status === "running";
  useEffect(() => {
    if (!scoutRunning) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/campaigns/${id}`);
      if (!res.ok) return;
      const { campaign: c } = (await res.json()) as { campaign: Campaign };
      setCampaign((prev) =>
        prev ? { ...prev, briefScout: c.briefScout, briefParseWarnings: c.briefParseWarnings, briefGrid: c.briefGrid } : c
      );
      if (c.briefScout?.status !== "running") {
        clearInterval(t);
        if (!dirtyRef.current) {
          setGrid(c.briefGrid ? (JSON.parse(JSON.stringify(c.briefGrid)) as BriefGrid) : null);
        }
      }
    }, 4000);
    const stop = setTimeout(() => clearInterval(t), 120_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoutRunning, campaign?.briefImportId]);

  // Force le scout LLM sur le fichier importé (couvre aussi le cas d'une
  // grille plausible mais fausse que shouldScout ne détecte pas).
  async function rescout() {
    setScoutBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/rescout`, { method: "POST" });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: null }));
        throw new Error(msg ?? "rescout failed");
      }
      const { campaign: c } = (await res.json()) as { campaign: Campaign };
      setCampaign(c);
    } catch (e) {
      setError(e instanceof Error && e.message !== "rescout failed" ? e.message : "AI re-parse failed to start.");
    } finally {
      setScoutBusy(false);
    }
  }

  // Applique la grille proposée par le scout (remplace la grille affichée).
  async function applyScout() {
    setScoutBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/rescout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("Could not apply the AI parse.");
    } finally {
      setScoutBusy(false);
    }
  }

  function setCell(blockIdx: number, lang: string, value: string) {
    setGrid((g) => {
      if (!g) return g;
      const next = { ...g, blocks: g.blocks.map((b, i) => (i === blockIdx ? { ...b, valueByLang: { ...b.valueByLang, [lang]: value } } : b)) };
      return next;
    });
    setSaved(false);
    dirtyRef.current = true;
  }

  function setLink(linkIdx: number, market: string, url: string) {
    setGrid((g) => {
      if (!g) return g;
      const next = {
        ...g,
        expectedLinks: g.expectedLinks.map((l, i) => {
          if (i !== linkIdx) return l;
          const linksByMarket = { ...(l.linksByMarket ?? {}), [market]: url };
          return {
            ...l,
            linksByMarket,
            ...(market === "WW" ? { ww: url } : {}),
            ...(market === "CN" ? { cn: url } : {}),
          };
        }),
      };
      return next;
    });
    setSaved(false);
    dirtyRef.current = true;
  }

  async function save(): Promise<boolean> {
    if (!campaign) return false;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // null (et pas undefined) pour VIDER le champ côté PATCH ; briefGrid
          // omis quand absent (brief PDF/PPT sans grille — ne pas écrire null).
          salesforceCampaignName: sfName.trim() ? sfName.trim() : null,
          ...(grid ? { briefGrid: grid, expectedLanguages: grid.languages } : {}),
        }),
      });
      if (!res.ok) throw new Error();
      setSaved(true);
      dirtyRef.current = false;
      return true;
    } catch {
      setError("Save failed — retry.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function replaceBrief(file: File) {
    setReplacing(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/campaigns/${id}/brief`, { method: "POST", body: form });
      if (!res.ok) throw new Error();
      setSaved(false);
      setSfName(""); // re-rempli par load/polling avec le NOUVEAU fichier
      await load();
    } catch {
      setError("Brief import failed — unreadable file?");
    } finally {
      setReplacing(false);
    }
  }

  async function uploadMockups(files: File[]) {
    setMockupBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/campaigns/${id}/mockup`, { method: "POST", body: form });
        if (!res.ok) throw new Error();
      }
      // Recharge uniquement les mockups (ne pas écraser la grille en cours d'édition).
      const res = await fetch(`/api/campaigns/${id}`);
      if (res.ok) {
        const { campaign: c } = (await res.json()) as { campaign: Campaign };
        setCampaign((prev) => (prev ? { ...prev, briefMockups: c.briefMockups } : c));
      }
    } catch {
      setError("Mockup upload failed — PNG/JPG only.");
    } finally {
      setMockupBusy(false);
    }
  }

  async function confirmAndPickEmails() {
    if (await save()) router.push("/inbox");
  }

  if (!campaign) return <div className="py-20 text-center text-dim">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-fg pb-5">
        <div>
          <h1 className="doc-title text-[30px]">Review the brief</h1>
          <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.22em] text-dim">
            {campaign.name} · {campaign.period} — fix any badly parsed cell before attaching emails
          </div>
          {/* Provenance : les briefs Kering ont des noms très proches — afficher
              LEQUEL a été importé évite les confusions de sélecteur de fichiers. */}
          {campaign.briefFileName && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 border border-bd bg-panel2 px-2 py-1 font-mono text-[11.5px]">
              <FileSpreadsheet size={13} className="shrink-0 text-dim" />
              Imported file: <b>{campaign.briefFileName}</b>
            </div>
          )}
          {/* État du parsing : déterministe (défaut) ou assisté par IA (scout) */}
          {campaign.briefScout && (
            <div className="mt-1.5 ml-2 inline-flex items-center gap-1.5 border border-bd bg-panel2 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-dim">
              {campaign.briefScout.status === "running" ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> AI checking file structure…
                </>
              ) : campaign.briefScout.status === "applied" ? (
                <>
                  <Sparkles size={12} /> AI-assisted parsing
                  {campaign.briefScout.confidence ? ` (${Math.round(campaign.briefScout.confidence * 100)}%)` : ""}
                </>
              ) : campaign.briefScout.status === "proposed" ? (
                <>
                  <Sparkles size={12} /> AI parse ready — review &amp; apply
                </>
              ) : campaign.briefScout.status === "user_edited" ? (
                <>Parsing: AI + manual edits</>
              ) : campaign.briefScout.status === "error" || campaign.briefScout.status === "rejected" ? (
                <>AI parse unavailable — deterministic grid kept</>
              ) : (
                <>Parsing: deterministic</>
              )}
            </div>
          )}
          {/* Pertes de parsing + audit IA : plus jamais de grille fausse en silence */}
          {(campaign.briefParseWarnings?.length ?? 0) > 0 && (
            <div
              className="mt-2 flex items-start gap-2 border px-3 py-2 text-[12.5px]"
              style={{ borderColor: "#b26a00", color: "#7a4a00", background: "#fdf6ec" }}
            >
              <TriangleAlert size={15} className="mt-0.5 shrink-0" />
              {/* Les 8 premiers restent dépliés, le reste est ATTEIGNABLE.
                  L'ancien « +N more » était un cul-de-sac : mesuré sur une
                  campagne à 17 avertissements, le seul qui donne les VALEURS
                  perdues verbatim (MX='…') tombait dans le repli sans texte. Le
                  métier voyait qu'il avait perdu quelque chose, jamais QUOI.
                  Pas de tri par gravité : ces chaînes n'en portent pas, et en
                  déduire une d'après leur libellé fabriquerait un classement
                  que rien ne mesure. On les rend toutes lisibles, c'est tout. */}
              <div className="min-w-0">
                <ul className="list-disc space-y-0.5 pl-4">
                  {campaign.briefParseWarnings!.slice(0, 8).map((w, i) => (
                    <li key={i}>{w.slice(0, 220)}</li>
                  ))}
                </ul>
                {campaign.briefParseWarnings!.length > 8 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer font-semibold underline">
                      +{campaign.briefParseWarnings!.length - 8} more — show all
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {campaign.briefParseWarnings!.slice(8).map((w, i) => (
                        <li key={i + 8}>{w.slice(0, 220)}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </div>
          )}
          {campaign.briefGrid?.isLikelyTemplate && (
            <div
              className="mt-2 flex items-start gap-2 border px-3 py-2 text-[12.5px] font-semibold"
              style={{ borderColor: "#b3261e", color: "#b3261e", background: "#fdf1f0" }}
            >
              <TriangleAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                This file looks like a BLANK TEMPLATE (example texts “Dear [Name], discover…”,
                brand.com links) — not the final brief. Check that the right file was uploaded.
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Scout LLM : proposer/forcer un parsing assisté par IA. */}
          {campaign.briefScout?.status === "proposed" && (
            <button
              className="btn"
              style={{ borderColor: "#7E5BEF", color: "#5b3fd4" }}
              onClick={applyScout}
              disabled={scoutBusy}
            >
              {scoutBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Apply AI parse
              {campaign.briefScout.confidence ? ` (${Math.round(campaign.briefScout.confidence * 100)}%)` : ""}
            </button>
          )}
          {campaign.briefFilePath &&
            (campaign.briefScout?.status !== "running" ||
              // Watchdog : un "running" > 3 min = job mort (process redémarré) →
              // ré-autoriser la relance plutôt qu'un spinner éternel.
              (campaign.briefScout.startedAt &&
                Date.now() - Date.parse(campaign.briefScout.startedAt) > 180_000)) && (
            <button className="btn" onClick={rescout} disabled={scoutBusy} title="Ask the AI to re-analyze the Excel structure and propose a new grid">
              {scoutBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Re-parse with AI
            </button>
          )}
          {/* Remplacer le brief SANS recréer la campagne — l'action évidente
              quand la bannière "template vierge" s'affiche. Le re-import purge
              proprement l'ancien fichier (reset atomique côté route). */}
          <label
            className="btn cursor-pointer"
            style={campaign.briefGrid?.isLikelyTemplate ? { borderColor: "#b3261e", color: "#b3261e" } : undefined}
          >
            {replacing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {replacing ? "Importing…" : "Replace brief file"}
            <input
              type="file"
              className="hidden"
              accept=".xlsx,.xlsm,.xls,.pdf,.pptx,.ppt"
              disabled={replacing}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) replaceBrief(f);
              }}
            />
          </label>
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
            {saved ? "Saved" : "Save"}
          </button>
          <button
            className="btn"
            style={{ background: "#111", borderColor: "#111", color: "#fff" }}
            onClick={confirmAndPickEmails}
            disabled={saving}
          >
            Confirm &amp; select emails <ArrowRight size={14} />
          </button>
        </div>
      </div>
      {error && <p className="text-xs" style={{ color: "#b3261e" }}>{error}</p>}

      {/* Nom de campagne Salesforce — attendu en utm_source sur tous les liens */}
      <div className="card max-w-2xl space-y-1.5 p-4">
        <label className="text-[10px] font-bold uppercase tracking-[0.22em] text-dim">
          Salesforce campaign name (expected in utm_source)
        </label>
        <input
          className="input font-mono text-[12.5px]"
          placeholder="ex ADHOC_GLOBAL_OTO_EMAIL_20260714_Le7BowlingBag — extracting from the brief…"
          value={sfName}
          onChange={(e) => {
            setSfName(e.target.value);
            setSaved(false);
          }}
        />
      </div>

      {!grid ? (
        <div className="text-[13px]">
          <p className="italic text-dim">
            No multilingual grid in this brief (PDF/PPT) — the text extraction is used as-is.
          </p>
          {/* Sortie vers l'étape « coller le brief ». Elle est ici parce que
              c'est exactement l'état où elle sert : le fichier reçu n'a pas de
              grille, donc la QA par langue n'a rien à comparer. */}
          <button
            className="btn mt-3"
            onClick={() => router.push(`/campaigns/${id}/brief/paste`)}
          >
            Fill in the campaign template instead
          </button>
        </div>
      ) : (
        <>
          {/* Grille éditable : blocs × langues */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.12em] text-dim">
                  <th className="sticky left-0 bg-white py-2 pr-3 text-left font-bold">Block</th>
                  {grid.languages.map((lang) => (
                    <th key={lang} className="min-w-56 px-2 py-2 text-left font-bold">
                      {/* Libellé ORIGINAL du fichier (ex "MX"), pas le code interne (ES) */}
                      {grid.langLabels?.[lang] ?? lang}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.blocks.map((block, bi) => (
                  <tr key={`${block.name}-${bi}`} className="border-t border-bd align-top">
                    <td className="sticky left-0 bg-white py-2 pr-3 text-[11px] font-bold uppercase tracking-[0.08em]">
                      {block.name}
                    </td>
                    {grid.languages.map((lang) => (
                      <td key={lang} className="px-1 py-1">
                        <textarea
                          className="min-h-16 w-full resize-y border border-bd bg-white p-2 text-[12px] leading-relaxed focus:border-fg focus:outline-none"
                          value={block.valueByLang[lang] ?? ""}
                          placeholder="—"
                          onChange={(e) => setCell(bi, lang, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Liens attendus par marché */}
          {grid.expectedLinks.length > 0 && (
            <div className="space-y-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-dim">
                Expected links by market
              </div>
              {grid.expectedLinks.map((link, li) => (
                <div key={`${link.block}-${li}`} className="card space-y-2 p-3">
                  <div className="text-[11px] font-bold uppercase tracking-[0.08em]">{link.block}</div>
                  {Object.entries(link.linksByMarket ?? {}).map(([market, url]) => (
                    <div key={market} className="flex items-center gap-2">
                      <span className="w-10 shrink-0 text-[10px] font-bold uppercase text-dim">{market}</span>
                      <input
                        className="input font-mono text-[11.5px]"
                        value={url}
                        onChange={(e) => setLink(li, market, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Mockups : extraits de l'Excel quand il en contient, sinon uploadés ici
          (les briefs .xlsm STJ livrent souvent les visuels en fichiers séparés). */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-dim">Mockups</div>
          <label className="btn cursor-pointer">
            {mockupBusy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            {mockupBusy ? "Uploading…" : "Upload mockup"}
            <input
              type="file"
              className="hidden"
              accept="image/*"
              multiple
              disabled={mockupBusy}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) uploadMockups(files);
              }}
            />
          </label>
        </div>
        {campaign.briefMockups && campaign.briefMockups.length > 0 ? (
          <div className="flex flex-wrap gap-4">
            {campaign.briefMockups.map((m, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={m.dataUrl} alt={m.name} className="max-h-80 border border-bd object-contain" />
            ))}
          </div>
        ) : (
          <p className="text-[12px] italic text-dim">
            No mockup in this file — upload the visuals (HERO…) so the QA can compare them to the emails.
          </p>
        )}
      </div>
    </div>
  );
}
