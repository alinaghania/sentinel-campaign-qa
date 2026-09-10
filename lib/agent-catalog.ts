// Agents auxquels une règle écrite dans /rules peut être confiée.
//
// SOURCE UNIQUE. Ce module ne dépend de RIEN — ni API Node, ni autre module du
// projet — et c'est toute sa raison d'être : lib/agents.ts tire fs et path (via
// store.ts) et la clé Foundry (via foundry.ts), il ne peut donc pas franchir la
// frontière serveur/client, alors que la page /rules doit afficher cette liste.
// La page, la route et le validateur lisent TOUS ce fichier.
//
// ⚠️ NE JAMAIS déclarer une seconde liste ailleurs, même dérivée, même sous un
// autre nom. Ça a été fait, et voici ce qui est arrivé : lib/agents.ts exportait
// un `AGENT_CHOICES` homonyme construit depuis WORKERS, la route importait
// celui-là et la page celui-ci. Les deux listes ont divergé sur une clé, et
// comme les imports se lisaient pareil, l'écart était invisible à la relecture —
// c'est le NOM qui trompait, pas la liste. lib/agents.ts VÉRIFIE désormais cette
// liste au chargement (voir la garde qui suit AGENT_CHOICES là-bas) au lieu d'en
// construire une seconde.
//
// Les deux façons de se tromper, symétriques :
//  - un agent ABSENT d'ici est invisible dans la page : aucune règle ne peut lui
//    être confiée, et personne ne cherche une option qui n'a jamais existé ;
//  - un agent nommé ici qui n'exécute AUCUNE règle produit le pire des deux —
//    une règle enregistrée, affichée « On », et vérifiée par personne.

export const AGENT_CHOICES = [
  { key: "assets", label: "Assets & images" },
  { key: "liens", label: "Links & redirects" },
  { key: "tracking", label: "Tracking & UTM" },
  { key: "brief", label: "Brief ↔ email consistency" },
  { key: "guidelines", label: "Brand guidelines" },
  { key: "anomalies", label: "Anomalies & omissions" },
  // Pas un worker : lib/render-vision.ts consomme le même bloc de règles
  // actives via activeRulesBlock. Il est nommé par le catalogue de règles LLM,
  // et lib/agents.ts lève au chargement si un agent du catalogue manque ici.
  { key: "vision", label: "Real rendering (screenshots)" },
] as const satisfies ReadonlyArray<{ key: string; label: string }>;

// ABSENT et ce n'est pas un oubli : `translation`. C'est un worker à `runner`
// spécialisé (lib/agents.ts) — il n'arbitre que des blocs déjà signalés par le
// contrôle déterministe, via un protocole fixe, et ne lit ni activeRulesBlock ni
// <custom_rules>. Une règle éditoriale qu'on lui confierait serait enregistrée,
// affichée active, et n'entrerait dans AUCUN prompt. Vaut pour tout futur worker
// à `runner` : la garde de lib/agents.ts refuse leur présence ici.

export type AgentKey = (typeof AGENT_CHOICES)[number]["key"];

/** Les seules clés, pour les gardes qui n'ont que faire des libellés. Dérivée,
 *  jamais recopiée : une clé retirée ci-dessus disparaît d'ici le même jour. */
export const AGENT_KEYS: readonly string[] = AGENT_CHOICES.map((c) => c.key);

/** Agent qui reçoit une règle écrite à la main quand aucun autre n'est désigné.
 *  Une config déjà enregistrée n'a pas le champ `agent` : son absence VAUT cette
 *  clé, et ce défaut est un contrat de compatibilité, pas une commodité.
 *
 *  Vit ici et non plus dans lib/agents.ts, qui tire fs, path et la clé Foundry :
 *  le prédicat qui s'appuie dessus doit être lisible par lib/rule-config.ts, or
 *  lib/agents.ts importe DÉJÀ rule-config.ts — l'importer en retour ferait un
 *  cycle. Ce module ne dépend de rien, il n'en crée aucun.
 *
 *  Le type `AgentKey` n'est pas décoratif : il est ce qui empêche cette clé de
 *  devenir une troisième liste. Le jour où "guidelines" quitte AGENT_CHOICES,
 *  cette ligne ne compile plus — `tsc` le dit le jour même, au lieu de laisser
 *  un défaut silencieux router les règles vers un agent qui n'existe plus. */
export const GUIDELINES_AGENT_KEY: AgentKey = "guidelines";
