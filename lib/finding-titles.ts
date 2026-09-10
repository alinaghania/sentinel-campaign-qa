// Titres harmonisés des findings — module PUR client-safe (importé par l'UI,
// les exports Excel ET les schémas agents : ZÉRO import serveur ici).

import type { Finding } from "./types";

/** Les 13 titres autorisés — la seule liste : tout titre affiché vient d'ici. */
export const FINDING_TITLES = [
  "Problem in the translation",
  "Problem in the subject line",
  "Problem in a link",
  "Problem in the tracking",
  "Problem in the email authentication",
  "Email authentication could not be verified",
  "Problem in the unsubscribe setup",
  "Problem in an image",
  "Problem in the rendering",
  "Problem in the content",
  "Problem in the brand guidelines",
  "Technical problem",
  "Possible issue to review",
] as const;

export type FindingTitle = (typeof FINDING_TITLES)[number];

/** Titres proposables par les agents LLM : les 2 titres d'authentification
 *  sont RÉSERVÉS aux règles code (seules à lire les en-têtes du vrai mail). */
export const FINDING_TITLES_AGENT = [
  "Problem in the translation",
  "Problem in the subject line",
  "Problem in a link",
  "Problem in the tracking",
  "Problem in the unsubscribe setup",
  "Problem in an image",
  "Problem in the rendering",
  "Problem in the content",
  "Problem in the brand guidelines",
  "Technical problem",
  "Possible issue to review",
] as const;

/** Titre par défaut d'une catégorie interne (fallback quand le finding ne
 *  porte pas de titre explicite — anciens rapports persistés inclus). */
export const TITLE_BY_CATEGORY: Record<Finding["categorie"], FindingTitle> = {
  assets: "Problem in an image",
  liens: "Problem in a link",
  tracking: "Problem in the tracking",
  brief: "Problem in the translation",
  guidelines: "Problem in the brand guidelines",
  contenu: "Problem in the content",
  rendu: "Problem in the rendering",
  delivrabilite: "Problem in the email authentication",
  technique: "Technical problem",
};

/** Catégories COHÉRENTES pour chaque titre : un agent LLM qui propose un titre
 *  hors de la liste de sa catégorie est ramené au titre par défaut (garde-fou
 *  anti-hallucination). Titre absent du record = aucune contrainte. */
export const TITLE_ALLOWED_CATEGORIES: Partial<
  Record<FindingTitle, Array<Finding["categorie"]>>
> = {
  "Problem in the translation": ["brief", "contenu"],
  "Problem in the subject line": ["contenu", "guidelines", "brief"],
  "Problem in a link": ["liens"],
  "Problem in the tracking": ["tracking", "brief"],
  "Problem in the email authentication": ["delivrabilite"],
  "Email authentication could not be verified": ["delivrabilite"],
  "Problem in the unsubscribe setup": ["delivrabilite", "liens"],
  "Problem in an image": ["assets", "rendu"],
  "Problem in the rendering": ["rendu"],
  "Problem in the content": ["contenu", "brief"],
  "Problem in the brand guidelines": ["guidelines"],
  "Technical problem": ["technique"],
  "Possible issue to review": [
    "assets",
    "liens",
    "tracking",
    "brief",
    "guidelines",
    "contenu",
    "rendu",
    "delivrabilite",
    "technique",
  ],
};

const VALID_TITLES: ReadonlySet<string> = new Set(FINDING_TITLES);

/** Titre affichable d'un finding : son titre s'il est valide, sinon le titre
 *  par défaut de sa catégorie, sinon le titre générique (rapports persistés
 *  d'avant l'introduction du champ title, données inattendues). */
export function titleForFinding(
  f: Pick<Finding, "title" | "categorie">
): string {
  if (f.title && VALID_TITLES.has(f.title)) return f.title;
  return TITLE_BY_CATEGORY[f.categorie] ?? "Possible issue to review";
}
