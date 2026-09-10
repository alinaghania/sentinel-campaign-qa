# Sentinel sur Azure — Runbook

Déploiement de Sentinel (QA campagnes SFMC, Next.js 16) sur Azure Container
Apps. Subscription, resource group et région sont passés en variables
d'environnement aux scripts (voir ci-dessous) : rien n'est codé en dur.

## Architecture

| Ressource | Nom | Rôle |
|---|---|---|
| Container App | `sentinel-web` | Next.js standalone, port 3000, 1 réplique fixe |
| Container Apps env | `sentinel-env` | plan d'exécution + lien Azure Files `sentineldata` |
| Key Vault | `sentinel-kv-<suffix>` | FOUNDRY-API-KEY, GOOGLE-CLIENT-SECRET, SENTINEL-ACCESS-KEY |
| Storage (Azure Files) | `sentinelst<suffix>` / share `sentinel-data` | persistance `.data` montée sur `/app/.data` (SMB) |
| Log Analytics | `sentinel-logs` | logs console/system |
| Managed Identity | `sentinel-identity` | résolution des références Key Vault |
| ACR (registre EXISTANT, réutilisé) | `$ACR_NAME` | repo image `sentinel-web` |

## Ordre de déploiement

```bash
cd scripts/azure
./00-provision.sh                  # socle (RG, KV, storage, env) — deployApp=false
./01-seed-keyvault.sh ../../.env.local   # secrets KV (jamais affichés)
./03-migrate-data.sh               # .data -> share (exclut renders/ et jobs/)
./02-deploy.sh                     # az acr build + deployApp=true
```

## Accès (access key)

L'app est protégée par `proxy.ts` : cookie `sentinel_auth` (SHA-256 de la clé)
posé par la page `/login`. La clé d'accès est générée au seed et stockée UNIQUEMENT
dans Key Vault. Pour la récupérer :

```bash
az keyvault secret show \
  --vault-name "$(az keyvault list -g sentinel-rg --query '[0].name' -o tsv)" \
  --name SENTINEL-ACCESS-KEY --query value -o tsv
```

### Rotation de l'access key

```bash
KV=$(az keyvault list -g sentinel-rg --query '[0].name' -o tsv)
openssl rand -hex 16 | az keyvault secret set --vault-name "$KV" \
  --name SENTINEL-ACCESS-KEY --file /dev/stdin -o none
# Les références KV sont versionless : un restart de révision recharge la valeur.
az containerapp revision restart -g sentinel-rg -n sentinel-web \
  --revision "$(az containerapp revision list -g sentinel-rg -n sentinel-web --query '[0].name' -o tsv)"
```

Le cookie a une durée de vie de 30 jours ; après rotation, tous les navigateurs
doivent se reconnecter avec la nouvelle clé.

## Exploitation

```bash
# Logs en direct
az containerapp logs show -g sentinel-rg -n sentinel-web --follow
# Dernières lignes
az containerapp logs show -g sentinel-rg -n sentinel-web --tail 100
# État des révisions
az containerapp revision list -g sentinel-rg -n sentinel-web -o table
# Restart (recharge aussi les secrets KV)
az containerapp revision restart -g sentinel-rg -n sentinel-web --revision <nom>
```

## Google OAuth (Gmail)

- Redirect URI à enregistrer dans la Google Cloud Console (client OAuth existant) :
  `https://sentinel-web.<defaultDomain>/api/auth/google/callback`
  (affichée par `02-deploy.sh` ; le callback reste derrière le cookie d'accès).
- L'app Google étant en mode "testing", le refresh token Gmail expire au bout
  de **7 jours** : re-connecter Gmail depuis l'UI (Inbox → connect) chaque semaine.

## Limites connues

- **Rendu réel indisponible sur Azure** : `RENDER_REAL=0`. Playwright n'est pas
  dans l'image et le profil navigateur (`.playwright/`) n'est pas migré. Les
  screenshots Gmail/Outlook réels se génèrent uniquement en local.
- **1 réplique fixe** (min=max=1) : le store fichier n'est pas multi-writer.
  Ne pas augmenter le scale.
- **Perf SMB** : `.data` est sur Azure Files (mountOptions `nobrl,actimeo=30…`).
  Les listages massifs (inbox ~876 fichiers) sont plus lents qu'en local.
- **Données** : `renders/` et `jobs/` ne sont pas migrés (régénérables/transients).

## Coût estimé

- Container App 1 vCPU / 2 GiB, 1 réplique 24/7 : ~35-45 €/mois
- Azure Files LRS 10 GiB + transactions : ~1-3 €/mois
- Log Analytics (PerGB2018, faible volume) : < 5 €/mois
- Key Vault / identity : négligeable
- ACR : partagé avec Molière (déjà payé)

Total ≈ **40-50 €/mois**. Pour suspendre : `az containerapp update -g sentinel-rg
-n sentinel-web --min-replicas 0 --max-replicas 0` (ou supprimer le RG hors ACR).

## Rendu réel Gmail sur Azure — flux hybride (local → push)

Le vrai rendu Gmail web exige une session Google connectée dans un navigateur :
impossible sur un conteneur Azure headless (anti-bot Google). On capture donc en
LOCAL et on pousse les screenshots vers le partage Azure Files.

Flux :
1. En local, une fois : `npm run render:login` (connexion Gmail dans la fenêtre).
2. Lancer une analyse locale (dev :3000) sur la/les campagne(s) voulues → les
   screenshots (vrai Gmail desktop + 4 largeurs mobiles) sont écrits dans
   `.data/renders/<versionId>/`.
3. Pousser vers l'app cloud : `npm run push:renders`  (ou une seule version :
   `npm run push:renders -- <versionId>`).
4. Les captures apparaissent dans l'app Azure (onglet Email + export Excel
   « Screenshots »), servies telles quelles.

Note : l'app Azure elle-même tourne avec `RENDER_REAL=0` (elle ne tente jamais
d'ouvrir Gmail) — les screenshots viennent uniquement du push. Re-pousser après
chaque nouvelle analyse locale dont on veut les visuels sur le cloud.
