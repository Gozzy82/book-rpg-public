targetScope = 'resourceGroup'

@description('The Azure Developer CLI environment name.')
param environmentName string

@description('The Azure region for all resources.')
param location string

@description('Resource tags.')
param tags object

@description('Microsoft Entra tenant ID.')
param tenantId string

@allowed([
  'openai'
  'xai'
])
param aiProvider string

@secure()
param aiApiKey string

param aiModel string = ''
param indexModel string = ''
param enableSocialAuth bool = false
param entraClientId string = ''

@secure()
param entraClientSecret string = ''

param githubClientId string = ''

@secure()
param githubClientSecret string = ''

var suffix = uniqueString(subscription().id, resourceGroup().id)
var identityName = 'id-bookrpg-${environmentName}'
var registryName = take('acrbookrpg${suffix}', 50)
var storageName = take('stbookrpg${suffix}', 24)
var cosmosName = take('cosmos-bookrpg-${suffix}', 44)
var keyVaultName = take('kv-bookrpg-${suffix}', 24)
var workspaceName = 'log-bookrpg-${environmentName}'
var insightsName = 'appi-bookrpg-${environmentName}'
var environmentNameResource = 'cae-bookrpg-${environmentName}'
var appName = 'ca-bookrpg-${environmentName}'
var databaseName = 'bookrpg'
var gamesContainerName = 'games'
var booksContainerName = 'books'
var entraConfigured = enableSocialAuth && !empty(entraClientId) && !empty(entraClientSecret)
var githubConfigured = enableSocialAuth && !empty(githubClientId) && !empty(githubClientSecret)
var oauthConfigured = entraConfigured || githubConfigured
var aiEnvironmentVariable = aiProvider == 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY'
var keyVaultSecrets = concat(
  [
    {
      name: 'ai-api-key'
      value: aiApiKey
      contentType: 'API key for the configured BookRPG AI provider'
    }
  ],
  entraConfigured
    ? [
        {
          name: 'entra-client-secret'
          value: entraClientSecret
          contentType: 'Container Apps Microsoft identity provider client secret'
        }
      ]
    : [],
  githubConfigured
    ? [
        {
          name: 'github-client-secret'
          value: githubClientSecret
          contentType: 'Container Apps GitHub identity provider client secret'
        }
      ]
    : []
)

module identity 'br/public:avm/res/managed-identity/user-assigned-identity:0.6.0' = {
  name: 'managed-identity'
  params: {
    name: identityName
    location: location
    tags: tags
  }
}

module registry 'br/public:avm/res/container-registry/registry:0.13.0' = {
  name: 'container-registry'
  params: {
    name: registryName
    location: location
    acrSku: 'Basic'
    acrAdminUserEnabled: false
    azureADAuthenticationAsArmPolicyStatus: 'enabled'
    publicNetworkAccess: 'Enabled'
    networkRuleSetDefaultAction: 'Allow'
    roleAssignments: [
      {
        principalId: identity.outputs.principalId
        principalType: 'ServicePrincipal'
        roleDefinitionIdOrName: 'AcrPull'
      }
    ]
    tags: tags
  }
}

module storage 'br/public:avm/res/storage/storage-account:0.33.0' = {
  name: 'book-library-storage'
  params: {
    name: storageName
    location: location
    kind: 'StorageV2'
    skuName: 'Standard_LRS'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    requireInfrastructureEncryption: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    blobServices: {
      containerDeleteRetentionPolicyEnabled: true
      containerDeleteRetentionPolicyDays: 7
      deleteRetentionPolicyEnabled: true
      deleteRetentionPolicyDays: 7
      isVersioningEnabled: true
      containers: [
        {
          name: booksContainerName
          publicAccess: 'None'
        }
      ]
    }
    roleAssignments: [
      {
        principalId: identity.outputs.principalId
        principalType: 'ServicePrincipal'
        roleDefinitionIdOrName: 'Storage Blob Data Reader'
      }
    ]
    tags: tags
  }
}

module cosmos 'br/public:avm/res/document-db/database-account:0.21.1' = {
  name: 'savegame-database'
  params: {
    name: cosmosName
    location: location
    capacityMode: 'Serverless'
    defaultConsistencyLevel: 'Session'
    disableLocalAuthentication: true
    disableKeyBasedMetadataWriteAccess: true
    enableAutomaticFailover: false
    zoneRedundant: false
    networkRestrictions: {
      publicNetworkAccess: 'Enabled'
      networkAclBypass: 'None'
    }
    sqlDatabases: [
      {
        name: databaseName
        containers: [
          {
            name: gamesContainerName
            paths: [
              '/ownerId'
            ]
            defaultTtl: -1
          }
        ]
      }
    ]
    sqlRoleAssignments: [
      {
        principalId: identity.outputs.principalId
        roleDefinitionId: '${resourceId('Microsoft.DocumentDB/databaseAccounts', cosmosName)}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
        scope: '${resourceId('Microsoft.DocumentDB/databaseAccounts', cosmosName)}/dbs/${databaseName}/colls/${gamesContainerName}'
      }
    ]
    tags: tags
  }
}

module keyVault 'br/public:avm/res/key-vault/vault:0.14.0' = {
  name: 'application-key-vault'
  params: {
    name: keyVaultName
    location: location
    sku: 'standard'
    enableRbacAuthorization: true
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    secrets: keyVaultSecrets
    roleAssignments: [
      {
        principalId: identity.outputs.principalId
        principalType: 'ServicePrincipal'
        roleDefinitionIdOrName: 'Key Vault Secrets User'
      }
    ]
    tags: tags
  }
}

module workspace 'br/public:avm/res/operational-insights/workspace:0.16.1' = {
  name: 'log-analytics'
  params: {
    name: workspaceName
    location: location
    skuName: 'PerGB2018'
    dataRetention: 30
    dailyQuotaGb: '1'
    forceCmkForQuery: false
    tags: tags
  }
}

module insights 'br/public:avm/res/insights/component:0.8.0' = {
  name: 'application-insights'
  params: {
    name: insightsName
    location: location
    applicationType: 'web'
    workspaceResourceId: workspace.outputs.resourceId
    retentionInDays: 30
    samplingPercentage: 25
    tags: tags
  }
}

module managedEnvironment 'br/public:avm/res/app/managed-environment:0.15.0' = {
  name: 'container-apps-environment'
  params: {
    name: environmentNameResource
    location: location
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsWorkspaceResourceId: workspace.outputs.resourceId
    }
    tags: tags
  }
}

var containerSecrets = concat(
  [
    {
      name: 'ai-api-key'
      keyVaultUrl: '${keyVault.outputs.uri}secrets/ai-api-key'
      identity: identity.outputs.resourceId
    }
  ],
  entraConfigured
    ? [
        {
          name: 'entra-client-secret'
          keyVaultUrl: '${keyVault.outputs.uri}secrets/entra-client-secret'
          identity: identity.outputs.resourceId
        }
      ]
    : [],
  githubConfigured
    ? [
        {
          name: 'github-client-secret'
          keyVaultUrl: '${keyVault.outputs.uri}secrets/github-client-secret'
          identity: identity.outputs.resourceId
        }
      ]
    : []
)
var containerEnvironment = concat(
  [
    {
      name: 'NODE_ENV'
      value: 'production'
    }
    {
      name: 'BOOKRPG_HOST'
      value: '0.0.0.0'
    }
    {
      name: 'BOOKRPG_PORT'
      value: '8787'
    }
    {
      name: 'BOOKRPG_AUTH_MODE'
      value: 'azure'
    }
    {
      name: 'BOOKRPG_STORAGE_MODE'
      value: 'azure'
    }
    {
      name: 'BOOKRPG_AI_PROVIDER'
      value: aiProvider
    }
    {
      name: 'BOOKRPG_AI_REASONING_EFFORT'
      value: 'minimal'
    }
    {
      name: aiEnvironmentVariable
      secretRef: 'ai-api-key'
    }
    {
      name: 'AZURE_CLIENT_ID'
      value: identity.outputs.clientId
    }
    {
      name: 'AZURE_STORAGE_ACCOUNT_NAME'
      value: storage.outputs.name
    }
    {
      name: 'BOOKRPG_BOOKS_CONTAINER'
      value: booksContainerName
    }
    {
      name: 'COSMOS_ENDPOINT'
      value: cosmos.outputs.endpoint
    }
    {
      name: 'COSMOS_DATABASE'
      value: databaseName
    }
    {
      name: 'COSMOS_GAMES_CONTAINER'
      value: gamesContainerName
    }
    {
      name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
      value: insights.outputs.connectionString
    }
    {
      name: 'BOOKRPG_TELEMETRY_SAMPLING_RATIO'
      value: '0.25'
    }
  ],
  empty(aiModel)
    ? []
    : [
        {
          name: 'BOOKRPG_AI_MODEL'
          value: aiModel
        }
      ],
  empty(indexModel)
    ? []
    : [
        {
          name: 'BOOKRPG_INDEX_MODEL'
          value: indexModel
        }
      ]
)

module containerApp 'br/public:avm/res/app/container-app:0.23.0' = {
  name: 'web-container-app'
  params: {
    name: appName
    location: location
    environmentResourceId: managedEnvironment.outputs.resourceId
    ingressExternal: true
    ingressAllowInsecure: false
    ingressTargetPort: 8787
    ingressTransport: 'auto'
    activeRevisionsMode: 'Single'
    maxInactiveRevisions: 2
    workloadProfileName: 'Consumption'
    managedIdentities: {
      userAssignedResourceIds: [
        identity.outputs.resourceId
      ]
    }
    registries: [
      {
        server: registry.outputs.loginServer
        identity: identity.outputs.resourceId
      }
    ]
    secrets: containerSecrets
    containers: [
      {
        name: 'web'
        image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
        env: containerEnvironment
        resources: {
          cpu: json('0.5')
          memory: '1Gi'
        }
        probes: [
          {
            type: 'Liveness'
            httpGet: {
              path: '/health'
              port: 8787
              scheme: 'HTTP'
            }
            initialDelaySeconds: 15
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
          }
          {
            type: 'Readiness'
            httpGet: {
              path: '/health'
              port: 8787
              scheme: 'HTTP'
            }
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          }
        ]
      }
    ]
    scaleSettings: {
      minReplicas: 0
      maxReplicas: 3
      rules: [
        {
          name: 'http-scaling'
          http: {
            metadata: {
              concurrentRequests: '50'
            }
          }
        }
      ]
    }
    tags: union(tags, {
      'azd-service-name': 'web'
    })
  }
}

module authConfig 'br/public:avm/res/app/container-app/auth-config:0.1.0' = if (oauthConfigured) {
  name: 'social-authentication'
  params: {
    containerAppName: containerApp.outputs.name
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    httpSettings: {
      requireHttps: true
      routes: {
        apiPrefix: '/.auth'
      }
    }
    login: {
      tokenStore: {
        enabled: true
      }
    }
    identityProviders: union(
      entraConfigured
        ? {
          azureActiveDirectory: {
            enabled: true
            registration: {
              clientId: entraClientId
              clientSecretSettingName: 'entra-client-secret'
              openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
            }
          }
        }
        : {},
      githubConfigured
        ? {
          gitHub: {
            enabled: true
            registration: {
              clientId: githubClientId
              clientSecretSettingName: 'github-client-secret'
            }
            login: {
              scopes: [
                'user:email'
              ]
            }
          }
        }
        : {}
    )
  }
}

output containerRegistryEndpoint string = registry.outputs.loginServer
output storageAccountName string = storage.outputs.name
output storageAccountResourceId string = storage.outputs.resourceId
output cosmosAccountName string = cosmosName
output cosmosAccountResourceId string = cosmos.outputs.resourceId
output cosmosEndpoint string = cosmos.outputs.endpoint
output containerAppEnvironmentName string = managedEnvironment.outputs.name
output containerAppName string = containerApp.outputs.name
output applicationUri string = 'https://${containerApp.outputs.fqdn}'
