"use client";

// Boîte de réception QA : vraies connexions Gmail + Outlook, sync, matching
// email ↔ campagne (auto si score haut, confirmation 1 clic sinon).
// Affichage dense type Gmail : expéditeur en gras, sujet + aperçu, heure à droite,
// étoile favori, recherche client-side et pré-sélection de campagne suggérée.
import { ArrowRight, RefreshCw, Search, Star, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ProviderLogo from "@/components/ProviderLogo";
import { matchCampaignForEmail } from "@/lib/match-campaign";
import type { Campaign, InboxEmail, MailboxConnection } from "@/lib/types";

type LightEmail = Omit<InboxEmail, "html" | "rawMime"> & {
  hasHtml: boolean;
  sizeKB?: number;
  snippet?: string;
};

/** Time if today, otherwise short date — like Gmail. */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function InboxContent() {
  const [emails, setEmails] = useState<LightEmail[]>([]);
  const [connections, setConnections] = useState<MailboxConnection[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchCampaignId, setBatchCampaignId] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [query, setQuery] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  // Filtre par campagne : "" = toutes, "__none" = non rattachés, sinon un id.
  const [filterCampaign, setFilterCampaign] = useState("");
  // Choix "Attach to…" faits à la main par l'utilisateur (priment sur la suggestion)
  const [attachSel, setAttachSel] = useState<Record<string, string>>({});
  // Transport de la boîte Gmail. null = pas encore connu : on garde alors le
  // bouton OAuth, seul comportement sûr si la réponse n'arrive jamais.
  const [transport, setTransport] = useState<"imap" | "gmail" | null>(null);
  const search = useSearchParams();
  const router = useRouter();

  const load = useCallback(async () => {
    const [iRes, cRes] = await Promise.all([fetch("/api/inbox"), fetch("/api/campaigns")]);
    if (iRes.ok) {
      const { emails: e, connections: c } = await iRes.json();
      setEmails(e);
      setConnections(c);
    }
    if (cRes.ok) setCampaigns(await cRes.json());
    setLoaded(true);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const sync = useCallback(async () => {
    setSyncing(true);
    await fetch("/api/inbox/sync", { method: "POST" }).catch(() => {});
    setSyncing(false);
    load();
  }, [load]);

  // Synchronisation continue : au chargement puis toutes les 60s tant que la page est ouverte
  useEffect(() => {
    sync();
    const t = setInterval(sync, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Une seule requête au montage : le transport ne peut changer qu'au
  // redéploiement, le rafraîchir toutes les 60s avec le reste ne servirait à rien.
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/inbox/sync").catch(() => null);
      if (!res?.ok) return;
      const data: { transport?: "imap" | "gmail" } = await res.json();
      if (data.transport) setTransport(data.transport);
    })();
  }, []);

  // Auto-prefill : campagne suggérée (heuristique) pour chaque mail non rattaché
  const suggestions = useMemo(() => {
    const m: Record<string, string> = {};
    if (campaigns.length === 0) return m;
    for (const e of emails) {
      if (e.campaignId) continue;
      const match = matchCampaignForEmail(e, campaigns);
      if (match) m[e.id] = match.campaignId;
    }
    return m;
  }, [emails, campaigns]);

  const conn = (p: "gmail" | "outlook") => connections.find((c) => c.provider === p);

  async function attach(emailId: string, campaignId: string) {
    const res = await fetch(`/api/inbox/${emailId}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId }),
    });
    if (res.ok) {
      const { campaignId: cid } = await res.json();
      // On reste sur l'Inbox : le mail garde sa campagne (filtrable + modifiable).
      setEmails((prev) => prev.map((e) => (e.id === emailId ? { ...e, campaignId: cid } : e)));
    }
  }

  async function toggleFavorite(id: string) {
    // Optimiste : bascule locale immédiate, rollback si l'API échoue
    setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, favorite: !e.favorite } : e)));
    const res = await fetch(`/api/inbox/${id}/favorite`, { method: "POST" }).catch(() => null);
    if (!res?.ok) {
      setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, favorite: !e.favorite } : e)));
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Filtre client-side : recherche (sujet + expéditeur) + favoris seulement
  const q = query.trim().toLowerCase();
  const visible = emails.filter((e) => {
    if (favOnly && !e.favorite) return false;
    if (filterCampaign === "__none" && e.campaignId) return false;
    if (filterCampaign && filterCampaign !== "__none" && e.campaignId !== filterCampaign) return false;
    if (!q) return true;
    return e.subject.toLowerCase().includes(q) || e.from.toLowerCase().includes(q);
  });

  const allSelected = visible.length > 0 && visible.every((e) => selectedIds.has(e.id));

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) visible.forEach((e) => next.delete(e.id));
      else visible.forEach((e) => next.add(e.id));
      return next;
    });
  }

  async function attachBatch() {
    if (!batchCampaignId || selectedIds.size === 0) return;
    setAttaching(true);
    const res = await fetch("/api/inbox/attach-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId: batchCampaignId, inboxIds: [...selectedIds] }),
    }).catch(() => null);
    setAttaching(false);
    if (res?.ok) {
      setEmails((prev) => prev.map((e) => (selectedIds.has(e.id) ? { ...e, campaignId: batchCampaignId } : e)));
      setSelectedIds(new Set());
      // L'analyse des mails rattachés démarre AUTOMATIQUEMENT côté serveur →
      // on emmène l'utilisateur sur la campagne pour suivre la progression live.
      router.push(`/campaigns/${batchCampaignId}`);
    }
  }

  const favCount = emails.filter((e) => e.favorite).length;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <h1 className="text-[22px] font-black uppercase tracking-[0.18em]">Inbox</h1>
        <button className="btn" onClick={sync} disabled={syncing} title="Sync now">
          <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
        </button>
      </div>

      {search.get("error") && (
        <div className="card border-crit/40 bg-crit/10 px-4 py-2.5 text-[13px] text-crit">
          Connection error: {decodeURIComponent(search.get("error")!)}
        </div>
      )}

      {/* Connexions */}
      <div className="grid grid-cols-2 gap-3">
        {(
          [
            ["gmail", "Gmail", "/api/auth/google"],
            ["outlook", "Outlook", "/api/auth/outlook"],
          ] as const
        ).map(([key, label, authUrl]) => {
          const c = conn(key);
          // En IMAP, la boîte est ouverte avec un mot de passe d'application : il
          // n'y a plus aucun consentement OAuth à redonner, et proposer
          // "Reconnect" enverrait l'utilisatrice sur un flux devenu inutile — y
          // compris en erreur, où c'est le mot de passe qu'il faut régénérer (le
          // message du store le dit), pas le jeton.
          const oauthless = key === "gmail" && transport === "imap";
          return (
            <div key={key} className="card flex items-center gap-3 px-4 py-3">
              <span className="grid h-9 w-9 place-items-center">
                <ProviderLogo provider={key} size={26} />
              </span>
              <div className="flex-1">
                <div className="text-[13.5px] font-bold">{label}</div>
                <div className="text-xs text-dim">
                  {c?.status === "connected"
                    ? (c.email ?? "connected")
                    : c?.status === "error"
                      ? c.error
                      : "Not connected"}
                </div>
              </div>
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  background:
                    c?.status === "connected"
                      ? "var(--ok)"
                      : c?.status === "error"
                        ? "var(--crit)"
                        : "var(--border)",
                }}
              />
              {oauthless ? (
                <span
                  className="text-[11px] text-dim"
                  title="IMAP app password — this connection does not expire after 7 days"
                >
                  Permanent
                </span>
              ) : (
                <a className="btn" href={authUrl}>
                  {c?.status === "connected" ? "Reconnect" : "Connect"}
                </a>
              )}
            </div>
          );
        })}
      </div>

      {/* Recherche + filtre favoris */}
      <div className="card flex flex-wrap items-center gap-3 px-4 py-2.5">
        <div className="flex min-w-56 flex-1 items-center gap-2">
          <Search size={14} className="shrink-0 text-dim" />
          <input
            className="input w-full border-0 bg-transparent py-1 text-[13px] shadow-none focus:ring-0"
            type="search"
            placeholder="Search (subject, sender)…"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
          />
          {query && (
            <button className="text-dim hover:text-fg" title="Clear search" onClick={() => setQuery("")}>
              <X size={14} />
            </button>
          )}
        </div>
        <button
          className={`btn py-1 text-xs ${favOnly ? "border-fg bg-fg text-bg" : ""}`}
          onClick={() => setFavOnly((v) => !v)}
          title="Show favorites only"
        >
          <Star size={13} fill={favOnly ? "currentColor" : "none"} />
          Favorites{favCount > 0 ? ` (${favCount})` : ""}
        </button>
        <select
          className="input max-w-52 py-1 text-xs"
          value={filterCampaign}
          onChange={(ev) => setFilterCampaign(ev.target.value)}
          title="Filter by campaign"
        >
          <option value="">All campaigns</option>
          <option value="__none">Unattached</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="text-xs text-dim">
          {visible.length}/{emails.length} email{emails.length > 1 ? "s" : ""}
        </span>
      </div>

      {/* Barre d'action : rattachement groupé */}
      {selectedIds.size > 0 && (
        <div className="card flex flex-wrap items-center gap-3 px-4 py-2.5">
          <span className="text-[13px] font-bold">
            {selectedIds.size} selected
          </span>
          <select
            className="input max-w-64 py-1 text-xs"
            value={batchCampaignId}
            onChange={(ev) => setBatchCampaignId(ev.target.value)}
          >
            <option value="">Choose a campaign…</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            className="btn py-1 text-xs"
            disabled={!batchCampaignId || attaching}
            onClick={attachBatch}
            title="Attach the selected emails to the campaign"
          >
            {attaching ? "Attaching…" : <>Attach {selectedIds.size} selected <ArrowRight size={13} /></>}
          </button>
          <button
            className="text-xs text-dim hover:underline"
            onClick={() => setSelectedIds(new Set())}
          >
            Deselect all
          </button>
        </div>
      )}

      {/* Emails — liste dense type Gmail */}
      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-bd px-4 py-2 text-xs uppercase tracking-wide text-dim">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleSelectAll}
            title="Select all (visible emails)"
          />
          <span>Messages</span>
        </div>
        {visible.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13.5px] text-dim">
            {!loaded
              ? "Loading inbox…"
              : emails.length === 0
                ? "No emails yet. Connect a mailbox, then send yourself an SFMC test."
                : "No emails match the filter."}
          </div>
        ) : (
          <ul>
            {visible.map((e) => {
              const matched = campaigns.find((c) => c.id === e.campaignId);
              const suggested = attachSel[e.id] ?? suggestions[e.id] ?? "";
              return (
                <li
                  key={e.id}
                  className="flex items-center gap-3 border-b border-bd/50 px-4 py-1.5 text-[13px] hover:bg-bd/20"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(e.id)}
                    onChange={() => toggleSelected(e.id)}
                    title="Select this email"
                  />
                  <button
                    className={e.favorite ? "text-[var(--gold)]" : "text-dim hover:text-[var(--gold)]"}
                    title={e.favorite ? "Remove from favorites" : "Add to favorites"}
                    onClick={() => toggleFavorite(e.id)}
                  >
                    <Star size={15} fill={e.favorite ? "currentColor" : "none"} />
                  </button>
                  <ProviderLogo provider={e.provider} size={16} />
                  <span className="w-40 shrink-0 truncate font-bold" title={e.from}>
                    {e.from}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{e.subject}</span>
                    {e.snippet && <span className="text-dim"> — {e.snippet}</span>}
                  </span>
                  {e.language && (
                    <span className="shrink-0 text-[10px] font-bold uppercase text-dim">
                      {e.language}
                    </span>
                  )}
                  <span className="flex shrink-0 items-center gap-1.5">
                    {/* Un seul menu : campagne actuelle si rattaché, sinon suggestion.
                        Modifiable à tout moment (attache/ré-assigne au changement). */}
                    <select
                      className={`input max-w-44 py-0.5 text-xs ${matched ? "border-ok/60" : ""}`}
                      value={attachSel[e.id] ?? e.campaignId ?? suggested}
                      title="Attach to a campaign — change it anytime"
                      disabled={!e.hasHtml}
                      onChange={(ev) => {
                        const cid = ev.target.value;
                        setAttachSel((prev) => ({ ...prev, [e.id]: cid }));
                        if (cid) attach(e.id, cid);
                      }}
                    >
                      <option value="">Attach to…</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    {matched && (
                      <span className="text-[9.5px] font-bold uppercase text-ok" title="Attached">
                        ✓
                      </span>
                    )}
                  </span>
                  <span
                    className="w-14 shrink-0 text-right text-xs text-dim"
                    title={e.receivedAt.slice(0, 16).replace("T", " ")}
                  >
                    {fmtWhen(e.receivedAt)}
                  </span>
                  <button
                    className="shrink-0 text-dim transition-colors hover:text-crit"
                    title="Remove this email from the QA inbox"
                    onClick={async () => {
                      await fetch(`/api/inbox/${e.id}`, { method: "DELETE" });
                      load();
                    }}
                  >
                    <X size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-dim">Loading…</div>}>
      <InboxContent />
    </Suspense>
  );
}
