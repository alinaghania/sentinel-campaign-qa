// Azure Container App Sentinel (Next.js standalone, port 3000).
//
// Pattern Molière (v0-moliere_vf/infra/azure/modules/container-app.bicep) :
//   - secrets[] = références Key Vault (keyVaultUrl versionless + identity),
//     chacune exposée en variable d'env via secretRef → le code lit
//     process.env.X sans modification ;
//   - registre ACR via credentials admin (les role assignments AcrPull sont
//     interdits sur cette subscription) ;
//   - probes HTTP startup/liveness/readiness sur /api/health.
//
// Spécifique Sentinel :
//   - volume Azure Files monté sur /app/.data (stockage fichier de lib/store.ts).
//     mountOptions : nobrl+mfsymlinks+cache verrous SMB compatibles SQLite-like
//     I/O, uid/gid 1001 = user nextjs du Dockerfile, modes restrictifs ;
//   - min=max=1 réplique : le store fichier n'est PAS multi-writer safe.
//
// AUCUNE valeur de secret dans ce template — uniquement des URI Key Vault.

@description('Azure region for the app.')
param location string

@description('Container App name.')
param name string

@description('Tags applied to the app.')
param tags object = {}

@description('Resource id of the Container Apps managed environment.')
param environmentId string

@description('Resource id of the User-Assigned Managed Identity used for Key Vault references.')
param identityId string

@description('ACR login server (e.g. myregistry.azurecr.io).')
param registryLoginServer string

@description('ACR admin username.')
param registryUsername string

@description('ACR admin password, injected as a Container App secret named acr-password.')
@secure()
param registryPassword string

@description('Fully qualified container image.')
param image string

@description('Container TCP port the app listens on.')
param targetPort int = 3000

@description('Expose ingress to the public internet.')
param externalIngress bool = true

@description('Non-secret environment variables (name/value pairs).')
param env array = []

// Secrets référencés depuis Key Vault, chacun exposé en env var.
// Forme de chaque item :
//   {
//     envName: 'FOUNDRY_API_KEY'      // variable lue par le code
//     secretName: 'foundry-api-key'   // nom du secret Container App (minuscules)
//     keyVaultUrl: 'https://<vault>.vault.azure.net/secrets/FOUNDRY-API-KEY' // SANS version
//   }
@description('List of Key Vault-referenced secrets to expose as env vars.')
param keyVaultSecrets array = []

@description('Environment storage link name (Microsoft.App/managedEnvironments/storages) for the data volume.')
param dataStorageName string = 'sentineldata'

@description('Mount path of the data volume inside the container.')
param dataMountPath string = '/app/.data'

@description('CPU cores per replica.')
param cpu string = '1.0'

@description('Memory per replica.')
param memory string = '2Gi'

@description('Relative path of the HTTP health endpoint (returns 200 without auth).')
param healthPath string = '/api/health'

// ---------------------------------------------------------------------------
// secrets[] : références Key Vault résolues par la User-Assigned identity.
// ---------------------------------------------------------------------------
var kvAppSecrets = [
  for s in keyVaultSecrets: {
    name: s.secretName
    keyVaultUrl: s.keyVaultUrl
    identity: identityId
  }
]

// Mot de passe ACR en secret Container App simple (utilisé par registries).
var appSecrets = concat(kvAppSecrets, [
  {
    name: 'acr-password'
    value: registryPassword
  }
])

// Chaque secret Key Vault devient une env var via secretRef.
var secretEnv = [
  for s in keyVaultSecrets: {
    name: s.envName
    secretRef: s.secretName
  }
]

var allEnv = concat(env, secretEnv)

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: appSecrets
      ingress: {
        external: externalIngress
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        stickySessions: {
          affinity: 'none'
        }
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registryLoginServer
          username: registryUsername
          passwordSecretRef: 'acr-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: allEnv
          volumeMounts: [
            {
              volumeName: 'data'
              mountPath: dataMountPath
            }
          ]
          // Probes : startup généreuse pour laisser Next démarrer (montage SMB
          // inclus), readiness gate le trafic, liveness redémarre si blocage.
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: healthPath
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 12
            }
            {
              type: 'Liveness'
              httpGet: {
                path: healthPath
                port: targetPort
                scheme: 'HTTP'
              }
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: healthPath
                port: targetPort
                scheme: 'HTTP'
              }
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: dataStorageName
          // nobrl/mfsymlinks : évite les erreurs de verrous byte-range SMB sur
          // les writes atomiques du store ; uid/gid 1001 = user nextjs.
          // NB : `actimeo` refusé par la validation ACA (ContainerAppVolume-
          // MountOptionsNotSupported) → retiré, cache=strict fait le travail.
          mountOptions: 'nobrl,mfsymlinks,cache=strict,nosharesock,uid=1001,gid=1001,dir_mode=0700,file_mode=0600'
        }
      ]
      // min=max=1 : store fichier mono-writer (pas de scale horizontal).
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

@description('Resource id of the Container App.')
output id string = app.id

@description('Public FQDN of the app ingress.')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Full https URL of the app.')
output url string = 'https://${app.properties.configuration.ingress.fqdn}'

@description('Container App name.')
output name string = app.name
