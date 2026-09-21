targetScope = 'subscription'

@minLength(1)
@description('The Azure Developer CLI environment name.')
param environmentName string

@description('The Azure region for all resources.')
param location string = 'westeurope'

@allowed([
  'openai'
  'xai'
])
@description('AI provider used by the game engine.')
param aiProvider string = 'openai'

@secure()
@description('API key for the configured AI provider.')
param aiApiKey string

@description('Optional model override for the configured AI provider.')
param aiModel string = ''

@description('Optional stronger model used only for book analysis and indexing.')
param indexModel string = ''

@description('Enable configured Container Apps built-in authentication providers.')
param enableSocialAuth bool = false

@description('Microsoft Entra application client ID.')
param entraClientId string = ''

@description('Optional Microsoft Entra issuer URL override. Use the ciamlogin.com issuer from External ID user-flow metadata.')
param entraIssuerUrl string = ''

@secure()
@description('Microsoft Entra application client secret.')
param entraClientSecret string = ''

@description('GitHub OAuth application client ID.')
param githubClientId string = ''

@secure()
@description('GitHub OAuth application client secret.')
param githubClientSecret string = ''

var resourceGroupName = 'rg-bookrpg-${environmentName}'
var tags = {
  'azd-env-name': environmentName
  application: 'bookrpg'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module application 'modules/application.bicep' = {
  name: 'bookrpg-application'
  scope: resourceGroup
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    tenantId: tenant().tenantId
    aiProvider: aiProvider
    aiApiKey: aiApiKey
    aiModel: aiModel
    indexModel: indexModel
    enableSocialAuth: enableSocialAuth
    entraClientId: entraClientId
    entraIssuerUrl: entraIssuerUrl
    entraClientSecret: entraClientSecret
    githubClientId: githubClientId
    githubClientSecret: githubClientSecret
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = application.outputs.containerRegistryEndpoint
output AZURE_CONTAINER_APP_ENVIRONMENT_NAME string = application.outputs.containerAppEnvironmentName
output SERVICE_WEB_NAME string = application.outputs.containerAppName
output SERVICE_WEB_URI string = application.outputs.applicationUri
output BOOKRPG_AUTH_CALLBACK_BASE_URL string = application.outputs.applicationUri
output AZURE_STORAGE_ACCOUNT_NAME string = application.outputs.storageAccountName
output AZURE_STORAGE_ACCOUNT_RESOURCE_ID string = application.outputs.storageAccountResourceId
output COSMOS_ACCOUNT_NAME string = application.outputs.cosmosAccountName
output COSMOS_ACCOUNT_RESOURCE_ID string = application.outputs.cosmosAccountResourceId
output COSMOS_ENDPOINT string = application.outputs.cosmosEndpoint
