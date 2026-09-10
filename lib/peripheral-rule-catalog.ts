// Catalogue des réglages "périphériques" — ceux qui ne vivent pas dans
// lib/checks-code.ts mais qui décident quand même du verdict : comment un lien
// est ouvert, ce qui distingue un lien mort d'un lien bloqué par un WAF, à
// partir de quel score un email est rattaché à sa campagne.
//
// Deux natures d'entrées ici, et c'est délibéré :
//
//  1. ÉDITABLES — un réglage qu'une personne fonctionnelle a une raison
//     légitime de changer (un site lent qui dépasse le timeout, un WAF qui
//     répond 503, un rattachement trop laxiste).
//
//  2. readOnly — AFFICHÉES avec leur valeur et la raison de leur verrouillage,
//     jamais éditables. La demande était « toutes les règles » : cacher un
//     réglage ne le rend pas inexistant, ça le rend seulement invisible. Une
//     personne qui se demande « est-ce que Sentinel teste le lien de
//     désinscription ? » doit trouver la réponse dans la page, pas dans le code.
//     Les verrous sont tous des verrous de SÛRETÉ, motivés un par un ci-dessous.
//
// ⚠️ Un `id` est un CONTRAT : ne JAMAIS le renommer (cf. lib/rule-catalog.ts).
// Ce module ne dépend d'AUCUNE API Node : il est importé par la page client.

import type { RuleCatalogEntry } from "./rule-catalog";

export const PERIPHERAL_RULE_CATALOG: RuleCatalogEntry[] = [
  // ------------------------------------------------- link-verification (éditable)
  {
    id: "links-http-verification",
    label: "How links are opened",
    description:
      "Sentinel opens every link for real, like a browser would. These settings control how patient and how parallel it is. Raise the timeout if a slow market keeps reporting timeouts; lower the parallelism if a site starts blocking bursts of requests.",
    family: "link-verification",
    defaultSeverity: "auto",
    severityAdjustable: false,
    source: "check-links.ts:37-39",
    params: [
      {
        key: "timeoutSec",
        kind: "int",
        label: "Timeout per link",
        help: "How long to wait for a link to answer before calling it broken. The tracker → maison-site chain regularly needs more than 10s.",
        min: 5,
        max: 60,
        default: 15,
        unit: "s",
      },
      {
        key: "concurrency",
        kind: "int",
        label: "Links checked in parallel",
        help: "Lower this if a site starts refusing requests when several arrive at once. Higher is faster but looks more like a bot.",
        min: 1,
        max: 12,
        default: 6,
      },
      {
        key: "maxRedirects",
        kind: "int",
        label: "Maximum redirects followed",
        help: "A tracking link goes through several hops before reaching the site. Beyond this count the chain is reported as broken.",
        min: 1,
        max: 15,
        default: 5,
      },
    ],
  },
  {
    id: "links-status-classification",
    label: "What counts as a broken link",
    description:
      "When a link answers with an error code, this decides whether it is a real defect or a website security filter refusing an automated visit. Getting this wrong is expensive in both directions: too strict and every social-media link in the footer is reported as broken, too lax and a genuine dead link ships.",
    family: "link-verification",
    defaultSeverity: "auto",
    severityAdjustable: false,
    source: "check-links.ts:222-226",
    params: [
      {
        key: "blockedStatuses",
        kind: "int-list",
        label: "Codes meaning “blocked, not broken”",
        help: "Anti-bot rejections. Reported as “could not be verified”, never as a defect. 400 was added in July 2026 after Facebook links were wrongly reported as broken.",
        min: 100,
        max: 599,
        default: [400, 403, 405, 429],
        maxItems: 12,
      },
      {
        key: "brokenStatuses",
        kind: "int-list",
        label: "Codes meaning “broken”",
        help: "Blocks the send. Any code of 500 and above is always treated as broken, whatever is listed here.",
        min: 100,
        max: 599,
        default: [404, 410],
        maxItems: 12,
      },
    ],
  },

  // ------------------------------------------------- link-verification (verrouillé)
  {
    id: "links-ssrf-guard",
    label: "Internal addresses are never contacted",
    description:
      "Before opening any link, Sentinel refuses private, local and cloud-metadata addresses. Without this, a link inside an email could make the server call its own internal network.",
    family: "link-verification",
    defaultSeverity: "auto",
    severityAdjustable: false,
    readOnly: true,
    lockedReason:
      "This is a server security guard, not a QA setting — turning it off would let an email reach Sentinel's own internal network.",
    lockedValue: "Always on — private, loopback, link-local and cloud-metadata IPs blocked",
    source: "check-links.ts:44-84",
  },
  {
    id: "links-unsubscribe-excluded",
    label: "Unsubscribe links are never opened",
    description:
      "Any link that looks like an unsubscribe or preference-centre link is detected and left untouched, in 9 languages including Chinese, Japanese and Korean. Opening one would unsubscribe the test address for real.",
    family: "link-verification",
    defaultSeverity: "auto",
    severityAdjustable: false,
    readOnly: true,
    lockedReason:
      "Safety: a single automated visit to an unsubscribe link silently opts the test mailbox out of the campaign.",
    lockedValue:
      "Always on — detected in EN, FR, DE, ES, IT, ZH, JA, KO on both the URL and the link text",
    source: "check-links.ts:92-93",
  },
  {
    id: "links-browser-fingerprint",
    label: "Links are opened as a real browser",
    description:
      "Sentinel sends the exact header set a real Chrome sends. Without it, the maisons' security layer answers “forbidden” and dozens of perfectly good links are reported as broken.",
    family: "link-verification",
    defaultSeverity: "auto",
    severityAdjustable: false,
    readOnly: true,
    lockedReason:
      "The headers must stay mutually consistent (browser version, platform and hints all match). Editing one in isolation is what made 25 links look broken before July 2026.",
    lockedValue: "Chrome 138 on macOS — full navigation header set, GET with the body cancelled after 8 KB",
    source: "check-links.ts:11-42",
  },
  {
    id: "links-soft-404",
    label: "“Page not found” pages are detected",
    description:
      "Some sites answer “everything is fine” while actually showing a not-found page. Sentinel reads the page title to catch it.",
    family: "link-verification",
    defaultSeverity: "auto",
    severityAdjustable: false,
    readOnly: true,
    lockedReason:
      "Detection relies on a text pattern. Patterns cannot be edited from this page by design — a malformed one would hang the server (see the note on the top of this page).",
    lockedValue: "Title matched against “not found”, “introuvable”, “n'existe plus”, “404”",
    source: "check-links.ts:87-88",
  },

  // ------------------------------------------------------------- matching
  {
    id: "matching-auto-threshold",
    label: "When a received email is attached to a campaign automatically",
    description:
      "Every email arriving in the inbox is scored against the open campaigns. Above this score it is attached on its own; below it, it waits for someone to pick the campaign by hand. Lower it if you are attaching too many emails manually, raise it if emails land on the wrong campaign.",
    family: "matching",
    defaultSeverity: "auto",
    severityAdjustable: false,
    source: "match.ts:66",
    params: [
      {
        key: "autoThresholdPercent",
        kind: "int",
        label: "Automatic attachment score",
        help: "A perfect match on the test number alone already scores high. 60% is deliberately cautious.",
        min: 30,
        max: 95,
        default: 60,
        unit: "%",
      },
    ],
  },
  {
    id: "matching-stopwords",
    label: "Words ignored when matching an email to a campaign",
    description:
      "Common words are stripped before comparing an email subject to a campaign name, so that “the” and “new” do not create false matches.",
    family: "matching",
    defaultSeverity: "auto",
    severityAdjustable: false,
    readOnly: true,
    lockedReason:
      "Matching happens in the browser when the inbox is displayed, before any server configuration is available. Making it configurable requires moving the matching server-side — worth doing, not done yet.",
    lockedValue: "22 words (the, and, for, new, your, our, with…)",
    source: "match-campaign.ts:9-36",
  },

  // ------------------------------------------------------------- technical
  {
    id: "render-viewports",
    label: "Screen widths used for screenshots",
    description:
      "The widths at which the email is photographed in real Gmail. Each width produces one screenshot in the report and in the Excel export.",
    family: "technical",
    defaultSeverity: "auto",
    severityAdjustable: false,
    readOnly: true,
    lockedReason:
      "Screenshots are captured on a laptop and pushed to the server, never on the server itself. Changing the widths from this page would have no effect on the deployed app — it needs to move with the capture flow.",
    lockedValue: "desktop 1280px · mobile 320, 360, 390 and 430px",
    source: "render-real.ts:42-48",
  },

  // ------------------------------------------------------------- ai-checks
  {
    id: "agent-output-limits",
    label: "How much each AI agent may report",
    description:
      "Each AI agent is capped so it reports only what matters most in its own area. Raising the cap surfaces more minor issues but also more noise and duplicates.",
    family: "ai-checks",
    defaultSeverity: "auto",
    severityAdjustable: false,
    source: "agents.ts:29-41",
    params: [
      {
        key: "maxFindings",
        kind: "int",
        label: "Maximum issues reported per agent",
        help: "Seven agents run on every email, so a cap of 5 already allows up to 35 issues before deduplication.",
        min: 3,
        max: 12,
        default: 5,
      },
    ],
  },
  {
    id: "agent-evidence-verification",
    label: "Every AI finding must quote the email verbatim",
    description:
      "An AI agent may only report something it can quote character for character from the email. The quote is verified automatically and a paraphrase is rejected — this is what stops the agents from inventing problems.",
    family: "ai-checks",
    defaultSeverity: "auto",
    severityAdjustable: false,
    readOnly: true,
    protected: true,
    lockedReason:
      "This is the anti-hallucination guard. Without it nothing distinguishes a real defect from an invented one.",
    lockedValue: "Always on — evidence checked by exact substring match against the email",
    source: "agents.ts:29-41",
  },
];

export const PERIPHERAL_RULE_BY_ID: Record<string, RuleCatalogEntry> = Object.fromEntries(
  PERIPHERAL_RULE_CATALOG.map((r) => [r.id, r])
);
