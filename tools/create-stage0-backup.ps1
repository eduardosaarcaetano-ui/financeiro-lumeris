[CmdletBinding()]
param(
  [string]$RepositoryPath = (Split-Path -Parent $PSScriptRoot),
  [string]$BackupBasePath = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'ERP-Lumeris-Backups'),
  [string]$SyncEndpoint = 'https://erp-lumeris.vercel.app/api/sync'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path -LiteralPath $RepositoryPath).Path
$backupBase = [System.IO.Path]::GetFullPath($BackupBasePath)

if ($backupBase.StartsWith($repository, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'O backup deve ficar fora do repositório.'
}

$dirty = git -C $repository status --porcelain
if ($LASTEXITCODE -ne 0) {
  throw 'Não foi possível consultar o repositório Git.'
}
if ($dirty) {
  throw 'O repositório possui alterações não registradas. Interrompido para evitar backup incompleto.'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$destination = Join-Path $backupBase "stage0-$timestamp"
New-Item -ItemType Directory -Path $destination | Out-Null

$bundlePath = Join-Path $destination 'financeiro-lumeris.git.bundle'
$statePath = Join-Path $destination 'production-sync-state.json'
$restorePath = Join-Path $destination 'restore-test-code'
$manifestPath = Join-Path $destination 'manifest.json'

git -C $repository bundle create $bundlePath --all
if ($LASTEXITCODE -ne 0) {
  throw 'Falha ao criar o bundle Git.'
}

$response = Invoke-WebRequest -Uri $SyncEndpoint -Method Get -UseBasicParsing -TimeoutSec 120
if ($response.StatusCode -ne 200) {
  throw "A exportação retornou HTTP $($response.StatusCode)."
}

[System.IO.File]::WriteAllText(
  $statePath,
  [string]$response.Content,
  [System.Text.UTF8Encoding]::new($false)
)

$payload = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if (-not $payload.data) {
  throw 'A exportação não contém o campo data esperado.'
}

$counts = [ordered]@{}
foreach ($property in $payload.data.PSObject.Properties) {
  if ($property.Value -is [array]) {
    $counts[$property.Name] = $property.Value.Count
  }
}

git clone --quiet $bundlePath $restorePath
if ($LASTEXITCODE -ne 0) {
  throw 'Falha ao restaurar o bundle Git.'
}

$sourceHead = (git -C $repository rev-parse HEAD).Trim()
$restoredHead = (git -C $restorePath rev-parse HEAD).Trim()
if ($sourceHead -ne $restoredHead) {
  throw 'O commit restaurado é diferente do commit de origem.'
}

git -C $restorePath fsck --full --no-dangling
if ($LASTEXITCODE -ne 0) {
  throw 'A verificação do repositório restaurado falhou.'
}

$manifest = [ordered]@{
  createdAt = (Get-Date).ToString('o')
  source = $SyncEndpoint
  gitCommit = $sourceHead
  applicationVersion = $payload.version
  applicationUpdatedAt = $payload.updatedAt
  applicationRevision = $payload.revision
  counts = $counts
  files = [ordered]@{
    gitBundle = [ordered]@{
      name = (Split-Path -Leaf $bundlePath)
      bytes = (Get-Item -LiteralPath $bundlePath).Length
      sha256 = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash
    }
    applicationState = [ordered]@{
      name = (Split-Path -Leaf $statePath)
      bytes = (Get-Item -LiteralPath $statePath).Length
      sha256 = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
    }
  }
  limitations = @(
    'A exportação da aplicação não substitui pg_dump.',
    'sync_mutations e sync_state_backups exigem backup PostgreSQL separado.',
    'O conteúdo possui dados confidenciais e não deve ser enviado ao Git.'
  )
}

[System.IO.File]::WriteAllText(
  $manifestPath,
  ($manifest | ConvertTo-Json -Depth 8),
  [System.Text.UTF8Encoding]::new($false)
)

Write-Output "Backup criado e verificado em: $destination"
