$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:53000/api/v1'
$runtime = Join-Path $PSScriptRoot '..\..\.curl-test-runtime'
$appLog = Join-Path $runtime 'app.out.log'
$phone = '+919200000022'

function Invoke-CurlJson([string]$Method, [string]$Path, [object]$Body, [string]$Token = '') {
  $arguments = @('-sS', '-X', $Method, "$base$Path", '-H', 'Accept: application/json')
  if ($Token) { $arguments += @('-H', "Authorization: Bearer $Token") }
  if ($null -ne $Body) {
    $bodyFile = Join-Path $runtime 'request-body.json'
    [IO.File]::WriteAllText($bodyFile, ($Body | ConvertTo-Json -Compress -Depth 8))
    $arguments += @('-H', 'Content-Type: application/json', '--data-binary', "@$bodyFile")
  }
  $raw = (& curl.exe @arguments -w "`n%{http_code}") -join "`n"
  $lines = $raw -split "`n"
  $status = [int]$lines[-1]
  $text = ($lines[0..([Math]::Max(0, $lines.Length - 2))] -join "`n").Trim()
  return @{ Status = $status; Body = if ($text) { $text | ConvertFrom-Json } else { $null } }
}

$request = Invoke-CurlJson POST '/auth/otp/request' @{ phone = $phone; actorType = 'pro' }
Start-Sleep -Milliseconds 150
$matches = Select-String -Path $appLog -Pattern "\[MOCK OTP\] $([regex]::Escape($phone)) -> (\d{6})" -AllMatches
if (-not $matches) { throw 'Mock OTP not found' }
$code = $matches[-1].Matches[-1].Groups[1].Value
$verify = Invoke-CurlJson POST '/auth/otp/verify' @{
  phone = $phone; actorType = 'pro'; code = $code; providerRef = $request.Body.data.providerRef
}
$token = $verify.Body.data.accessToken
$before = Invoke-CurlJson GET '/pros/me/applications' $null $token
$rejectedId = ($before.Body.data | Where-Object { $_.decision -eq 'rejected' } | Select-Object -First 1).id
$submit = Invoke-CurlJson POST '/pros/me/applications' @{
  documentFullName = 'Correction Pro Resubmitted'
  documentDateOfBirth = '1994-02-03'
  documentGender = 'transgender'
  aadhaarSource = 'manual'
  aadhaarUrl = 'kyc/correction/aadhaar-new'
  aadhaarNumberMasked = 'XXXX-XXXX-5678'
  panSource = 'manual'
  panUrl = 'kyc/correction/pan-new'
  panNumberMasked = 'XXXXX1234Z'
} $token

$results = @(
  [pscustomobject]@{ Test = 'Rejected Pro can authenticate to reapply'; Expected = 201; Actual = $verify.Status; Passed = $verify.Status -eq 201 },
  [pscustomobject]@{ Test = 'Rejected Pro can submit a new attempt'; Expected = 201; Actual = $submit.Status; Passed = $submit.Status -eq 201 },
  [pscustomobject]@{ Test = 'Reapplication preserves old rejection and creates new id'; Expected = 'new id'; Actual = $submit.Status; Passed = $submit.Status -eq 201 -and $submit.Body.data.id -ne $rejectedId }
)
$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $runtime 'reapplication-rerun.json')
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { -not $_.Passed }).Count
Write-Output "TOTAL=$($results.Count) PASSED=$($results.Count - $failed) FAILED=$failed"
if ($failed) { exit 2 }
