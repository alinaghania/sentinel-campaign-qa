"use client";

// Accueil = le SUIVI : tableau des campagnes + bandeau KPI + export Excel.
import { Download, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/badges";
import type { Campaign } from "@/lib/types";

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterPeriod, setFilterPeriod] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    const res = await fetch("/api/campaigns");
    setCampaigns(await res.json());
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const filtered = (campaigns ?? []).filter(
    (c) =>
      (!filterStatus || c.status === filterStatus) &&
      (!filterPeriod || c.period === filterPeriod)
  );
  const periods = [...new Set((campaigns ?? []).map((c) => c.period))].sort().reverse();
  const kpi = {
    total: filtered.length,
    go: filtered.filter((c) => c.status === "GO" || c.status === "ENVOYE").length,
    // Compté à part, jamais fondu dans `go` ni dans `nogo` : une campagne à
    // réserves n'est ni refusée ni propre. Sans sa propre tuile elle
    // disparaîtrait des quatre compteurs tout en pesant dans `total`.
    reserves: filtered.filter((c) => c.status === "GO_AVEC_RESERVES").length,
    nogo: filtered.filter((c) => c.status === "NO_GO" || c.status === "CORRECTIONS").length,
    attente: filtered.filter(
      (c) => c.status === "BRIEF_RECU" || c.status === "EMAIL_ATTENDU" || c.status === "EN_ANALYSE"
    ).length,
  };

  // Création en UNE étape : le NOM seul. Plus d'import de fichier ici — le
  // brief se compose au tableau collable de l'étape 2.
  async function createCampaign() {
    const name = newName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("création impossible");
      const c = await res.json();
      // L'étape 2 est le TABLEAU du template, pas la fiche campagne. C'est la
      // demande littérale — après le nom, on colle son brief dans des colonnes
      // déjà nommées. Envoyer sur la fiche laissait le métier devant une
      // campagne vide sans lui dire par où continuer.
      //
      // Personne n'y est enfermé : la page porte un « Skip » vers la fiche, et
      // une fois le tableau composé elle pousse vers /brief comme un import
      // Excel ordinaire — parce que c'en est un. Le tableau ne fabrique aucune
      // grille : il compose un vrai .xlsx que /api/campaigns/[id]/brief reparse
      // avec `parseBriefGridDetailed`, donc `briefFamily` vient de la télémétrie
      // du parseur et non d'un second chemin qui aurait sa propre façon
      // d'échouer.
      router.push(`/campaigns/${c.id}/brief/paste`);
    } catch {
      setCreateError("Création impossible — réessayer.");
      setCreateBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 pt-2">
        <div className="flex items-center gap-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/letter/hello.png" alt="" className="float h-28 w-28" />
          <h1 className="doc-title text-[46px] uppercase leading-[0.95]">
            Campaign
            <br />
            Tracker
          </h1>
        </div>
        <div className="flex gap-3">
          <a
            className="flex items-center gap-2 border border-fg px-6 py-3 text-[11px] font-bold uppercase tracking-[0.18em] transition-colors hover:bg-panel2"
            href={`/api/export?${new URLSearchParams({
              ...(filterPeriod && { period: filterPeriod }),
              ...(filterStatus && { status: filterStatus }),
            })}`}
          >
            <Download size={14} /> Excel export
          </a>
          <button
            className="flex items-center gap-2 border border-fg bg-fg px-6 py-3 text-[11px] font-bold uppercase tracking-[0.18em] text-white transition-opacity hover:opacity-85"
            onClick={() => {
              // Reset systématique : sinon le nom/erreur d'une ouverture
              // précédente fuient dans la nouvelle campagne.
              setNewName("");
              setCreateError(null);
              setCreating(true);
            }}
          >
            + New campaign
          </button>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-5 gap-5">
        {[
          { label: "Total campaigns", value: kpi.total },
          { label: "Approved (GO)", value: kpi.go },
          { label: "With reservations", value: kpi.reserves },
          { label: "Fixes required", value: kpi.nogo },
          { label: "Pending", value: kpi.attente },
        ].map((k) => (
          <div key={k.label} className="border border-fg px-6 py-6">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em]">{k.label}</div>
            <div className="doc-title mt-4 text-[44px] leading-none tabular-nums">
              {String(k.value).padStart(2, "0")}
            </div>
          </div>
        ))}
      </div>

      {/* Filtres */}
      <div className="flex gap-3 pt-2">
        <select
          className="max-w-44 border border-fg bg-transparent px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] outline-none"
          value={filterPeriod}
          onChange={(e) => setFilterPeriod(e.target.value)}
        >
          <option value="">All periods</option>
          {periods.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          className="max-w-44 border border-fg bg-transparent px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] outline-none"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {[
            "BRIEF_RECU",
            "EMAIL_ATTENDU",
            "EN_ANALYSE",
            "NO_GO",
            "CORRECTIONS",
            "GO_AVEC_RESERVES",
            "GO",
            "ENVOYE",
          ].map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {/* Tableau */}
      <div className="overflow-hidden border border-fg bg-white">
        <table className="w-full text-left text-[13.5px]">
          <thead>
            <tr className="border-b-2 border-fg text-[11px] font-bold uppercase tracking-[0.14em]">
              <th className="px-4 py-3">Campaign</th>
              <th className="px-4 py-3">Period</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Decision</th>
              <th className="px-4 py-3">Versions</th>
              <th className="px-4 py-3">Send date</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {campaigns === null ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-dim">
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-dim">
                  No campaigns yet. Create one or load the demo data (
                  <code className="text-accent">npm run seed</code>).
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer border-b border-bd/50 transition-colors hover:bg-panel2"
                  onClick={() => router.push(`/campaigns/${c.id}`)}
                >
                  <td className="px-4 py-4 text-[12px] font-bold uppercase tracking-[0.08em]">
                    <Link href={`/campaigns/${c.id}`}>{c.name}</Link>
                  </td>
                  <td className="px-4 py-3 text-dim">{c.period}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3">
                    {c.humanDecision ? (
                      <span
                        className="text-[11px] font-bold uppercase tracking-[0.14em]"
                        style={c.humanDecision === "NO_GO" ? { color: "#b3261e" } : undefined}
                      >
                        {c.humanDecision === "GO" ? "Go" : "No-go"}
                      </span>
                    ) : (
                      <span className="text-xs text-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-dim">{c.versions.length}</td>
                  <td className="px-4 py-3 text-dim">{c.sendDate?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3 text-dim">
                    {c.updatedAt.slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      className="text-dim transition-colors hover:text-fg"
                      title="Delete this campaign"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Delete campaign "${c.name}"?`)) return;
                        await fetch(`/api/campaigns/${c.id}`, { method: "DELETE" });
                        load();
                      }}
                    >
                      <X size={15} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modale création */}
      {creating && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60"
          onClick={() => !createBusy && setCreating(false)}
        >
          <div className="card w-[460px] p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 font-bold">New campaign</h2>
            <input
              autoFocus
              className="input"
              placeholder="Campaign name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && createCampaign()}
              disabled={createBusy}
            />
            {createError && (
              <p className="mt-2 text-[12px]" style={{ color: "#b3261e" }}>
                {createError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setCreating(false)} disabled={createBusy}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                onClick={createCampaign}
                disabled={createBusy || !newName.trim()}
                title={!newName.trim() ? "Enter a campaign name" : undefined}
              >
                {createBusy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Creating…
                  </>
                ) : (
                  "Create"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
