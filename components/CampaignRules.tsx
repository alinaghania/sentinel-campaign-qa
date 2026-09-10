"use client";

// Éditeur de règles éditoriales AU NIVEAU CAMPAGNE : liste campaign.rules
// (BrandRule[]), ajout/suppression manuels persistés via PATCH /api/campaigns/[id].
import { useState } from "react";
import { X } from "lucide-react";
import type { BrandRule, Campaign } from "@/lib/types";

const SEVERITY_STYLES: Record<BrandRule["severity"], string> = {
  error: "border-red-300 bg-red-50 text-red-700",
  warning: "border-amber-300 bg-amber-50 text-amber-700",
  suggestion: "border-bd bg-transparent text-dim",
};

export default function CampaignRules({
  campaign,
  onUpdated,
}: {
  campaign: Campaign;
  onUpdated: (c: Campaign) => void;
}) {
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState<"error" | "warning">("warning");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rules = campaign.rules ?? [];

  async function persist(next: BrandRule[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: next }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      onUpdated(await res.json());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error — rules not saved");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    const value = text.trim();
    if (!value || busy) return;
    const rule: BrandRule = {
      id: "rule-" + Date.now().toString(36),
      title: value.slice(0, 60),
      description: value,
      category: "tone",
      engine: "llm",
      severity,
      enabled: true,
    };
    const ok = await persist([...rules, rule]);
    if (ok) setText("");
  }

  async function removeRule(id: string) {
    if (busy) return;
    await persist(rules.filter((r) => r.id !== id));
  }

  return (
    <section>
      <div className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-dim">
        Editorial rules
      </div>

      {rules.length === 0 ? (
        <p className="mt-2 text-[12px] text-dim">No campaign rules yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-start justify-between gap-3 border border-bd px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium text-fg">
                    {rule.title}
                  </span>
                  <span
                    className={`shrink-0 border px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.12em] ${SEVERITY_STYLES[rule.severity]}`}
                  >
                    {rule.severity}
                  </span>
                </div>
                {rule.description !== rule.title && (
                  <p className="mt-0.5 text-[11.5px] leading-snug text-dim">
                    {rule.description}
                  </p>
                )}
              </div>
              <button
                aria-label={`Remove rule "${rule.title}"`}
                title="Remove rule"
                disabled={busy}
                onClick={() => removeRule(rule.id)}
                className="shrink-0 text-dim hover:text-fg disabled:opacity-45"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <input
          className="input flex-1"
          placeholder="Add a rule…"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addRule();
          }}
        />
        <select
          className="input w-28"
          value={severity}
          disabled={busy}
          onChange={(e) => setSeverity(e.target.value as "error" | "warning")}
        >
          <option value="error">Error</option>
          <option value="warning">Warning</option>
        </select>
        <button className="btn" disabled={busy || !text.trim()} onClick={addRule}>
          Add
        </button>
      </div>

      {error && <p className="mt-2 text-[11.5px] text-red-600">{error}</p>}
    </section>
  );
}
