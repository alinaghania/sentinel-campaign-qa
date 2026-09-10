"use client";

// Consultation des briefs. La CRÉATION du brief se fait à la création de la
// campagne (page Campaigns, modale "New campaign" avec upload du fichier) —
// ici on ne fait que consulter : choisir une campagne → grille multilingue,
// mockups, export PDF.
import { FileDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import BriefTable from "@/components/BriefTable";
import type { Campaign } from "@/lib/types";

export default function BrandsPage() {
  // Consultation du brief d'une campagne.
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/campaigns")
      .then((res) => (res.ok ? res.json() : []))
      .then((list: Campaign[]) => setCampaigns(list))
      .catch(() => {});
  }, []);

  // Anti-course : si l'utilisateur change vite de campagne, seule la réponse
  // de la DERNIÈRE sélection est affichée.
  const loadSeq = useRef(0);
  async function loadCampaign(id: string) {
    const seq = ++loadSeq.current;
    setSelectedCampaignId(id);
    setBriefError(null);
    if (!id) {
      setCampaign(null);
      return;
    }
    const res = await fetch(`/api/campaigns/${id}`);
    if (seq !== loadSeq.current) return;
    if (res.ok) {
      const { campaign: c } = await res.json();
      if (seq === loadSeq.current) setCampaign(c);
    } else {
      setCampaign(null);
      setBriefError("Could not load the campaign.");
    }
  }

  return (
    <div className="space-y-8">
      {/* En-tête éditorial */}
      <div className="border-b-2 border-fg pb-5">
        <h1 className="doc-title text-[34px]">Campaign brief</h1>
        <p className="mt-1 text-[12.5px] text-dim">
          Briefs are imported when a campaign is created (Campaigns → New campaign). This page is
          for browsing them.
        </p>
      </div>

      {/* Brief de campagne — consultation seule : grille multilingue fidèle à
          l'Excel + maquettes + export PDF. */}
      <section id="campaign-brief" className="scroll-mt-24 border-t-2 border-fg pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-bd pb-5">
          <div>
            <h2 className="doc-title text-[28px]">Brief</h2>
            {campaign ? (
              <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.22em] text-dim">
                REF: {campaign.name} · {campaign.period}
                {campaign.briefFileName && (
                  <span className="ml-2 border border-bd bg-panel2 px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal">
                    {campaign.briefFileName}
                  </span>
                )}
                {campaign.briefGrid?.isLikelyTemplate && (
                  <span
                    className="ml-2 border px-1.5 py-0.5 text-[10px] normal-case tracking-normal"
                    style={{ borderColor: "#b3261e", color: "#b3261e" }}
                  >
                    ⚠ looks like a blank template
                  </span>
                )}
              </div>
            ) : (
              <p className="mt-1 text-[12.5px] text-dim">Pick a campaign to browse its brief.</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input min-w-64"
              value={selectedCampaignId}
              onChange={(e) => loadCampaign(e.target.value)}
            >
              <option value="">Campaign…</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.period}
                </option>
              ))}
            </select>
            {campaign && (
              <a
                className="btn"
                href={`/api/campaigns/${campaign.id}/brief-pdf`}
                target="_blank"
                rel="noreferrer"
                title="Export the brief as PDF"
              >
                <FileDown size={14} /> Export PDF
              </a>
            )}
          </div>
        </div>
        {briefError && (
          <p className="mt-3 text-xs" style={{ color: "#b3261e" }}>{briefError}</p>
        )}

        <div className="mt-8">
          {!campaign ? (
            <p className="text-[12.5px] italic text-dim">
              Select a campaign to view its brief.
            </p>
          ) : campaign.briefGrid ? (
            // 2 colonnes : mockup EN GRAND à gauche, contenu Excel à droite.
            <div className="grid grid-cols-[minmax(260px,340px)_1fr] items-start gap-8">
              <div>
                <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-dim">
                  Mockup
                </div>
                {campaign.briefMockups?.length ? (
                  <div className="space-y-3">
                    {campaign.briefMockups.map((m, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={m.dataUrl}
                        alt={m.name}
                        // Ne JAMAIS upscaler : plafonné à la résolution native → reste net.
                        className="border border-bd object-contain"
                        style={{ width: "100%", maxWidth: m.width ? `${m.width}px` : undefined }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] italic text-dim">
                    No mockup extracted from the Excel.
                  </p>
                )}
              </div>
              <div className="min-w-0">
                <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-dim">
                  Content grid — blocks by language
                </div>
                <BriefTable grid={campaign.briefGrid} />
              </div>
            </div>
          ) : campaign.briefRaw || campaign.briefMockups?.length ? (
            // Brief PDF/PPT (pas de grille multilingue) ou grille non parsée :
            // montrer ce qu'on a plutôt qu'un faux "no brief".
            <div className="grid grid-cols-[minmax(260px,340px)_1fr] items-start gap-8">
              <div>
                <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-dim">
                  Mockup
                </div>
                {campaign.briefMockups?.length ? (
                  <div className="space-y-3">
                    {campaign.briefMockups.map((m, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={m.dataUrl}
                        alt={m.name}
                        className="border border-bd object-contain"
                        style={{ width: "100%", maxWidth: m.width ? `${m.width}px` : undefined }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] italic text-dim">No mockup in this brief.</p>
                )}
              </div>
              <div className="min-w-0 text-[13px] leading-relaxed">
                <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-dim">
                  Brief (text — no multilingual grid in this file)
                </div>
                <p className="whitespace-pre-wrap text-dim">{(campaign.briefRaw ?? "").slice(0, 4000)}</p>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px] italic text-dim">
              No brief on this campaign — it is uploaded when the campaign is created.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
