// User-Assigned Managed Identity — identité unique du Container App Sentinel.
// Créée EN PREMIER pour recevoir l'access policy Key Vault avant le déploiement
// de l'app (évite le chicken-and-egg des identités system-assigned lors de la
// résolution des références Key Vault à la création).
// Adapté de v0-moliere_vf/infra/azure/modules/managed-identity.bicep.

@description('Azure region for the identity.')
param location string

@description('Managed identity name.')
param name string

@description('Tags applied to the identity.')
param tags object = {}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

@description('Resource id of the user-assigned managed identity.')
output id string = identity.id

@description('Client id (usable by DefaultAzureCredential in the workload).')
output clientId string = identity.properties.clientId

@description('Principal (object) id used for access policies.')
output principalId string = identity.properties.principalId

@description('Identity name.')
output name string = identity.name
