"use client";

// Vue analyse : agents en direct (SSE) → se morphe en rapport à la fin.
import { AlertTriangle, Check, CheckCircle2, Lightbulb, RotateCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VerdictBadge } from "@/components/badges";
import { isBlocking } from "@/lib/aggregate";
import { diffSegments, IS_URL_RE } from "@/lib/diff";
import { titleForFinding } from "@/lib/finding-titles";
// Import de VALEUR volontaire : les trois catalogues sont des modules de
// données pures (aucun built-in Node), et c'est le compilateur qui garantit
// alors que les ids affichés viennent bien du catalogue et non d'une liste
// recopiée ici — une liste recopiée nommerait tôt ou tard une règle qui
// n'existe plus.
import { ALL_RULE_BY_ID } from "@/lib/rule-registry";
import type { AgentRun, AnalysisReport, Finding } from "@/lib/types";

// Data values from lib stay untouched — only the display label is English.
const LINK_STATUS_LABEL: Record<string, string> = {
  ok: "ok",
  casse: "broken",
  suspect: "suspect",
  non_verifiable: "unverifiable",
  non_teste: "not tested",
};

const AGENT_DISPLAY: Record<string, string> = {
  "Assets & images": "Assets & images",
  "Liens & redirections": "Links & redirects",
  "Tracking & UTM": "Tracking & UTM",
  "Cohérence brief ↔ email": "Brief ↔ email consistency",
  "Conformité guidelines": "Guidelines compliance",
  "Anomalies & oublis": "Anomalies & omissions",
  // Trois lignes que cette table ignorait, et qui s'affichaient donc en
  // français sur un écran anglais. Libellés relevés dans le code qui les
  // émet — cités par symbole et par littéral, pas par numéro de ligne :
  // lib/agents.ts `WORKERS` (l'entrée `runner: "translation"`), et dans
  // lib/analyze.ts les littéraux `Rendu réel (` et `"Juge vision"`.
  "Traduction (arbitrage)": "Translation (arbitration)",
  "Rendu réel": "Real rendering",
  "Juge vision": "Vision judge",
};

// Le libellé du rendu réel est CONSTRUIT à l'exécution avec le client mail
// (lib/analyze.ts, `const label = \`Rendu réel (…)\``) : aucune table exacte ne
// peut le contenir — c'est pourquoi il y a un motif ici. Trois états,
// comme partout ici : libellé connu, libellé connu par motif, libellé inconnu
// rendu tel quel plutôt que remplacé par une approximation.
function agentDisplay(name: string): string {
  const exact = AGENT_DISPLAY[name];
  if (exact) return exact;
  const built = /^Rendu réel\s*\((.+)\)$/.exec(name);
  if (built) return `Real rendering (${built[1]})`;
  return name;
}

interface AgentState {
  // "skipped" manquait : le serveur l'émet en douze endroits
  // (`grep -c 'status: "skipped"' lib/analyze.ts`), mais l'event SSE passe par
  // un JSON.parse, donc rien ne le signalait au compilateur — et un agent
  // délibérément sauté retombait dans la branche par défaut, affiché
  // « pending ». Il n'attendait rien.
  status: "pending" | "running" | "done" | "error" | "skipped";
  detail?: string;
  findingsCount?: number;
}

export default function AnalysisView({
  campaignId,
  versionId,
  existingReport,
  onDone,
  startSignal = 0,
}: {
  campaignId: string;
  versionId: string;
  existingReport: AnalysisReport | null;
  onDone: () => void;
  startSignal?: number;
}) {
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentState>>({});
  const [liveFindings, setLiveFindings] = useState<Finding[]>([]);
  const [verdict, setVerdict] = useState<AnalysisReport["verdict"] | null>(null);
  const [counters, setCounters] = useState<AnalysisReport["counters"] | null>(null);
  const [summary, setSummary] = useState("");
  const [report, setReport] = useState<AnalysisReport | null>(existingReport);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => setReport(existingReport), [existingReport]);

  // Persistance cross-page : le jobId du run en cours est mémorisé en
  // localStorage pour pouvoir se rattacher au job (replay+tail) au remontage.
  const storageKey = `analysis:${campaignId}:${versionId}`;

  // Une requête de run = { n incrémental, fresh, jobId? }. jobId présent =
  // reconnexion à un job existant (replay+tail, PAS de relance d'analyse).
  // Le cycle de vie de l'EventSource est possédé par l'effet ci-dessous
  // (StrictMode-safe : le cleanup ferme la connexion ET l'effet se relance
  // en en ouvrant une neuve).
  const [runReq, setRunReq] = useState<{ n: number; fresh: boolean; jobId?: string }>({
    n: 0,
    fresh: false,
  });
  const start = useCallback((fresh: boolean) => {
    setRunReq((r) => ({ n: r.n + 1, fresh }));
  }, []);

  // Au montage : si un job était en cours pour cette version, se rattacher
  // au lieu de relancer (le serveur rejoue les events puis "tail" le job).
  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) {
      setRunReq((r) => ({ n: r.n + 1, fresh: false, jobId: stored }));
    }
    // uniquement au montage / changement de version
  }, [storageKey]);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (runReq.n === 0) return; // aucun run demandé

    setRunning(true);
    setError(null);
    setLiveFindings([]);
    setVerdict(null);
    setCounters(null);
    setSummary("");
    setLogs([]);
    setStage("Starting…");
    // Aucune amorce : la grille ne montre que les agents qui ont PARLÉ.
    //
    // Il y avait ici une liste de six libellés recopiée à la main depuis
    // lib/agents.ts `WORKERS`, exactement la seconde-liste contre laquelle
    // lib/agent-catalog.ts met en garde en tête de fichier — et elle avait déjà
    // divergé : WORKERS en compte sept, "Traduction (arbitrage)" manquait.
    //
    // Elle n'a pas été remplacée par un import de lib/agent-catalog.ts, qui
    // serait pire ici : ce catalogue est indexé par CLÉ avec des libellés
    // anglais, alors que cette grille est indexée par le libellé français que
    // le SSE émet (`e.agent` = `w.label`). Les deux ne s'apparient pas — on
    // aurait des lignes amorcées qu'aucun event ne rejoint jamais (« pending »
    // à vie) doublées des lignes créées par le SSE. Le catalogue nomme en plus
    // `vision`, qui n'est pas un worker, et tait `translation`, qui en est un.
    //
    // Et lib/agents.ts ne peut pas être importé ici : il tire fs, path et la clé
    // Foundry. Aucune liste juste n'est donc atteignable côté client — alors la
    // grille n'en affirme aucune. Le coût est une grille vide pendant les
    // premières secondes, sous le stage et le terminal qui, eux, parlent déjà.
    setAgents({});

    let closedByUs = false;
    const url = runReq.jobId
      ? `/api/campaigns/${campaignId}/analyze?versionId=${versionId}&jobId=${encodeURIComponent(runReq.jobId)}&cursor=0`
      : `/api/campaigns/${campaignId}/analyze?versionId=${versionId}${runReq.fresh ? "&fresh=1" : ""}`;
    const es = new EventSource(url);
    esRef.current = es;
    es.onmessage = async (ev) => {
      const e = JSON.parse(ev.data);
      switch (e.type) {
        case "job":
          // Job créé côté serveur : mémoriser pour pouvoir se rattacher
          // après navigation/refresh (l'analyse continue en tâche de fond).
          window.localStorage.setItem(storageKey, e.jobId);
          break;
        case "log":
          setLogs((prev) => [...prev.slice(-400), e.line]);
          break;
        case "stage":
          setStage(e.detail ?? e.stage);
          break;
        case "agent":
          setAgents((prev) => ({
            ...prev,
            [e.agent]: { status: e.status, detail: e.detail, findingsCount: e.findingsCount },
          }));
          break;
        case "finding":
          setLiveFindings((prev) => [...prev, e.finding]);
          break;
        case "verdict":
          setVerdict(e.verdict);
          setCounters(e.counters);
          setStage(null);
          break;
        case "summary-delta":
          setSummary((prev) => prev + e.text);
          break;
        case "done": {
          closedByUs = true;
          es.close();
          window.localStorage.removeItem(storageKey);
          const res = await fetch(`/api/reports/${e.reportId}`);
          if (res.ok) setReport(await res.json());
          setRunning(false);
          onDoneRef.current();
          break;
        }
        case "error":
          closedByUs = true;
          setError(e.message);
          setRunning(false);
          window.localStorage.removeItem(storageKey);
          es.close();
          break;
      }
    };
    es.onerror = () => {
      // L'analyse continue côté serveur (job en tâche de fond) : le jobId
      // reste en localStorage pour permettre le rattachement au remontage.
      if (!closedByUs) setError("Connection lost — reopen the page to resume the running analysis");
      es.close();
      setRunning(false);
    };

    return () => {
      closedByUs = true;
      es.close();
    };
    // campaignId/versionId lus au moment du run ; on ne relance que sur runReq
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runReq]);

  // Déclenchement depuis le bouton play de la fiche campagne
  const lastSignal = useRef(0);
  useEffect(() => {
    if (startSignal > 0 && startSignal !== lastSignal.current) {
      lastSignal.current = startSignal;
      start(false);
    }
  }, [startSignal, start]);

  async function review(findingId: string) {
    if (!report) return;
    const current = report.findings.find((f) => f.id === findingId)?.review;
    const res = await fetch(`/api/reports/${report.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ findingId, review: current ? null : "corrige" }),
    });
    if (res.ok) setReport(await res.json());
    onDone();
  }

  // ---------- RENDU ----------
  if (!running && !report) {
    return (
      <div className="card grid place-items-center gap-3 p-12 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/letter/ready.png" alt="" className="float h-44 w-44" />
        <p className="text-sm text-dim">This email has not been analyzed yet.</p>
        <button
          className="btn"
          style={{ background: "#111", borderColor: "#111", color: "#fff" }}
          onClick={() => start(false)}
        >
          <Sparkles size={14} /> Analyze this email
        </button>
        {error && <p className="text-xs" style={{ color: "#b3261e" }}>{error}</p>}
      </div>
    );
  }

  if (running) {
    return (
      <div className="space-y-4">
        <div className="grid place-items-center gap-4 border border-bd bg-white px-8 py-14 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/letter/focus.png" alt="" className="pulse h-28 w-28" />
          <div className="doc-title pulse text-[19px] italic" style={{ fontWeight: 500 }}>
            {stage ?? "Starting pipeline…"}
          </div>
        </div>
        <Terminal logs={logs} live />

        <div className="grid grid-cols-2 gap-4">
          {Object.entries(agents).map(([name, st]) => (
            <div key={name} className="flex items-center gap-3 border border-bd bg-white px-5 py-4">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.status === "running" ? "pulse" : ""}`}
                style={{
                  background:
                    st.status === "done"
                      ? "#111"
                      : st.status === "running"
                        ? "#111"
                        : "#d9d9d9",
                }}
              />
              <span className="flex-1 text-[11.5px] font-bold uppercase tracking-[0.14em]">{agentDisplay(name)}</span>
              <span
                className="text-[10px] font-semibold uppercase tracking-[0.12em] text-dim"
                title={st.detail}
              >
                {st.status === "done"
                  ? `done · ${st.findingsCount ?? 0}`
                  : st.status === "error"
                    ? "unavailable"
                    : st.status === "skipped"
                      ? "skipped"
                      : st.status === "running"
                        ? "running…"
                        : "pending"}
              </span>
            </div>
          ))}
        </div>

        {verdict && counters && (
          <div className="card flex items-center gap-4 p-4">
            <VerdictBadge verdict={verdict} />
            <Counters counters={counters} />
          </div>
        )}
        {summary && (
          <div className="card border-accent/30 p-4 text-[14px] leading-relaxed">
            <span className="mb-2 block text-[10.5px] font-bold uppercase tracking-[0.18em] text-dim">
              Executive verdict
            </span>
            <SummaryText text={summary} streaming />
          </div>
        )}

        <div className="space-y-2">
          {liveFindings.map((f) => (
            <FindingCard key={f.id} f={f} live />
          ))}
        </div>
      </div>
    );
  }

  // Rapport final
  if (!report) return null;
  const active = report.findings.filter((f) => f.review !== "faux_positif");
  const treated = report.findings.filter((f) => f.review).length;

  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={isBlocking(report.verdict) ? "/letter/error.png" : "/letter/success.png"}
            alt=""
            className="h-14 w-14"
          />
          <VerdictBadge verdict={report.verdict} />
          <Counters counters={report.counters} />
          {report.degraded && (
            <span className="rounded bg-major/15 px-2 py-0.5 text-xs font-semibold text-major">
              degraded mode: rules only (AI unavailable)
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button className="btn" onClick={() => start(true)} title="Re-analyze without cache">
              <RotateCw size={14} /> Re-analyze
            </button>
          </div>
        </div>
        <SummaryText text={report.executiveSummary} />
        <div className="text-xs text-dim">
          Review: {treated}/{report.findings.length} findings resolved ·{" "}
          {report.passedChecks.length} checks passed ·{" "}
          {report.linkResults.filter((l) => l.status === "ok").length} links OK
        </div>
      </div>

      {/* Placé contre le verdict, pas en bas de page : c'est précisément un GO
          qui ne dit pas « ces règles-là n'ont été lues par personne » qui
          induit en erreur. */}
      <AgentRuns agents={report.agents} />

      <div className="space-y-2">
        {report.findings.map((f) => (
          <FindingCard key={f.id} f={f} onReview={review} />
        ))}
        {active.length === 0 && (
          <div className="card p-6 text-center text-ok">
            No active findings — everything is resolved or clean.
          </div>
        )}
      </div>

      {(report.logs?.length || logs.length > 0) && (
        <details className="card p-4">
          <summary className="cursor-pointer text-[12px] font-bold uppercase tracking-[0.1em]">
            Execution log ({(report.logs ?? logs).length} actions — link checks, LLM calls, aggregation)
          </summary>
          <div className="mt-3">
            <Terminal logs={report.logs ?? logs} />
          </div>
        </details>
      )}

      <details className="card p-4">
        <summary className="cursor-pointer text-[12px] font-bold uppercase tracking-[0.1em]">
          What passed ({report.passedChecks.length} checks)
        </summary>
        <ul className="mt-3 grid grid-cols-2 gap-1.5 text-[13px] text-dim">
          {report.passedChecks.map((c, i) => (
            <li key={i}>
              <CheckCircle2 size={13} className="mr-1 inline text-ok" /> {c.label}
            </li>
          ))}
        </ul>
      </details>

      {report.linkResults.length > 0 && (
        <details className="card p-4">
          <summary className="cursor-pointer text-[12px] font-bold uppercase tracking-[0.1em]">
            All {report.linkResults.length} links
          </summary>
          <table className="mt-3 w-full text-left text-xs">
            <thead>
              <tr className="text-dim">
                <th className="py-1 pr-2">Text</th>
                <th className="py-1 pr-2">URL</th>
                <th className="py-1 pr-2">Type</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {report.linkResults.map((l, i) => {
                // SÉCURITÉ : un lien de désinscription cliqué peut désabonner
                // l'adresse de test → jamais cliquable dans l'UI.
                const isUnsub =
                  /unsubscribe|d[ée]sinscri|d[ée]sabonn|opt.?out|配信停止|配信解除|退订|수신거부/i.test(
                    `${l.text} ${l.href} ${l.finalUrl ?? ""}`
                  ) || /désinscription|unsubscribe/i.test(l.reason ?? "");
                const openable = !isUnsub && /^https?:\/\//i.test(l.href);
                return (
                <tr key={i} className="border-t border-bd/40">
                  <td className="max-w-40 truncate py-1.5 pr-2">{l.text || "—"}</td>
                  <td className="max-w-72 truncate py-1.5 pr-2 font-mono text-[11px]">
                    {openable ? (
                      <a
                        href={l.finalUrl ?? l.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-dim underline decoration-dotted underline-offset-2 hover:text-fg"
                        title={l.finalUrl ? `Opens the final destination: ${l.finalUrl}` : "Open in a new tab"}
                      >
                        {l.href}
                      </a>
                    ) : (
                      <span className="text-dim" title={isUnsub ? "Unsubscribe link — not clickable (a click would unsubscribe the test address)" : undefined}>
                        {l.href}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-dim">{l.kind}</td>
                  <td className="py-1.5">
                    <span
                      style={{
                        color:
                          l.status === "ok"
                            ? "var(--ok)"
                            : l.status === "casse"
                              ? "var(--crit)"
                              : l.status === "suspect"
                                ? "var(--major)"
                                : "var(--text-dim)",
                      }}
                    >
                      {LINK_STATUS_LABEL[l.status] ?? l.status}
                      {l.httpStatus ? ` (${l.httpStatus})` : ""}
                    </span>
                    {l.reason && <span className="ml-1 text-dim">· {l.reason}</span>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- agents
// Ce que les agents ont RÉELLEMENT fait, lu dans le rapport enregistré et non
// dans le flux SSE : le flux est perdu au rechargement, le rapport reste.
// `report.agents` était écrit puis affiché NULLE PART — un agent skippé et un
// agent qui a tout validé se ressemblaient exactement à l'écran.
// La charte est MONOCHROME (--ok et --crit valent tous deux #111111) : coder
// un état dans la couleur y rendrait « ran » et « failed » identiques à
// l'écran. L'état est donc porté par le mot et par la forme de la pastille ;
// cette seule teinte, déjà employée plus haut dans ce fichier pour les
// erreurs, ne sert qu'à attirer l'œil, jamais à distinguer deux états.
const ALARM = "#b3261e";

const AGENT_STATUS_LABEL: Record<AgentRun["status"], string> = {
  done: "ran",
  skipped: "skipped",
  error: "failed",
  // Un rapport ENREGISTRÉ ne devrait porter ni l'un ni l'autre : les rencontrer
  // veut dire que le run s'est interrompu avant la fin de cet agent. On le
  // nomme au lieu de le ranger en silence avec les agents qui ont tourné.
  pending: "never finished",
  running: "never finished",
};

/** Libellé d'une règle non vérifiée. Le catalogue, pas les renommages faits
 *  dans /rules : les surcharges vivent côté serveur (lib/rule-config.ts) et ne
 *  sont pas dans le rapport. L'id reste donc visible en `title` — c'est lui
 *  qu'on retrouve dans /rules, quel que soit le nom affiché. */
function unverifiedRuleName(id: string): { text: string; known: boolean } {
  const entry = ALL_RULE_BY_ID[id];
  // Troisième état : un id absent du catalogue (règle sur mesure, ou règle
  // retirée depuis l'analyse) est GARDÉ et marqué, jamais escamoté.
  return entry ? { text: entry.label, known: true } : { text: id, known: false };
}

function AgentRuns({ agents }: { agents: AgentRun[] }) {
  // `unverifiedRuleIds` ABSENT ne veut pas dire « aucune règle non vérifiée » :
  // les rapports produits avant ce champ n'en portent aucun, et affirmer
  // « rien à signaler » sur ceux-là serait faux.
  //
  // Le discriminant est au niveau du RAPPORT, pas de la ligne : `key` et
  // `unverifiedRuleIds` sont arrivés ensemble, donc un rapport qui porte au
  // moins un `key` vient d'un moteur qui sait renseigner l'autre. Un test
  // ligne par ligne serait faux — dans lib/analyze.ts, le `agentRuns.push` qui
  // précède immédiatement celui de "Juge vision" (chercher le littéral
  // `screenshots capturés`) pousse une ligne SANS `key` sur un chemin ACTUEL.
  // Mesuré au moment d'écrire
  // ceci : 133 rapports stockés, 892 lignes d'agent, aucune ne porte `key`.
  const recordsUnverified = agents.some((a) => a.key !== undefined);
  const withUnverified = agents.filter((a) => (a.unverifiedRuleIds?.length ?? 0) > 0);
  if (agents.length === 0) return null;

  return (
    <div className="space-y-2">
      {withUnverified.length > 0 && (
        // `border-crit` détache la carte du gris des cartes ordinaires.
        <div className="card border-crit p-4">
          <div className="flex items-center gap-2" style={{ color: ALARM }}>
            <AlertTriangle size={14} />
            <span className="text-[10.5px] font-bold uppercase tracking-[0.18em]">
              Rules no model read
            </span>
          </div>
          <p className="mt-1.5 text-[13px] text-dim">
            These rules are switched on in the rule settings, but the agent in charge of them did
            not run for this analysis. Nothing below was checked.
          </p>
          {withUnverified.map((a, i) => (
            <div key={i} className="mt-3">
              <div className="text-[12px] font-semibold">{agentDisplay(a.agent)}</div>
              {a.detail && <div className="text-[12px] text-dim">{a.detail}</div>}
              {/* NOMMER les règles, jamais les compter : « 4 règles non
                  vérifiées » est la version rassurante de la même information,
                  et ne dit pas laquelle rouvrir. */}
              <ul className="mt-1.5 space-y-1 text-[13px]">
                {(a.unverifiedRuleIds ?? []).map((id) => {
                  const rule = unverifiedRuleName(id);
                  return (
                    <li key={id} className="flex gap-2" title={id}>
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-fg" />
                      <span>
                        {rule.text}
                        {!rule.known && (
                          <span className="ml-1.5 text-[11px] text-dim">
                            (rule id not in the current catalogue)
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      <details className="card p-4">
        <summary className="cursor-pointer text-[12px] font-bold uppercase tracking-[0.1em]">
          Agents ({agents.length} — what ran, what was skipped, what failed)
        </summary>
        <ul className="mt-3 space-y-2 text-[13px]">
          {agents.map((a, i) => {
            const unverified = a.unverifiedRuleIds ?? [];
            // Un rapport ancien ne doit RIEN affirmer : on ne sait pas ce que
            // cet agent a laissé sans juge, et une absence de liste n'est pas
            // une liste vide. Sur un rapport récent, le silence du moteur est
            // un constat délibéré — lib/analyze.ts, `key === "brief" ?
            // undefined` pour le brief, et le commentaire « Pas de
            // `unverifiedRuleIds` ici » pour la traduction — et l'écran se tait
            // à son tour.
            const unknownUnverified =
              !recordsUnverified && (a.status === "skipped" || a.status === "error");
            return (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {/* Forme, pas teinte : plein = a tourné, creux = sauté, gris
                    clair = jamais terminé, triangle = en panne. */}
                {a.status === "error" ? (
                  <AlertTriangle size={11} className="shrink-0" style={{ color: ALARM }} />
                ) : (
                  <span
                    className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full border border-fg"
                    style={{
                      borderColor: a.status === "done" || a.status === "skipped" ? "var(--crit)" : "#d9d9d9",
                      background:
                        a.status === "done"
                          ? "var(--crit)"
                          : a.status === "skipped"
                            ? "transparent"
                            : "#d9d9d9",
                    }}
                  />
                )}
                <span className="font-semibold">{agentDisplay(a.agent)}</span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-dim">
                  {AGENT_STATUS_LABEL[a.status]}
                  {a.status === "done" && a.findingsCount !== undefined
                    ? ` · ${a.findingsCount} findings`
                    : ""}
                </span>
                {a.detail && <span className="w-full text-dim">{a.detail}</span>}
                {unverified.length > 0 && (
                  <span className="w-full text-[12px]" style={{ color: ALARM }}>
                    Left unchecked:{" "}
                    {unverified.map((id) => unverifiedRuleName(id).text).join(" · ")}
                  </span>
                )}
                {unknownUnverified && (
                  <span className="w-full text-[12px] text-dim">
                    Which rules were left unchecked is not known — this report predates that record.
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

// Executive verdict formaté : GO/NO-GO surligné violet clair, puces digestes.
function SummaryText({ text, streaming }: { text: string; streaming?: boolean }) {
  const highlight = (line: string, key: number, cls = "") => {
    // L'alternance est ORDONNÉE : la forme longue d'abord, sinon `\bGO\b`
    // capture le "GO" de "GO with reservations" et laisse le reste en gris —
    // le lecteur retiendrait le mot surligné, c'est-à-dire l'inverse du verdict.
    const parts = line.split(/(GO WITH RESERVATIONS|GO with reservations|NO-GO|NO_GO|\bGO\b)/g);
    return (
      <span key={key} className={cls}>
        {parts.map((p, i) =>
          /^(GO WITH RESERVATIONS|GO with reservations|NO-GO|NO_GO|GO)$/.test(p) ? (
            <mark
              key={i}
              className="rounded-sm px-1.5 py-0.5 font-black tracking-wide"
              style={{ background: "#e9e2f7", color: "#3d2e66" }}
            >
              {p === "NO_GO" ? "NO-GO" : p}
            </mark>
          ) : (
            p
          )
        )}
      </span>
    );
  };
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return (
    <div className="space-y-2 text-[14px] leading-relaxed">
      {lines.map((l, i) => {
        const t = l.trim();
        if (t.startsWith("- ") || t.startsWith("• ")) {
          return (
            <div key={i} className="flex gap-2.5 pl-1">
              <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-fg" />
              <span>{highlight(t.slice(2), i)}</span>
            </div>
          );
        }
        if (t.toLowerCase().startsWith("prochaine action") || t.toLowerCase().startsWith("next action")) {
          return (
            <p key={i} className="border-t border-bd pt-2 text-[13px]">
              <span className="mr-1 text-[10.5px] font-bold uppercase tracking-[0.14em] text-dim">
                Next action
              </span>
              {highlight(t.replace(/^(prochaine action|next action)\s*:\s*/i, ""), i)}
            </p>
          );
        }
        return <p key={i} className={i === 0 ? "font-semibold" : ""}>{highlight(t, i)}</p>;
      })}
      {streaming && <span className="pulse">▍</span>}
    </div>
  );
}

function Terminal({ logs, live }: { logs: string[]; live?: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [logs, live]);
  const color = (l: string) =>
    l.includes(" ✗ ") || l.includes("ERREUR") || l.includes("CASSE")
      ? "#ff8080"
      : l.includes(" ↻ ")
        ? "#f5c451"
        : l.includes("↳")
          ? "#6ea882"
          : l.includes("llm:") || l.includes("terminé:")
            ? "#5ee38f"
            : "#9dd8ae";
  return (
    <div className="overflow-hidden rounded-xl border border-bd bg-black">
      <div className="flex items-center gap-1.5 border-b border-bd px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 font-mono text-[11px] text-dim">
          sentinel — pipeline actions {live && "(live)"}
        </span>
      </div>
      <div className={`${live ? "max-h-72" : "max-h-80"} overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed`}>
        {logs.length === 0 ? (
          <span className="pulse" style={{ color: "#5ee38f" }}>$ starting pipeline…</span>
        ) : (
          logs.map((l, i) => (
            <div key={i} style={{ color: color(l) }}>
              {l}
            </div>
          ))
        )}
        {live && <span className="pulse" style={{ color: "#5ee38f" }}>▍</span>}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function Counters({ counters }: { counters: AnalysisReport["counters"] }) {
  const total = counters.critiques + counters.majeurs + counters.mineurs;
  return (
    <div className="flex items-center gap-4 text-[11px] font-semibold uppercase tracking-[0.12em]">
      <span className="text-fg">{total} error{total === 1 ? "" : "s"}</span>
      <span style={{ color: "#9a9a9a" }}>{counters.passed} checks passed</span>
    </div>
  );
}

/** Comparaison Attendu (brief) ↔ Reçu (email) avec les différences surlignées
 *  en jaune — lisible même sans parler la langue du mail. */
function DiffView({ expected, received }: { expected: string; received: string }) {
  const segs = useMemo(() => diffSegments(expected, received), [expected, received]);
  const notFound = received.trim() === "";
  // URLs → mono + césure caractère par caractère (une URL n'a pas d'espaces).
  const urlMode =
    IS_URL_RE.test(expected.trim()) && (notFound || IS_URL_RE.test(received.trim()));
  const boxCls = `rounded border border-bd bg-white px-2.5 py-1.5${urlMode ? " break-all font-mono text-[11.5px]" : ""}`;
  const render = (parts: Array<{ text: string; changed: boolean }>) =>
    parts.map((s, i) =>
      s.changed ? (
        <mark key={i} style={{ background: "#ffe86b", padding: "0 1px", borderRadius: 2 }}>
          {s.text}
        </mark>
      ) : (
        <span key={i}>{s.text}</span>
      )
    );
  return (
    <div className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed">
      <div className={boxCls}>
        <span className="mr-2 font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-dim">
          Expected (brief)
        </span>
        <span>{render(segs.a)}</span>
      </div>
      {notFound ? (
        <div className={boxCls} style={{ opacity: 0.6 }}>
          <span className="mr-2 font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-dim">
            Received (email)
          </span>
          <span className="text-dim">not found</span>
        </div>
      ) : (
        <div className={boxCls}>
          <span className="mr-2 font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-dim">
            Received (email)
          </span>
          <span>{render(segs.b)}</span>
        </div>
      )}
    </div>
  );
}

function FindingCard({
  f,
  live,
  onReview,
}: {
  f: Finding;
  live?: boolean;
  onReview?: (id: string) => void;
}) {
  const treated = Boolean(f.review);
  return (
    <div
      className={`card p-3.5 ${live ? "pop-in" : ""}`}
      style={treated ? { opacity: 0.45 } : undefined}
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-bold leading-snug">
            {treated && <CheckCircle2 size={13} className="mr-1 inline text-ok" />}
            <span className={treated ? "line-through opacity-60" : ""}>
              {titleForFinding(f)}
            </span>
          </div>
          <div className={`mt-0.5 text-[12.5px] leading-snug ${treated ? "line-through opacity-60" : ""}`}>
            {f.message}
          </div>
          {f.expected !== undefined ? (
            <DiffView expected={f.expected} received={f.received ?? ""} />
          ) : (
            f.evidence && (
              <div className="mt-1 break-all font-mono text-[11.5px] text-dim line-clamp-3" title={f.evidence}>
                {f.evidence}
              </div>
            )
          )}
          {f.suggestion && (
            <div className="mt-1 flex items-start gap-1 text-[12.5px] text-dim"><Lightbulb size={13} className="mt-0.5 shrink-0" /> {f.suggestion}</div>
          )}
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-dim">
            <span
              className="border border-bd px-1.5 py-px font-semibold uppercase tracking-[0.08em] text-dim"
              title={
                f.source === "regle"
                  ? "Detected by a deterministic automatic rule (general email quality or brief cross-check)"
                  : "Detected by an AI agent"
              }
            >
              {f.source === "regle" ? "Auto rule" : f.agent}
            </span>
            <span>{f.locator}</span>
            {f.quoteVerified === false && <span className="text-major">quote not verified</span>}
          </div>
        </div>
        {onReview && (
          <button
            className="shrink-0 border border-bd p-1.5 text-dim transition-colors hover:border-fg hover:text-fg"
            title={treated ? "Restore this finding" : "Mark as resolved — removed from counts and verdict"}
            onClick={() => onReview(f.id)}
          >
            {treated ? <RotateCw size={13} /> : <Check size={13} />}
          </button>
        )}
      </div>
    </div>
  );
}
