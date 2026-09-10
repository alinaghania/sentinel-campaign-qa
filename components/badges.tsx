import type { CampaignStatus, Severity, Verdict } from "@/lib/types";
import { isBlocking } from "@/lib/aggregate";

// Monochrome premium : la hiérarchie passe par la typographie, pas la couleur.
export const STATUS_META: Record<CampaignStatus, { label: string }> = {
  BRIEF_RECU: { label: "Brief received" },
  EMAIL_ATTENDU: { label: "Awaiting email" },
  EN_ANALYSE: { label: "Analyzing" },
  NO_GO: { label: "No-go" },
  CORRECTIONS: { label: "Fixes" },
  GO_AVEC_RESERVES: { label: "Go — reservations" },
  GO: { label: "Go" },
  ENVOYE: { label: "Sent" },
};

export function StatusBadge({ status }: { status: CampaignStatus }) {
  const meta = STATUS_META[status] ?? { label: status };
  // GO_AVEC_RESERVES reste en contour : c'est un feu vert, mais pas un feu vert
  // franc — le plein est réservé aux états terminaux et au refus.
  const filled = status === "GO" || status === "ENVOYE" || status === "NO_GO";
  return (
    <span
      className="inline-flex items-center border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em]"
      style={{
        borderColor: "#111",
        background: filled ? "#111" : "transparent",
        color: filled ? "#fff" : "#111",
      }}
    >
      {meta.label}
    </span>
  );
}

export const SEV_META: Record<Severity, { label: string }> = {
  CRITIQUE: { label: "Critical" },
  MAJEUR: { label: "Major" },
  MINEUR: { label: "Minor" },
  OK: { label: "OK" },
};

export function SeverityBadge({ severite }: { severite: Severity }) {
  const m = SEV_META[severite];
  const isCrit = severite === "CRITIQUE";
  return (
    <span
      className="inline-flex shrink-0 items-center border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]"
      style={{
        borderColor: isCrit ? "#111" : "#d9d9d9",
        background: isCrit ? "#111" : "transparent",
        color: isCrit ? "#fff" : severite === "MAJEUR" ? "#111" : "#9a9a9a",
      }}
    >
      {m.label}
    </span>
  );
}

/** Trois états, trois rendus DISTINCTS. Le plein noir est réservé au seul
 *  verdict qui bloque : si les réserves partageaient ce rendu, le troisième
 *  état n'existerait que dans les données. */
export const VERDICT_META: Record<Verdict, { label: string }> = {
  GO: { label: "Go" },
  GO_AVEC_RESERVES: { label: "Go — reservations" },
  NO_GO: { label: "No-go" },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const blocking = isBlocking(verdict);
  const reserves = verdict === "GO_AVEC_RESERVES";
  return (
    <span
      className="inline-flex items-center px-4 py-1 text-[13px] font-black uppercase tracking-[0.18em]"
      style={{
        border: reserves ? "1px dashed #111" : "1px solid #111",
        background: blocking ? "#111" : "transparent",
        color: blocking ? "#fff" : "#111",
      }}
    >
      {VERDICT_META[verdict]?.label.toUpperCase() ?? verdict}
    </span>
  );
}
