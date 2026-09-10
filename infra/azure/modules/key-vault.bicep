// Azure Key Vault — secrets Sentinel (FOUNDRY-API-KEY, GOOGLE-CLIENT-SECRET,
// SENTINEL-ACCESS-KEY). AUCUNE valeur de secret ici : elles sont peuplées hors
// bande par l'opérateur (scripts/azure/01-seed-keyvault.sh).
//
// Access policies (PAS RBAC) : le rôle Contributor de cette subscription n'a
// pas Microsoft.Authorization/roleAssignments/write, donc la Managed Identity
// reçoit la lecture des secrets via une access policy. Les références Key
// Vault de Container Apps fonctionnent à l'identique.
// Adapté de v0-moliere_vf/infra/azure/modules/key-vault.bicep.

@description('Azure region for the vault.')
param location string

@description('Key Vault name. Globally unique, 3-24 chars, alphanumeric + hyphen.')
@minLength(3)
@maxLength(24)
param name string

@description('Tags applied to the vault.')
param tags object = {}

@description('Tenant id that owns the vault.')
param tenantId string = subscription().tenantId

@description('Principal id of the managed identity granted secret read access.')
param readerPrincipalId string

@description('Operator (human user) objectId granted secret management so bicep redeploys do not wipe operator access. Empty to skip.')
param operatorObjectId string = ''

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: false
    accessPolicies: concat([
      {
        tenantId: tenantId
        objectId: readerPrincipalId
        permissions: {
          secrets: [
            'get'
          ]
        }
      }
    ], empty(operatorObjectId) ? [] : [
      {
        tenantId: tenantId
        objectId: operatorObjectId
        permissions: {
          secrets: [
            'get'
            'list'
            'set'
            'delete'
          ]
        }
      }
    ])
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    // Purge protection EXIGÉE par la policy d'organisation
    // (cns-cep-391-deny-keyvault-softdelete-purgeprotection-disabled).
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

@description('Resource id of the Key Vault.')
output id string = vault.id

@description('Vault URI (e.g. https://sentinel-kv-xxxx.vault.azure.net/).')
output vaultUri string = vault.properties.vaultUri

@description('Vault name.')
output name string = vault.name
