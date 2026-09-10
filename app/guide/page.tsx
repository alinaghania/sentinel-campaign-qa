// Page d'explication métier : à quoi sert Sentinel, dans quel ordre on s'en
// sert, ce qu'il mesure et ce qu'il ne mesure pas.
//
// Composant SERVEUR, et AUCUN chiffre n'est écrit à la main. Les comptes de
// règles sont dérivés des catalogues eux-mêmes (`RULE_CATALOG`,
// `LLM_RULE_CATALOG`, `PERIPHERAL_RULE_CATALOG`, `AGENT_CHOICES`) pour la même
// raison qu'aucune adresse de cellule n'est écrite dans /brief-template : une
// page qui affirme « 35 contrôles » pendant que le moteur en exécute 31 est
// pire qu'une page muette — c'est une consigne fausse donnée avec assurance, et
// elle se périme sans bruit le jour où quelqu'un ajoute une règle.
//
// Cette page est aussi le point d'entrée STABLE de /brands et /brief-template
// depuis que la barre de navigation est réduite à quatre onglets. Les deux
// liens plus bas ne sont pas décoratifs : sans eux, les seules entrées vers ces
// écrans sont conditionnelles (le lien marque de la fiche campagne n'apparaît
// que si la campagne porte une marque) ou enfouies dans un pas du parcours de
// création qu'on ne repasse jamais.
import Link from "next/link";
import { AGENT_CHOICES } from "@/lib/agent-catalog";
import { FAMILY_LABELS, FAMILY_ORDER, RULE_CATALOG } from "@/lib/rule-catalog";
import { LLM_RULE_CATALOG } from "@/lib/llm-rule-catalog";
import { PERIPHERAL_RULE_CATALOG } from "@/lib/peripheral-rule-catalog";
import { ALL_CATALOG } from "@/lib/rule-registry";

export const metadata = { title: "Guide — Sentinel" };

/** Étapes du parcours, dans l'ordre où on les fait. Le `where` dit à quel
 *  écran on est : sans ça, la page raconte un principe au lieu d'un chemin. */
const STEPS: Array<{ where: string; title: string; body: React.ReactNode }> = [
  {
    where: "Campaigns",
    title: "Create the campaign",
    body: (
      <>
        One campaign per send — the thing your markets will receive. At this point it is
        just a name: no brief, no emails, no verdict. It appears in the tracking table on{" "}
        <Link href="/" className="underline">Campaigns</Link> with a status that follows it
        until it ships.
      </>
    ),
  },
  {
    where: "Campaigns → Paste the brief",
    title: "Paste the brief",
    body: (
      <>
        The brief is what the QA judges against — without it there is nothing to compare the
        email to, and most checks simply have no reference. You paste it into a table whose
        rows are the template fields and whose columns are the languages: copy a block out of
        Excel, click the first cell it belongs in, paste. Which field goes where is not a
        convention you have to remember — it is written out, cell by cell, in the{" "}
        <Link href="/brief-template" className="underline">brief template reference</Link>.
        A campaign created without a brief is not lost: the campaign page carries an
        “Import brief” fallback.
      </>
    ),
  },
  {
    where: "Inbox",
    title: "Receive the test emails",
    body: (
      <>
        The <Link href="/inbox" className="underline">Inbox</Link> is a real mailbox — Gmail
        or Outlook, connected once — where SFMC test sends land. Nothing is analysed here.
        It is a reading pane: sender, subject, preview, search.
      </>
    ),
  },
  {
    where: "Inbox",
    title: "Attach each email to its campaign",
    body: (
      <>
        Every incoming email is scored against the open campaigns. Above a configurable
        score it attaches itself; below it, Sentinel suggests a campaign and waits for one
        click. This is the step that decides what gets compared to what — an email attached
        to the wrong campaign will be judged against the wrong brief, and the report will
        look confidently wrong rather than empty.
      </>
    ),
  },
  {
    where: "Campaign page",
    title: "Run the analysis",
    body: (
      <>
        All attached emails are analysed in parallel. Two things run: the deterministic
        checks, which read the parsed email and the brief and decide by rule, and the AI
        agents, which are handed pre-parsed facts — never raw HTML — and report only what
        they can quote back verbatim.
      </>
    ),
  },
  {
    where: "Campaign page",
    title: "Read the verdict, language by language",
    body: (
      <>
        Each attached email gets its own verdict. Languages are then rolled up: a language
        with four market variants is only GO if all four are, because aggregating upwards
        would hide the reservation carried by the single variant that has one. Every finding
        stays visible and can be arbitrated by hand — and an arbitrated finding leaves the
        count, which is how a report converges.
      </>
    ),
  },
];

export default function GuidePage() {
  // Comptes MESURÉS sur les catalogues, jamais recopiés.
  const detCount = RULE_CATALOG.length;
  const llmCount = LLM_RULE_CATALOG.length;
  const periCount = PERIPHERAL_RULE_CATALOG.length;
  const totalCount = ALL_CATALOG.length;
  const agentCount = AGENT_CHOICES.length;

  // Répartition par famille, sur le catalogue unifié — donc exactement ce que
  // la page /rules donne à piloter. Une famille vide est sautée : la lister à
  // zéro suggérerait un contrôle qui n'existe pas.
  const perFamily = FAMILY_ORDER.map((family) => ({
    family,
    label: FAMILY_LABELS[family],
    count: ALL_CATALOG.filter((r) => r.family === family).length,
  })).filter((f) => f.count > 0);

  return (
    <div className="space-y-8 pb-10">
      <div>
        <p className="eyebrow">Documentation</p>
        <h1 className="doc-title text-[32px]">What Sentinel does</h1>
        <p className="mt-2 max-w-3xl text-[13px] text-dim">
          Sentinel is the QA step between “the markets have received their test emails” and
          “we press send”. Read this once and you will know what the verdict on a campaign is
          worth — and, just as usefully, what it does not cover.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="doc-section">The problem it replaces</h2>
        <div className="card max-w-3xl space-y-3 p-5 text-[13px] leading-relaxed">
          <p>
            A campaign goes out in a dozen languages. Today each one is checked by reading
            it: someone opens the test email next to the brief and compares the subject line,
            the offer, the dates, the promo code, the CTA, the UTM tags, the footer, the
            unsubscribe link — and then does it again for the next market, and the next.
          </p>
          <p>
            That method does not fail because people are careless. It fails because it is
            uneven. The first market is read closely and the eleventh is skimmed; the checks
            that are easy to see get done and the ones that require opening a link or
            reading a header get skipped; and nothing records what was actually verified, so
            a clean campaign and an unchecked one look identical afterwards. The defects that
            reach production are rarely subtle — a staging URL, a link that 404s, a promo code
            from last month, a placeholder nobody replaced.
          </p>
          <p>
            Sentinel makes that pass mechanical and identical for every language, and leaves
            a trace: a report per email, a verdict per language, and a named rule behind every
            single finding. What it does not do is replace the judgement call. It produces
            evidence; a human still decides.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="doc-section">The run, end to end</h2>
        <ol className="space-y-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="card flex max-w-3xl gap-4 p-5">
              <span className="doc-title shrink-0 text-[22px] text-dim">{i + 1}</span>
              <div className="text-[13px] leading-relaxed">
                <p className="eyebrow">{step.where}</p>
                <p className="mt-0.5 font-bold">{step.title}</p>
                <p className="mt-1.5 text-dim">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="doc-section">What it checks</h2>
        <p className="max-w-3xl text-[13px] leading-relaxed text-dim">
          {totalCount} rules are in play, and they are not all of the same nature. {detCount}{" "}
          are deterministic: they read the parsed email and the brief and decide by rule, the
          same way every time, with no model involved — a link either returns an error or it
          does not, a UTM value either matches the brief or it does not. {llmCount} are
          carried out by the AI agents, and cover what a rule cannot express: whether the
          offer in the email is the offer in the brief, whether the tone follows the brand
          guidelines, whether two dates inside the same email contradict each other. The
          remaining {periCount} are not checks on the email at all — they govern how Sentinel
          works: how patiently links are opened, when an incoming email is attached on its
          own, how much each agent is allowed to report. All {totalCount} are listed, described
          in plain language and switchable on{" "}
          <Link href="/rules" className="underline">Rules</Link>.
        </p>
        <div className="card max-w-3xl overflow-x-auto p-0">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-bd text-left">
                <th className="px-3 py-2 font-bold">Family</th>
                <th className="px-3 py-2 font-bold">Rules</th>
              </tr>
            </thead>
            <tbody>
              {perFamily.map((f) => (
                <tr key={f.family} className="border-b border-bd last:border-0">
                  <td className="px-3 py-2">{f.label}</td>
                  <td className="px-3 py-2 font-mono font-bold">{f.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="doc-section">Deterministic checks and AI agents are not interchangeable</h2>
        <div className="card max-w-3xl space-y-3 p-5 text-[13px] leading-relaxed">
          <p>
            The distinction matters when you are deciding how much to trust a finding.
            A deterministic check is a piece of code with a fixed answer: run it twice on the
            same email and you get the same result. An AI finding is a judgement, and it is
            fenced in on three sides.
          </p>
          <p>
            First, the agents never see the raw email. They are handed facts already extracted
            from it, so there is nothing to misread. Second, every finding must quote the email
            character for character; the quote is checked automatically by substring search, and
            a paraphrase fails. A finding whose quote cannot be found is not thrown away — it is
            demoted to a minor “Possible issue to review”, and the severity you configured in
            Rules deliberately does not apply to it. That is the anti-hallucination guard, and it
            is the one rule in the catalogue that cannot be switched off. Third, {agentCount}{" "}
            agents run on every email and each is capped at five findings, so an agent reports
            what matters most in its area rather than everything it noticed.
          </p>
          <p>
            One more thing worth knowing: an AI model does write the executive summary at the
            top of a report, but it does not decide the verdict. The verdict is computed in
            code and handed to it. The model explains a conclusion it cannot change.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="doc-section">What it does not check</h2>
        <div className="card max-w-3xl space-y-3 border-l-4 border-l-[color:var(--major)] p-5 text-[13px] leading-relaxed">
          <p>
            <span className="font-bold">Whether a translation is good.</span> The deterministic
            side checks the shape of the brief, not its prose: that the workbook follows the
            template, that every activated language is filled in, that no two columns collide,
            that no cell is doing the job of two fields. Fidelity — does the French say what the
            English says — is judged by an agent, and only where the deterministic pass already
            flagged a gap. A mistranslation in a block nothing else flagged will not be caught.
          </p>
          <p>
            <span className="font-bold">Language columns your template adds.</span> Two things can
            make a column invisible to the analysis: a language code the parser does not
            recognise, which is skipped outright when the workbook is read, and two columns that
            resolve to the same underlying language, where only the first is kept and the second
            is silently answered with the first one&apos;s text. Those columns are still part of
            the brief and you should still fill them — they are simply not compared to anything.
            The eleven columns shipped with the standard template are clear of both: each one is
            recognised, and no two of them collapse together. The risk is on the columns you add
            yourself — <span className="font-mono">TW</span> is not read at all, and{" "}
            <span className="font-mono">GB</span> next to an existing{" "}
            <span className="font-mono">EN</span> is answered with the English text. Do not assume:
            your campaign&apos;s template screen labels every column live, either{" "}
            <span className="italic">reads as…</span> or{" "}
            <span className="italic">not recognised</span>, as you type the code.
          </p>
          <p>
            <span className="font-bold">Rendering, unless screenshots were captured.</span> The
            real-render checks read screenshots taken in an actual Gmail client on a laptop and
            pushed to the server. The server does not photograph emails by itself. No
            screenshots, no rendering verdict — and the absence is silent.
          </p>
          <p>
            <span className="font-bold">Unsubscribe links.</span> Every link in the email is
            opened for real, except these: anything that looks like an unsubscribe or
            preference-centre link is detected and left untouched, because visiting one would
            opt the test mailbox out of the campaign for real. That an unsubscribe link is
            present and non-empty is checked; that the page behind it works is not.
          </p>
          <p>
            <span className="font-bold">Anything you switched off.</span> A rule disabled in
            Rules stops producing findings, and it stops before aggregation — nothing marks the
            report to say the check was skipped. A GO on a campaign whose rules were pared down
            is a narrower statement than a GO on the full catalogue.
          </p>
          <p>
            <span className="font-bold">The send itself.</span> Sentinel reads test emails and
            writes reports. It does not talk to SFMC, does not correct anything, and does not
            block a send. A NO-GO is a statement, not a lock.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="doc-section">How to read a verdict</h2>
        <p className="max-w-3xl text-[13px] leading-relaxed text-dim">
          The rule is short and worth knowing exactly, because it is not a score and there is no
          threshold to argue about. Every finding not yet arbitrated by a human counts. If any
          one of them is critical, the verdict is NO-GO. If none is critical but at least one
          finding is still open, it is GO WITH RESERVATIONS. Only an email with nothing left
          open is a plain GO.
        </p>
        <div className="card max-w-3xl overflow-x-auto p-0">
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              <tr className="border-b border-bd align-top">
                <td className="px-4 py-3 font-bold whitespace-nowrap">NO-GO</td>
                <td className="px-4 py-3 text-dim">
                  At least one critical finding is open. Something would go out wrong: a dead
                  link, a legal omission, the wrong promo code. Fix it, re-run, or arbitrate the
                  finding if it is a false positive.
                </td>
              </tr>
              <tr className="border-b border-bd align-top">
                <td className="px-4 py-3 font-bold whitespace-nowrap">GO WITH RESERVATIONS</td>
                <td className="px-4 py-3 text-dim">
                  Nothing critical, but major or minor points are still open. The send is not
                  blocked. This is the verdict that asks you to read before you decide — the
                  reservations are listed, each with its rule and its evidence.
                </td>
              </tr>
              <tr className="align-top">
                <td className="px-4 py-3 font-bold whitespace-nowrap">GO</td>
                <td className="px-4 py-3 text-dim">
                  Nothing is left open — either nothing was found, or everything found has been
                  arbitrated by someone.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="max-w-3xl text-[13px] leading-relaxed text-dim">
          Two consequences follow, and both surprise people. A GO can be reached by arbitration
          rather than by correction — marking a finding as a false positive removes it from the
          count, which is the point, but it means a GO records a decision as much as a
          measurement. And a language line aggregates downwards: it takes the worst verdict among
          its market variants, so a single NO-GO email makes the whole language NO-GO even when
          the other three are clean.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="doc-section">Where the rest lives</h2>
        <div className="flex flex-wrap gap-2">
          <Link href="/brief-template" className="btn">
            Brief template reference
          </Link>
          <Link href="/brands" className="btn">
            Browse a campaign brief
          </Link>
          <Link href="/rules" className="btn">
            Rules
          </Link>
        </div>
        <p className="max-w-3xl text-[12px] text-dim">
          The brief template reference says which cell of the workbook carries which field, and
          is generated from the same definition as the downloadable template — the two cannot
          drift apart. The brief browser shows the multilingual grid Sentinel actually read back
          for a given campaign, which is the fastest way to find out why a check had nothing to
          compare against.
        </p>
      </section>
    </div>
  );
}
