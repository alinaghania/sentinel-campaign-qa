// Environnement managé Container Apps + lien Azure Files ("storages").
// Le lien `sentineldata` expose le share SMB à l'environnement ; le Container
// App le référence ensuite par storageName dans ses volumes.
// Adapté de v0-moliere_vf/infra/azure/modules/container-env.bicep (+ storages).

@description('Azure region for the environment.')
param location string

@description('Container Apps Environment name.')
param name string

@description('Tags applied to the environment.')
param tags object = {}

@description('Customer (workspace) id of the Log Analytics workspace.')
param logAnalyticsCustomerId string

@description('Resource id of the Log Analytics workspace (for the shared key lookup).')
param logAnalyticsWorkspaceId string

@description('Storage account name backing the Azure Files link.')
param storageAccountName string

@description('Azure Files share name.')
param shareName string

@description('Name of the environment storage link referenced by the app volumes.')
param storageLinkName string = 'sentineldata'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        // listKeys sur la ressource workspace ; jamais en dur.
        sharedKey: listKeys(logAnalyticsWorkspaceId, '2023-09-01').primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

resource storageLink 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: storageLinkName
  properties: {
    azureFile: {
      accountName: storageAccountName
      // Clé lue à la volée via listKeys sur le compte (même resource group) ;
      // jamais en paramètre ni en output.
      accountKey: listKeys(
        resourceId('Microsoft.Storage/storageAccounts', storageAccountName),
        '2023-05-01'
      ).keys[0].value
      shareName: shareName
      accessMode: 'ReadWrite'
    }
  }
}

@description('Resource id of the managed environment.')
output id string = environment.id

@description('Default ingress domain (e.g. <random>.<region>.azurecontainerapps.io).')
output defaultDomain string = environment.properties.defaultDomain

@description('Environment name.')
output name string = environment.name

@description('Storage link name to reference from Container App volumes.')
output storageLinkName string = storageLink.name
