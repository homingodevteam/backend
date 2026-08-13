param(
  [string]$BaseUrl = 'http://127.0.0.1:53013/api/v1'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $repoRoot '.geo-postman-runtime'
$pgData = Join-Path $runtime 'postgres'
$pgLog = Join-Path $runtime 'postgres.log'
$appLog = Join-Path $runtime 'app.log'
$redisLog = Join-Path $runtime 'redis.log'
$geocoderLog = Join-Path $runtime 'geocoder.log'
$runtimeEnvironment = Join-Path $runtime 'environment.json'
$newmanReport = Join-Path $runtime 'newman-report.json'
$evidenceReport = Join-Path $repoRoot 'postman\reports\Homingo-Geo-Indore.responses.json'
$evidenceSummary = Join-Path $repoRoot 'postman\reports\Homingo-Geo-Indore.summary.md'
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$postgresPort = 55433
$redisPort = 56380
$geocoderPort = 58081
$appPort = 53013
$jwtSecret = 'geo-postman-isolated-secret-at-least-32-characters'
$processes = @()
$postgresStarted = $false

function Assert-SafeRuntimePath {
  $expected = Join-Path $repoRoot '.geo-postman-runtime'
  if ([System.IO.Path]::GetFullPath($runtime) -ne [System.IO.Path]::GetFullPath($expected)) {
    throw "Refusing to clean unexpected runtime path: $runtime"
  }
}

function Wait-ForApi {
  for ($attempt = 1; $attempt -le 60; $attempt += 1) {
    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/health" -TimeoutSec 2
      return
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "Homingo did not become ready. See $appLog"
}

function Stop-RunnerProcessTree([int]$RootProcessId) {
  # Start-Process returns npm.cmd's wrapper PID. Nest and cross-env are child
  # processes on Windows, so stopping only that wrapper leaves the app alive
  # and its redirected log handles open. Snapshot descendants first, then stop
  # deepest-first using only native PowerShell process operations.
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $ids = [System.Collections.Generic.List[int]]::new()
  $frontier = @($RootProcessId)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($parentId in $frontier) {
      foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parentId }) {
        $ids.Add([int]$child.ProcessId)
        $next += [int]$child.ProcessId
      }
    }
    $frontier = $next
  }
  $orderedIds = @($ids)
  [array]::Reverse($orderedIds)
  foreach ($id in $orderedIds + @($RootProcessId)) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}

Push-Location $repoRoot
try {
  Assert-SafeRuntimePath
  if (Test-Path -LiteralPath $runtime) {
    Remove-Item -LiteralPath $runtime -Recurse -Force
  }
  New-Item -ItemType Directory -Path $runtime | Out-Null

  Write-Host '1/7 Initializing isolated PostgreSQL...'
  & (Join-Path $pgBin 'initdb.exe') -D $pgData -U postgres -A trust --no-locale -E UTF8
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l $pgLog -o "-p $postgresPort -h 127.0.0.1" start
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL failed to start' }
  $postgresStarted = $true
  & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p $postgresPort -U postgres geo_postman
  if ($LASTEXITCODE -ne 0) { throw 'createdb failed' }

  $env:NODE_ENV = 'local'
  $env:DATABASE_URL = "postgresql://postgres@127.0.0.1:$postgresPort/geo_postman"
  $env:REDIS_HOST = '127.0.0.1'
  $env:REDIS_PORT = [string]$redisPort
  $env:TEST_REDIS_PORT = [string]$redisPort
  # Keep the production-style one-second lock while avoiding Windows timer
  # jitter at the exact expiry boundary in this deterministic local fixture.
  $env:TEST_REDIS_EXPIRY_SCALE = '0.8'
  $env:TEST_NOMINATIM_PORT = [string]$geocoderPort
  $env:NOMINATIM_BASE_URL = "http://127.0.0.1:$geocoderPort"
  $env:NOMINATIM_USER_AGENT = 'Homingo Geo Postman isolated verification'
  $env:NOMINATIM_CACHE_TTL_SECONDS = '300'
  # Exercise the same Google adapter production uses, against a deterministic
  # local server. The value below is fixture-only and never reaches Google.
  $env:GEOCODER_PROVIDER = 'google'
  $env:GOOGLE_MAPS_API_KEY = 'isolated-postman-fixture-key'
  $env:GOOGLE_MAPS_BASE_URL = "http://127.0.0.1:$geocoderPort"
  $env:GOOGLE_MAPS_REGION = 'in'
  $env:GOOGLE_MAPS_LANGUAGE = 'en'
  $env:JWT_SECRET = $jwtSecret
  $env:JWT_EXPIRES_IN = '1h'
  $env:OTP_PROVIDER = 'mock'
  $env:MOCK_OTP_CODE = '123456'
  $env:AWS_REGION = 'ap-south-1'
  $env:AWS_S3_BUCKET = 'geo-postman-unused'
  $env:AWS_ACCESS_KEY_ID = 'geo-postman-unused'
  $env:AWS_SECRET_ACCESS_KEY = 'geo-postman-unused'
  $env:COMMISSION_WORKER_ENABLED = 'false'
  $env:RECONCILIATION_ENABLED = 'false'
  $env:PORT = [string]$appPort
  $env:HOST = '127.0.0.1'

  Write-Host '2/7 Applying migrations and deterministic fixtures...'
  & npx.cmd prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Prisma migrations failed' }
  & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $postgresPort -U postgres -d geo_postman -v ON_ERROR_STOP=1 -f (Join-Path $repoRoot 'test\manual\geo-postman-fixture.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Geo fixture insert failed' }

  Write-Host '3/7 Starting local Redis and Indore geocoder fixtures...'
  $processes += Start-Process -FilePath 'node.exe' -ArgumentList 'test/manual/redis-test-server.mjs' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $redisLog -RedirectStandardError (Join-Path $runtime 'redis-error.log')
  $processes += Start-Process -FilePath 'node.exe' -ArgumentList 'test/manual/indore-nominatim-test-server.mjs' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $geocoderLog -RedirectStandardError (Join-Path $runtime 'geocoder-error.log')

  Write-Host '4/7 Building and starting Homingo on isolated infrastructure...'
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Homingo build failed' }
  # Launch the compiled application directly. Starting through npm/cross-env
  # creates several Windows wrappers and can re-parent the final Node process,
  # making reliable cleanup impossible after a failed collection.
  $processes += Start-Process -FilePath 'node.exe' -ArgumentList '--enable-source-maps','dist/src/main.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $appLog -RedirectStandardError (Join-Path $runtime 'app-error.log')
  Wait-ForApi

  Write-Host '5/7 Generating short-lived test JWTs...'
  & node.exe test/manual/prepare-geo-postman-environment.mjs postman/Homingo-Geo-Indore.postman_environment.json $runtimeEnvironment
  if ($LASTEXITCODE -ne 0) { throw 'Postman environment preparation failed' }

  Write-Host '6/7 Running the complete Postman collection...'
  & npx.cmd --yes newman run postman/Homingo-Geo-Indore.postman_collection.json -e $runtimeEnvironment --env-var "baseUrl=$BaseUrl" --reporters cli,json --reporter-json-export $newmanReport --timeout-request 15000
  $newmanExit = $LASTEXITCODE

  if (Test-Path -LiteralPath $newmanReport) {
    & node.exe test/manual/export-geo-postman-evidence.mjs $newmanReport $evidenceReport $evidenceSummary
    if ($LASTEXITCODE -ne 0) { throw 'Sanitized Postman evidence export failed' }
    & node.exe test/manual/attach-geo-postman-examples.mjs postman/Homingo-Geo-Indore.postman_collection.json $evidenceReport
    if ($LASTEXITCODE -ne 0) { throw 'Postman saved-example generation failed' }
  }

  Write-Host '7/7 Postman verification complete.'
  if ($newmanExit -ne 0) { throw "Newman reported failed assertions (exit $newmanExit)" }
} finally {
  foreach ($process in $processes) {
    if ($process -and -not $process.HasExited) {
      Stop-RunnerProcessTree $process.Id
    }
  }
  if ($postgresStarted) {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -m fast stop
  }
  Pop-Location
  # The generated environment contains short-lived bearer tokens. Never leave
  # it behind after a run, whether the collection passed or failed.
  if (Test-Path -LiteralPath $runtimeEnvironment) {
    Remove-Item -LiteralPath $runtimeEnvironment -Force
  }
}
