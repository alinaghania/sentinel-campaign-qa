# Sentinel

QA automatisée des emails de campagne avant envoi.

Une campagne part en production en ~20 déclinaisons (une par langue, avec des liens qui
changent selon le marché). Les relire à la main est long et faillible : un lien mort, un
code promo qui ne correspond pas au brief, une année périmée dans le pied de page, une
déclinaison qui a gardé le texte anglais. Sentinel prend le brief de campagne et les
emails de test reçus dans une boîte mail, et rend pour chaque déclinaison un verdict
**GO / GO avec réserves / NO-GO**, chaque anomalie étant justifiée par une citation
vérifiable dans le contenu.

Stack : Next.js 16 (App Router), React 19, TypeScript strict, Tailwind v4, Vitest.
LLM via Azure AI Foundry (endpoint compatible Anthropic).

---

## Démarrer

```bash
npm install
cp .env.example .env.local     # puis renseigner FOUNDRY_API_KEY
npm run seed                   # jeu de démo (une marque, une campagne, deux versions)
npm run dev                    # http://localhost:3000
```

En local, aucun mot de passe n'est demandé. Sans `FOUNDRY_API_KEY`, l'application tourne
en mode dégradé : les règles déterministes s'exécutent, les agents LLM sont annoncés
comme indisponibles plutôt que silencieusement ignorés.

```bash
npm test          # 522 tests unitaires (29 fichiers)
npx tsc --noEmit  # typage strict
```

---

## La logique

Quatre décisions expliquent la quasi-totalité de la structure du code. Les comprendre
suffit à lire le reste.

### 1. Le LLM ne voit jamais le HTML brut

Un email SFMC fait 100 Ko de HTML tabulaire, de conditionnels Outlook et d'AMPscript.
Le donner tel quel à un modèle produit des hallucinations et coûte cher.

`lib/parse-email.ts` en extrait d'abord des **faits JSON compacts** : liens classés
(statique / tracké / AMPscript) avec leur URL finale après redirections, images et leurs
alt, paramètres UTM, blocs conditionnels Outlook, tokens de personnalisation, textes
visibles. Les agents raisonnent sur ces faits, jamais sur la source.

### 2. Le verdict est déterministe, le LLM ne fait que rédiger

`lib/aggregate.ts` calcule le verdict par une règle mécanique : une anomalie CRITIQUE
non arbitrée par un humain égale NO-GO. Pas de score sur 100, pas de pondération opaque,
et surtout aucun modèle dans la boucle de décision.

Le verdict a **trois** états, pas deux : `GO`, `GO_AVEC_RESERVES`, `NO_GO`. Seul `NO_GO`
bloque l'envoi — d'où la fonction `isBlocking()`, centralisée pour qu'aucun appelant ne
réécrive `verdict !== "GO"`, test qui rangerait les réserves du côté du refus.

Le juge LLM intervient en dernier et uniquement pour *rédiger* le résumé exécutif, streamé
en SSE.

### 3. Toute anomalie LLM doit citer une preuve retrouvable

Chaque finding produit par un agent contient une `evidence`. `lib/structured.ts` la
recherche par sous-chaîne dans les faits extraits. Si la citation est introuvable, le
finding est **rétrogradé** en « à vérifier » au lieu d'être affiché comme un fait. Les
agents sont appelés en tool use forcé avec schéma Zod strict et un retry d'auto-correction.

### 4. Le code est la source de vérité des règles ; la configuration ne stocke que les écarts

La page `/rules` permet à une personne fonctionnelle d'éteindre une règle, de changer sa
sévérité, d'ajuster un seuil ou d'écrire ses propres règles en langage naturel — sans
toucher au code ni redéployer.

Le modèle est un **overlay** : la configuration enregistrée ne contient que les
différences par rapport au catalogue du code. Une règle qui évolue dans le code n'a donc
jamais besoin d'être re-saisie, et une configuration ne peut pas devenir périmée. Aucune
configuration enregistrée signifie un comportement identique au code, à l'octet près.

---

## Le squelette

```
app/                        Routes Next.js (App Router)
  page.tsx                  Accueil : suivi des campagnes, KPI, export Excel
  campaigns/[id]/           Détail d'une campagne : versions, rapport, revue humaine
  campaigns/[id]/brief/     Brief extrait champ par champ (valeur, citation, confiance)
  inbox/                    Boîte de réception, rattachement email vers campagne
  rules/                    Configuration des règles sans code
  brief-template/           Modèle de brief éditable et son glossaire
  brands/                   Marques et compilation d'une charte en règles
  login/                    Saisie de la clé d'accès (production uniquement)
  api/                      Routes serveur, une par ressource

lib/                        Tout le métier. Aucune logique dans les composants.
components/                 Présentation réutilisable
scripts/                    Outillage hors application (seed, extraction, déploiement)
infra/azure/                Infrastructure as code (Bicep)
proxy.ts                    Garde d'accès globale (ex-middleware Next)
```

### Les modules qui comptent

| Fichier | Rôle |
|---|---|
| `lib/analyze.ts` | Orchestrateur. Le point d'entrée à lire en premier. |
| `lib/parse-email.ts` | HTML vers faits JSON compacts. La frontière avec le LLM. |
| `lib/checks-code.ts` | Règles 100 % déterministes. Zéro LLM, zéro hallucination, coût nul. |
| `lib/check-links.ts` | Test HTTP des liens, quatre verdicts, garde SSRF. |
| `lib/agents.ts` | Les sept agents LLM et le juge. Prompts et contrats de sortie. |
| `lib/aggregate.ts` | Déduplication, compteurs, verdict à trois états. |
| `lib/rule-registry.ts` | Assemble les trois catalogues de règles. Point d'entrée unique. |
| `lib/brief-grid.ts` | Parseur déterministe du classeur de brief vers blocs et liens attendus. |
| `lib/store.ts` | Persistance : JSON local en développement, Azure Tables en production. |
| `lib/types.ts` | Le vocabulaire du domaine. À lire avant tout le reste. |

---

## Comment une analyse se déroule

`lib/analyze.ts`, étape par étape. Chaque étape émet un événement consommé en SSE par
l'interface, ce qui rend la progression visible en direct.

**1. Pré-parse** — `parseEmailFacts()` produit les faits JSON. Un `contentHash` est calculé
sur le contenu, la langue et la grille du brief.

**2. Liens** — `checkLinks()` teste chaque URL unique : HEAD puis GET si nécessaire, six en
parallèle, timeout de 8 secondes. Quatre verdicts, pas deux : `ok`, `casse`, `suspect`,
`non_verifiable` — un 403 renvoyé à un bot n'est pas un lien mort, et le prétendre
produirait un faux NO-GO. Une garde SSRF bloque les IP privées et link-local à chaque
redirection. Les liens de désinscription sont exclus du scan : un simple GET
désabonnerait l'adresse de test.

**3. Règles déterministes** — `runCodeChecks()` : lien de désinscription présent, seuil de
troncature Gmail à 102 Ko, placeholders non remplacés, année périmée, AMPscript sans
RedirectTo, cohérence UTM, alt manquants, domaines de marque, mentions obligatoires,
croisement du code promo avec le brief, conformité au modèle de brief. Sur un fichier
`.eml`, `evaluateAuthResults()` lit en plus SPF, DKIM et DMARC depuis l'en-tête
`Authentication-Results`.

**4. Agents LLM en parallèle** — sept agents, chacun sur un périmètre étroit :

| Agent | Périmètre |
|---|---|
| `assets` | Images, alt, cohérence des visuels annoncés |
| `liens` | Incohérences entre texte d'ancre et destination réelle, conformité au brief |
| `tracking` | Valeurs UTM cassées sur les URL finales |
| `brief` | L'email tient-il les promesses du brief (offre, dates, objet, CTA) |
| `guidelines` | Règles éditoriales de la marque, vouvoiement, ton, mentions |
| `translation` | Arbitrage des déclinaisons linguistiques |
| `anomalies` | Balayeur final, passe en dernier |

Chaque agent reçoit la liste de ce qui a déjà été signalé, afin de ne pas produire de
doublons. `anomalies` tourne après les autres pour attraper ce qu'aucun périmètre ne
couvrait.

Les règles éditoriales saisies dans l'outil sont encadrées par un bloc `<editorial_rules>`
et présentées explicitement comme des **données**, jamais comme des instructions — défense
contre l'injection de prompt par le contenu saisi ou par l'email analysé.

**5. Agrégation** — déduplication, compteurs par sévérité, verdict déterministe.

**6. Résumé exécutif** — le juge rédige, streamé en SSE avec un battement de cœur toutes
les 15 secondes pour éviter la coupure des proxys.

**Cache par empreinte** : relancer l'analyse d'un contenu inchangé rejoue le rapport
enregistré instantanément, en mode instantané fidèle (les mêmes événements sont réémis).
C'est aussi le filet en cas d'indisponibilité du service LLM.

---

## Revue humaine

Un rapport n'est pas un verdict final. Chaque anomalie peut être marquée **faux positif**
ou **corrigée**, et le verdict se recalcule. Le bouton de validation reste bloqué tant
qu'une anomalie critique n'a pas été arbitrée.

Les versions successives d'un même email sont comparées : « v1 : 27 anomalies, v2 : 8 ».

---

## Boîte de réception

Trois voies d'ingestion, au choix selon l'environnement :

- **IMAP** (`lib/imap.ts`) — la plus simple, un mot de passe d'application suffit. Attention,
  le port 993 sortant est parfois fermé sur les postes d'entreprise.
- **Gmail API** (`lib/gmail.ts`) — OAuth, `format=raw` puis `mailparser`. En mode Testing
  côté Google, le consentement expire tous les 7 jours et il faut se reconnecter.
- **Microsoft Graph** (`lib/outlook.ts`) — OAuth, `/$value` pour récupérer le MIME complet.

Le rattachement d'un email à une campagne (`lib/match-campaign.ts`) croise plusieurs
signaux — UTM, objet, fenêtre temporelle — et demande une confirmation humaine en cas
d'ambiguïté plutôt que de deviner.

---

## Configuration

Voir `.env.example`. Seule `FOUNDRY_API_KEY` est indispensable pour une analyse complète.

| Variable | Rôle |
|---|---|
| `FOUNDRY_BASE_URL`, `FOUNDRY_API_KEY` | Endpoint LLM compatible Anthropic |
| `FOUNDRY_WORKER_DEPLOYMENT`, `FOUNDRY_JUDGE_DEPLOYMENT` | Modèles des agents et du juge |
| `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_HOST`, `IMAP_PORT` | Relève IMAP |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth Gmail |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | OAuth Outlook |
| `AZURE_TABLES_CONNECTION_STRING` | Production : Azure Tables au lieu du JSON local |
| `DATA_DIR` | Répertoire de persistance, `.data` par défaut |
| `SENTINEL_ACCESS_KEY` | Clé d'accès. Absente en production, tout est bloqué en 503. |
| `QA_EXTENDED` | `1` active l'agent Assets et les règles de qualité générique |
| `RENDER_REAL`, `RENDER_VISION` | Capture navigateur et agent vision, désactivés en conteneur |

---

## Sécurité

- Prévisualisation de l'email dans une iframe `sandbox` sans `allow-scripts`, contenu passé
  par DOMPurify.
- Garde SSRF sur toute vérification de lien, réévaluée à chaque redirection.
- Liens de désinscription jamais requêtés.
- Contenu saisi et contenu de l'email traités comme des données dans les prompts, jamais
  comme des instructions.
- `proxy.ts` : garde d'accès globale par clé unique. Le navigateur présente un cookie
  contenant le SHA-256 de la clé. En production sans clé configurée, tout renvoie 503
  (fail-closed) ; en développement local, passage libre.
- Aucun secret dans le dépôt. Les valeurs de production vivent dans Azure Key Vault et sont
  référencées par URI sans version.

---

## Déploiement

Azure Container Apps. Le détail est dans `scripts/azure/README-AZURE.md`.

```bash
export SUBSCRIPTION_ID=... RG=... ACR_NAME=...
cd scripts/azure
./00-provision.sh            # socle : groupe de ressources, Key Vault, stockage, environnement
./01-seed-keyvault.sh ../../.env.local
./03-migrate-data.sh         # données locales vers le partage Azure Files
./02-deploy.sh               # construction de l'image et déploiement
```

Les identifiants d'infrastructure (subscription, registre, objectId de l'opérateur) ne
sont pas dans le dépôt : ils se passent en variables d'environnement.

Deux pièges à connaître :

- La rotation d'un secret Key Vault exige une **nouvelle révision** du Container App. Un
  simple redémarrage ne relit pas les références sans version.
- Le rendu réel dans Gmail nécessite une session navigateur authentifiée, impossible sur un
  conteneur headless. Les captures se font en local puis sont poussées vers le partage
  Azure (`npm run render:login` puis `npm run push:renders`).

---

## Par où commencer la lecture

1. `lib/types.ts` — le vocabulaire du domaine.
2. `lib/analyze.ts` — l'orchestrateur, qui appelle tout le reste dans l'ordre.
3. `lib/parse-email.ts` — la frontière entre le HTML et le LLM.
4. `lib/aggregate.ts` — 73 lignes, où se décide le verdict.
5. `lib/__tests__/pipeline.test.ts` — la chaîne complète exercée bout en bout.

Les fichiers portent un commentaire d'en-tête qui explique **pourquoi** ils sont écrits
ainsi, pas seulement ce qu'ils font. C'est la documentation la plus à jour du dépôt.
