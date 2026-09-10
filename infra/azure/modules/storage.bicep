// Compte de stockage + Azure Files — persistance du répertoire .data de
// Sentinel (campagnes, briefs, rapports, inbox, tokens...) monté en volume
// SMB dans le Container App.
//
// La CLÉ du compte n'est JAMAIS exposée en output : main.bicep la lit via
// listKeys() pour la passer au lien storage de l'environnement Container Apps.

@description('Azure region for the storage account.')
param location string

@description('Storage account name. Globally unique, 3-24 chars, lowercase alphanumeric only.')
@minLength(3)
@maxLength(24)
param name string

@description('Tags applied to the account.')
param tags object = {}

@description('Azure Files share name mounted by the Container App.')
param shareName string = 'sentinel-data'

@description('Share quota in GiB.')
param shareQuotaGib int = 10

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: shareName
  properties: {
    shareQuota: shareQuotaGib
    enabledProtocols: 'SMB'
  }
}

@description('Resource id of the storage account.')
output id string = storageAccount.id

@description('Storage account name.')
output name string = storageAccount.name

@description('File share name.')
output shareName string = share.name
