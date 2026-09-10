// Sentinel — composition d'infrastructure Azure (scope resource group).
//
// Provisionne le plan d'hébergement du studio QA Sentinel (Next.js 16) :
//   Log Analytics -> Container Apps Environment (+ lien Azure Files)
//   User-Assigned Managed Identity (créée EN PREMIER)
//   Key Vault      (access policies, PAS de RBAC — interdit sur la sub)
//   Storage        (Azure Files share sentinel-data, 10 GiB, monté /app/.data)
//   sentinel-web   Container App (port 3000, ingress externe, secrets via
//                   références Key Vault, 1 réplique fixe)
//
// Un ACR EXISTANT est RÉUTILISÉ : aucun ACR n'est créé ici ; le login server
// et les credentials admin sont passés en paramètres (le mot de passe en
// @secure, jamais dans un fichier).
//
// AUCUNE valeur de secret dans ce template. Les secrets sont peuplés hors
// bande dans Key Vault (scripts/azure/01-seed-keyvault.sh) puis référencés
// par URI versionless.

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------
@description('Azure region for all resources.')
param location string = 'francecentral'

@description('Short prefix used to name resources. Lowercase alphanumeric.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'sentinel'

@description('Globally-unique suffix to disambiguate Key Vault / storage names.')
param uniqueSuffix string = uniqueString(resourceGroup().id)

@description('Tags applied to every resource.')
param tags object = {
  product: 'sentinel'
  managedBy: 'bicep'
}

@description('Deploy the sentinel-web Container App. false on the bootstrap deploy (socle only), true once the image is pushed and Key Vault is seeded.')
param deployApp bool = false

@description('Operator (human user) objectId kept in the Key Vault access policies so secrets can be seeded across redeploys. Get it with: az ad signed-in-user show --query id -o tsv')
param operatorObjectId string

@description('ACR login server of the registry hosting the image (an existing registry is reused; none is created here).')
param registryLoginServer string

@description('ACR admin username. Required when deployApp=true.')
param registryUsername string = ''

@description('ACR admin password. Injected as a Container App secret. Required when deployApp=true.')
@secure()
param registryPassword string = ''

@description('Fully qualified container image (e.g. myregistry.azurecr.io/sentinel-web:TAG). Required when deployApp=true.')
param webImage string = ''

@description('Google OAuth redirect URI (non-secret) — must be registered in the Google Cloud Console.')
param googleRedirectUri string = ''

// Config non-secrète lue par le code (valeurs par défaut = .env.local actuel ;
// les URL de base et noms de deployments ne sont pas des secrets).
@description('Azure AI Foundry base URL (non-secret).')
param foundryBaseUrl string = 'https://flux-studio.cognitiveservices.azure.com/anthropic/'

@description('Foundry worker deployment name (non-secret).')
param foundryWorkerDeployment string = 'claude-opus-4-6'

@description('Foundry judge deployment name (non-secret).')
param foundryJudgeDeployment string = 'claude-opus-4-8'

@description('Google OAuth client id (non-secret).')
param googleClientId string = '784465361384-cppcarauvph1ft8to4drpephqgb1e0it.apps.googleusercontent.com'

// Relève IMAP de la boîte Gmail (voie alternative à OAuth, cf. README). Le mot de passe d'application est un SECRET : il
// passe par Key Vault comme les trois autres, jamais par un paramètre de
// template. Ces valeurs par défaut sont non-secrètes et suffisent : un
// redéploiement sans les repasser reconstruit donc l'état actuel à l'identique
// au lieu de faire disparaître la bascule IMAP.
@description('Gmail mailbox read over IMAP (non-secret). Empty disables the IMAP path and falls back to the Gmail API + OAuth.')
param imapUser string = 'acnkering@gmail.com'

@description('IMAP host (non-secret).')
param imapHost string = 'imap.gmail.com'

@description('IMAP port (non-secret).')
param imapPort string = '993'

@description('Audit qualité étendu. "1" allume l\'agent Assets & images et les règles extendedOnly (qualité générique : alt manquants, année de copyright...). "0" les éteint. Absente du conteneur jusqu\'au 04/09/2026 : l\'agent Assets était donc éteint en production sans que le rapport le dise.')
@allowed([
  '0'
  '1'
])
param qaExtended string = '1'

// ---------------------------------------------------------------------------
// Noms dérivés
// ---------------------------------------------------------------------------
var logName = '${namePrefix}-logs'
var identityName = '${namePrefix}-identity'
var keyVaultName = take(toLower('${namePrefix}-kv-${uniqueSuffix}'), 24)
// Compte de stockage : minuscules + chiffres uniquement, 24 max.
var storageName = take(toLower('${namePrefix}st${uniqueSuffix}'), 24)
var envName = '${namePrefix}-env'
var webAppName = '${namePrefix}-web'
var shareName = 'sentinel-data'
var storageLinkName = 'sentineldata'

// ---------------------------------------------------------------------------
// Identité (créée en premier ; access policy accordée dans key-vault)
// ---------------------------------------------------------------------------
module identity 'modules/managed-identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    name: identityName
    tags: tags
  }
}

// ---------------------------------------------------------------------------
// Observabilité + secrets + stockage
// ---------------------------------------------------------------------------
module logs 'modules/log-analytics.bicep' = {
  name: 'logs'
  params: {
    location: location
    name: logName
    tags: tags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'keyVault'
  params: {
    location: location
    name: keyVaultName
    tags: tags
    readerPrincipalId: identity.outputs.principalId
    operatorObjectId: operatorObjectId
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    name: storageName
    tags: tags
    shareName: shareName
    shareQuotaGib: 10
  }
}

// ---------------------------------------------------------------------------
// Environnement Container Apps + lien Azure Files
// ---------------------------------------------------------------------------
module containerEnv 'modules/container-env.bicep' = {
  name: 'containerEnv'
  params: {
    location: location
    name: envName
    tags: tags
    logAnalyticsCustomerId: logs.outputs.customerId
    logAnalyticsWorkspaceId: logs.outputs.id
    storageAccountName: storage.outputs.name
    shareName: storage.outputs.shareName
    storageLinkName: storageLinkName
  }
}

// ---------------------------------------------------------------------------
// Références Key Vault pour sentinel-web (URI versionless — la rotation d'un
// secret est prise en compte au prochain restart de révision).
// ---------------------------------------------------------------------------
var kvUri = keyVault.outputs.vaultUri

var webKeyVaultSecrets = concat([
  {
    envName: 'FOUNDRY_API_KEY'
    secretName: 'foundry-api-key'
    keyVaultUrl: '${kvUri}secrets/FOUNDRY-API-KEY'
  }
  {
    envName: 'GOOGLE_CLIENT_SECRET'
    secretName: 'google-secret'
    keyVaultUrl: '${kvUri}secrets/GOOGLE-CLIENT-SECRET'
  }
  {
    envName: 'SENTINEL_ACCESS_KEY'
    secretName: 'access-key'
    keyVaultUrl: '${kvUri}secrets/SENTINEL-ACCESS-KEY'
  }
], empty(imapUser) ? [] : [
  // Mot de passe d'application Google. Le template ne porte que l'URI : la
  // valeur est peuplée hors bande (scripts/azure/01-seed-keyvault.sh), donc un
  // redéploiement est idempotent et ne peut pas effacer la bascule IMAP.
  // Si le secret manque dans le coffre, le déploiement ÉCHOUE bruyamment —
  // c'est voulu, un échec visible vaut mieux qu'un retour silencieux à OAuth.
  {
    envName: 'IMAP_PASSWORD'
    secretName: 'imap-app-password'
    keyVaultUrl: '${kvUri}secrets/IMAP-APP-PASSWORD'
  }
])

// Env non-secrètes. PAS de DATA_DIR (défaut .data → /app/.data monté) ni
// AZURE_TABLES_CONNECTION_STRING. RENDER_REAL=0 : pas de Playwright sur Azure.
//
// Toute variable qui GOUVERNE UN AGENT doit figurer ici, y compris pour
// l'éteindre : mesuré le 03/09/2026 sur les 40 rapports nés sur Azure, l'agent
// "Assets & images" affichait 0 exécution sur 40 (contre 18/129 avant la
// migration) parce que QA_EXTENDED n'existait pas dans le conteneur — une
// variable absente vaut "0" sans que rien ne le signale. Une valeur explicite
// se relit ; une absence, non.
var webEnv = concat([
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'FOUNDRY_BASE_URL'
    value: foundryBaseUrl
  }
  {
    name: 'FOUNDRY_WORKER_DEPLOYMENT'
    value: foundryWorkerDeployment
  }
  {
    name: 'FOUNDRY_JUDGE_DEPLOYMENT'
    value: foundryJudgeDeployment
  }
  {
    name: 'GOOGLE_CLIENT_ID'
    value: googleClientId
  }
  {
    name: 'GOOGLE_REDIRECT_URI'
    value: googleRedirectUri
  }
  {
    name: 'RENDER_REAL'
    value: '0'
  }
  {
    name: 'QA_EXTENDED'
    value: qaExtended
  }
], empty(imapUser) ? [] : [
  {
    name: 'IMAP_USER'
    value: imapUser
  }
  {
    name: 'IMAP_HOST'
    value: imapHost
  }
  {
    name: 'IMAP_PORT'
    value: imapPort
  }
])

// ---------------------------------------------------------------------------
// sentinel-web Container App
// ---------------------------------------------------------------------------
module web 'modules/container-app.bicep' = if (deployApp) {
  name: 'web'
  params: {
    location: location
    name: webAppName
    tags: tags
    environmentId: containerEnv.outputs.id
    identityId: identity.outputs.id
    registryLoginServer: registryLoginServer
    registryUsername: registryUsername
    registryPassword: registryPassword
    image: webImage
    targetPort: 3000
    externalIngress: true
    env: webEnv
    keyVaultSecrets: webKeyVaultSecrets
    dataStorageName: containerEnv.outputs.storageLinkName
    dataMountPath: '/app/.data'
    cpu: '1.0'
    memory: '2Gi'
    healthPath: '/api/health'
  }
}

// ---------------------------------------------------------------------------
// Outputs (aucun secret)
// ---------------------------------------------------------------------------
@description('Container Apps environment default ingress domain.')
output containerEnvDefaultDomain string = containerEnv.outputs.defaultDomain

@description('Key Vault name — seed secrets here before deploying the app.')
output keyVaultName string = keyVault.outputs.name

@description('Key Vault URI.')
output keyVaultUri string = keyVault.outputs.vaultUri

@description('Storage account name backing the sentinel-data share.')
output storageAccountName string = storage.outputs.name

@description('Azure Files share name.')
output shareName string = storage.outputs.shareName

@description('Managed identity principal id.')
output identityPrincipalId string = identity.outputs.principalId

@description('Public URL of the Sentinel web app (empty until deployApp=true).')
output webUrl string = web.?outputs.url ?? ''
