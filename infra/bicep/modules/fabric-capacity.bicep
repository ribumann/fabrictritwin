metadata description = 'Net-new Fabric capacity (ADR-001) for the Triathlon Training Twin demo'

@description('Azure region for the Fabric capacity. Must support Digital Twin Builder, Fabric Data Agent, Fabric Operations Agent, and Fabric Apps (validated in ADR-010, task T013).')
param location string

@description('Resource name prefix (e.g. "triatwin-dev"). Fabric capacity names must be lowercase alphanumeric only, 3-63 chars.')
@minLength(3)
param namePrefix string

@description('Tags applied to this resource.')
param tags object = {}

@description('Fabric capacity SKU. ADR-001 starts at F4, resizable to F8/F16 if throttling is observed during the demo.')
@allowed(['F2', 'F4', 'F8', 'F16', 'F32', 'F64'])
param skuName string = 'F4'

@description('UPN of the Fabric capacity administrator.')
param adminUpn string

// Fabric capacity names must be lowercase alphanumeric only (no hyphens/underscores).
var capacityName = take(replace(toLower('${namePrefix}fabriccap'), '-', ''), 63)

resource fabricCapacity 'Microsoft.Fabric/capacities@2023-11-01' = {
  // capacityName is always >= 3 chars because namePrefix has @minLength(3) plus the
  // literal 'fabriccap' suffix; the linter can't trace minLength through take()/replace().
  #disable-next-line BCP334
  name: capacityName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: 'Fabric'
  }
  properties: {
    administration: {
      members: [
        adminUpn
      ]
    }
  }
}

output capacityId string = fabricCapacity.id
output capacityName string = fabricCapacity.name
output capacitySkuName string = fabricCapacity.sku.name
