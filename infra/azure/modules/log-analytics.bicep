// Log Analytics workspace — stockage des logs de l'environnement Container Apps.
// Adapté de v0-moliere_vf/infra/azure/modules/log-analytics.bicep.

@description('Azure region for the workspace.')
param location string

@description('Workspace name.')
param name string

@description('Tags applied to the workspace.')
param tags object = {}

@description('Daily ingestion cap in GB. -1 disables the cap.')
param dailyQuotaGb int = -1

@description('Log retention in days.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

@description('Resource id of the Log Analytics workspace.')
output id string = workspace.id

@description('Customer (workspace) id used by the Container Apps Environment.')
output customerId string = workspace.properties.customerId

@description('Workspace name.')
output name string = workspace.name
