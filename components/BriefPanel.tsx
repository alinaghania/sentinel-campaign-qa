"use client";

// Le brief = document éditorial ÉDITABLE : champs pré-remplis par l'extraction,
// tous modifiables inline et facultatifs. Le collage de texte/PDF sert à préremplir.
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import BriefTable from "@/components/BriefTable";
import type { BriefExtraction, BriefField, Campaign } from "@/lib/types";

type FieldKey = keyof Omit<BriefExtraction, "missing_fields">;

const SECTIONS: Array<{ title: string; fields: Array<[FieldKey, string]> }> = [
  {
    title: "Campaign",
    fields: [
      ["campaign_name", "Name"],
      ["email_type", "Type"],
      ["market", "Market"],
      ["send_datetime", "Send date"],
    ],
  },
  { title: "Audience", fields: [["target_audience", "Target"]] },
  {
    title: "Message",
    fields: [
      ["subject_line", "Subject line"],
      ["preheader", "Preheader"],
      ["key_message", "Key message"],
      ["offer", "Offer"],
      ["promo_code", "Promo code"],
    ],
  },
  {
    title: "Links & tracking",
    fields: [
      ["cta_label", "Primary CTA"],
      ["landing_urls", "Landing pages"],
      ["utm_campaign", "Campaign UTM"],
    ],
  },
  { title: "Legal", fields: [["legal_mentions", "Required mentions"]] },
];

const ALL_KEYS = SECTIONS.flatMap((s) => s.fields.map(([k]) => k));

const emptyField = (): BriefField => ({ value: null, quote: null, confidence: "high" });
const emptyExtraction = (): BriefExtraction =>
  Object.fromEntries([
    ...ALL_KEYS.map((k) => [k, emptyField()]),
    ["missing_fields", []],
  ]) as unknown as BriefExtraction;

export default function BriefPanel({
  campaign,
  onUpdated,
}: {
  campaign: Campaign;
  onUpdated: (c: Campaign) => void;
}) {
  const [draft, setDraft] = useState<BriefExtraction>(
    campaign.briefExtraction ?? emptyExtraction()
  );
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Langue sélectionnée dans la grille multilingue (null = extraction par défaut).
  const [selectedLang, setSelectedLang] = useState<string | null>(null);
  const [mockupZoom, setMockupZoom] = useState(false);
  const mockupRef = useRef<HTMLInputElement>(null);
  const [sfName, setSfName] = useState(campaign.salesforceCampaignName ?? "");
  // Vue du brief : formulaire par champs ("fields") ou grille fidèle à l'Excel ("table").
  const [view, setView] = useState<"fields" | "table">("fields");

  useEffect(() => {
    // Lecture locale, JAMAIS de ré-extraction au clic sur une langue :
    // on lit campaign.briefExtractions[lang] si présent, sinon l'extraction par défaut.
    const forLang = selectedLang ? campaign.briefExtractions?.[selectedLang] : undefined;
    const next = forLang ?? campaign.briefExtraction;
    if (next) setDraft(next);
  }, [campaign.briefExtraction, campaign.briefExtractions, selectedLang]);

  useEffect(() => {
    setSfName(campaign.salesforceCampaignName ?? "");
  }, [campaign.salesforceCampaignName]);

  const mockup = campaign.briefMockups?.[0];

  // Upload MANUEL d'un mockup (PJ) — quand il n'est pas dans l'Excel.
  async function uploadMockup(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/campaigns/${campaign.id}/mockup`, { method: "POST", body: fd });
    if (res.ok) onUpdated((await res.json()).campaign);
    if (mockupRef.current) mockupRef.current.value = "";
  }
  const grid = campaign.briefGrid;

  // --- préremplissage par extraction (texte collé ou PDF) ---
  async function prefill(body: BodyInit, isForm = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/brief`, {
        method: "POST",
        ...(isForm ? {} : { headers: { "Content-Type": "application/json" } }),
        body,
      });
      if (!res.ok) {
        setError((await res.json()).error ?? "Extraction failed");
        return;
      }
      const { campaign: updated } = await res.json();
      setPasting(false);
      setText("");
      onUpdated(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  // --- édition inline : sauvegarde au blur ---
  function setFieldValue(key: FieldKey, raw: string) {
    const value = raw.trim() || null;
    setDraft((prev) => ({
      ...prev,
      [key]: { value, quote: null, confidence: "high" },
    }));
  }

  async function persist() {
    const missing = ALL_KEYS.filter((k) => draft[k]?.value == null);
    const extraction: BriefExtraction = { ...draft, missing_fields: missing };
    // Si une langue est sélectionnée, on sauvegarde dans briefExtractions[lang]
    // (sans écraser l'extraction par défaut).
    const patch = selectedLang
      ? {
          briefExtractions: {
            ...(campaign.briefExtractions ?? {}),
            [selectedLang]: extraction,
          },
        }
      : { briefExtraction: extraction };
    const res = await fetch(`/api/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) onUpdated(await res.json());
  }

  async function persistSfName() {
    const value = sfName.trim() || null;
    if ((value ?? "") === (campaign.salesforceCampaignName ?? "")) return;
    const res = await fetch(`/api/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ salesforceCampaignName: value }),
    });
    if (res.ok) onUpdated(await res.json());
  }

  const empty = ALL_KEYS.filter((k) => draft[k]?.value == null).length;

  return (
    <aside className="card sticky top-20 flex max-h-[calc(100vh-6rem)] w-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {/* En-tête façon document */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="doc-title text-[26px] leading-tight">Brief</div>
            <div className="mt-1 text-[9.5px] font-bold uppercase tracking-[0.2em] text-dim">
              Ref: {campaign.id.slice(-8).toUpperCase()} · {campaign.period}
            </div>
          </div>
          <button
            className="text-[9.5px] font-bold uppercase tracking-[0.18em] text-dim underline underline-offset-4 hover:text-fg"
            onClick={() => {
              if (pasting) persist();
              else setView("fields"); // le panneau de préremplissage vit dans la vue Fields
              setPasting(!pasting);
            }}
          >
            {pasting ? "Save" : "Prefill from text / PDF / Excel"}
          </button>
        </div>

        {/* Bascule Fields / Table — la vue Table rend la grille du brief telle que dans l'Excel */}
        {grid && (
          <div className="mt-3 flex gap-1">
            {(["fields", "table"] as const).map((v) => (
              <button
                key={v}
                className={`border px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] ${
                  view === v ? "border-fg bg-fg text-bg" : "border-bd text-dim hover:text-fg"
                }`}
                onClick={() => setView(v)}
              >
                {v === "fields" ? "Fields" : "Table"}
              </button>
            ))}
          </div>
        )}

        {view === "table" && grid ? (
          <div className="mt-4">
            <BriefTable grid={grid} mockups={campaign.briefMockups} header={false} />
          </div>
        ) : (
          <>
        {/* Mockup du brief (image extraite du xlsx ou uploadée en PJ) — clic pour zoomer */}
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-dim">
              Mockup
            </span>
            <button
              className="flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-[0.14em] text-dim underline underline-offset-4 hover:text-fg"
              onClick={() => mockupRef.current?.click()}
            >
              {mockup ? "Replace" : "Upload"}
            </button>
            <input
              ref={mockupRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadMockup(f);
              }}
            />
          </div>
          {mockup ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mockup.dataUrl}
              alt={mockup.name}
              className="mt-1.5 w-full cursor-zoom-in border border-bd object-contain"
              onClick={() => setMockupZoom(true)}
            />
          ) : (
            <p className="mt-1.5 text-[11px] italic text-dim">
              No mockup — extracted from the Excel brief, or upload one manually.
            </p>
          )}
        </div>
        {mockupZoom && mockup && (
          <div
            className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6"
            onClick={() => setMockupZoom(false)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mockup.dataUrl}
              alt={mockup.name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}

        {/* Onglets de langue (grille multilingue) — lecture locale, aucune ré-extraction */}
        {grid && grid.languages.length > 0 && (
          <div className="mt-4">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-dim">
              Brief language
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <button
                className={`border px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] ${
                  selectedLang === null
                    ? "border-fg bg-fg text-bg"
                    : "border-bd text-dim hover:text-fg"
                }`}
                onClick={() => setSelectedLang(null)}
              >
                Default
              </button>
              {grid.languages.map((lang) => (
                <button
                  key={lang}
                  className={`border px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] ${
                    selectedLang === lang
                      ? "border-fg bg-fg text-bg"
                      : "border-bd text-dim hover:text-fg"
                  }`}
                  title={
                    campaign.briefExtractions?.[lang]
                      ? `${lang} extraction available`
                      : `No ${lang} extraction — default form shown`
                  }
                  onClick={() => setSelectedLang(lang)}
                >
                  {lang.replace(/\|/g, " / ")}
                </button>
              ))}
            </div>
            {selectedLang && !campaign.briefExtractions?.[selectedLang] && (
              <p className="mt-1 text-[10.5px] italic text-dim">
                No extraction yet for this language — the default form is shown.
              </p>
            )}
          </div>
        )}

        {/* Préremplissage */}
        {pasting && (
          <div className="mt-4 space-y-2 border border-bd p-3">
            <textarea
              className="input min-h-32 font-mono text-xs"
              placeholder="Paste the campaign brief here (text or HTML)…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <button
                className="btn btn-accent flex-1"
                disabled={busy || !text.trim()}
                onClick={() => prefill(JSON.stringify({ brief: text }))}
              >
                <Sparkles size={14} /> {busy ? "Extracting…" : "Extract & prefill"}
              </button>
              <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
                PDF / Excel
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.xlsx,.xlsm,.html,.txt,.eml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const fd = new FormData();
                  fd.append("file", f);
                  prefill(fd, true);
                }}
              />
            </div>
            {error && <p className="text-xs" style={{ color: "#b3261e" }}>{error}</p>}
            {busy && (
              <div className="flex items-center gap-2.5 border-t border-bd/50 pt-2.5">
                <span
                  className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border border-dim border-t-fg"
                  aria-hidden
                />
                <span className="pulse text-[9.5px] font-bold uppercase tracking-[0.18em] text-dim">
                  Importing &amp; extracting…
                </span>
              </div>
            )}
          </div>
        )}

        {/* Sections éditables */}
        <div className="mt-6 space-y-6">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="doc-section">{section.title}</h3>
              <div className="mt-2.5 space-y-2.5">
                {section.fields.map(([key, label]) => {
                  const field = draft[key] ?? emptyField();
                  return (
                    <div key={key}>
                      <div className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-dim">
                        {label}
                        {field.quote && (
                          <span
                            className="ml-1.5 normal-case tracking-normal text-dim/70"
                            title={`Source: "${field.quote}"`}
                          >
                            · extracted
                          </span>
                        )}
                      </div>
                      <textarea
                        rows={1}
                        className="mt-0.5 w-full resize-none border-0 border-b border-transparent bg-transparent p-0 text-[13.5px] leading-snug outline-none placeholder:italic placeholder:text-dim/50 focus:border-b focus:border-fg"
                        style={{ fieldSizing: "content" } as React.CSSProperties}
                        placeholder="—"
                        value={field.value ?? ""}
                        onChange={(e) => setFieldValue(key, e.target.value)}
                        onBlur={persist}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        {/* Nom de campagne Salesforce (attendu en utm_source des liens) */}
        <div className="mt-6">
          <h3 className="doc-section">Salesforce</h3>
          <div className="mt-2.5">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-dim">
              Campaign name (expected utm_source)
            </div>
            <input
              type="text"
              className="mt-0.5 w-full border-0 border-b border-transparent bg-transparent p-0 font-mono text-[12.5px] leading-snug outline-none placeholder:italic placeholder:text-dim/50 focus:border-b focus:border-fg"
              placeholder="e.g. ADHOC_GLOBAL_OTO_EMAIL_20260714_Le7BowlingBag"
              value={sfName}
              onChange={(e) => setSfName(e.target.value)}
              onBlur={persistSfName}
            />
          </div>
        </div>

        {/* Liens attendus WW / CN par bloc (issus de la grille du brief) */}
        {grid && grid.expectedLinks.length > 0 && (
          <div className="mt-6">
            <h3 className="doc-section">Expected links (WW / CN)</h3>
            <table className="mt-2.5 w-full table-fixed border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-bd text-left text-[9.5px] font-bold uppercase tracking-[0.16em] text-dim">
                  <th className="w-16 py-1 pr-2 font-bold">Block</th>
                  <th className="py-1 pr-2 font-bold">WW</th>
                  <th className="py-1 font-bold">CN</th>
                </tr>
              </thead>
              <tbody>
                {grid.expectedLinks.map((link) => (
                  <tr key={link.block} className="border-b border-bd/50 align-top">
                    <td className="py-1.5 pr-2 font-bold">{link.block}</td>
                    <td className="truncate py-1.5 pr-2 font-mono text-dim" title={link.ww}>
                      {link.ww ?? "—"}
                    </td>
                    <td className="truncate py-1.5 font-mono text-dim" title={link.cn}>
                      {link.cn ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
          </>
        )}

        {/* Pied de document */}
        <div className="mt-8 flex items-center justify-between border-t border-bd pt-3">
          <span className="text-[9.5px] font-bold uppercase tracking-[0.18em] text-dim">
            {empty === 0
              ? "Complete brief"
              : `${ALL_KEYS.length - empty}/${ALL_KEYS.length} fields — optional`}
          </span>
          <span className="text-[9.5px] font-bold uppercase tracking-[0.18em] text-dim">
            Sentinel
          </span>
        </div>
      </div>
    </aside>
  );
}
