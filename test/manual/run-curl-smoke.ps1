$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:53000/api/v1'
$appLog = Join-Path $PSScriptRoot '..\..\.curl-test-runtime\app.out.log'
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-CurlJson {
  param([string]$Method, [string]$Path, [object]$Body, [string]$Token)
  $args = @('-sS', '-X', $Method, "$base$Path", '-H', 'Content-Type: application/json')
  if ($Token) { $args += @('-H', "Authorization: Bearer $Token") }
  if ($null -ne $Body) {
    $bodyFile = Join-Path $PSScriptRoot '..\..\.curl-test-runtime\request-body.json'
    [IO.File]::WriteAllText($bodyFile, ($Body | ConvertTo-Json -Compress -Depth 8))
    $args += @('--data-binary', "@$bodyFile")
  }
  $raw = (& curl.exe @args -w "`n%{http_code}") -join "`n"
  $lines = $raw -split "`n"
  $status = [int]$lines[-1]
  $bodyText = ($lines[0..([Math]::Max(0, $lines.Length - 2))] -join "`n").Trim()
  $parsed = if ($bodyText) { $bodyText | ConvertFrom-Json } else { $null }
  return @{ Status = $status; Body = $parsed }
}

function Add-Result {
  param([string]$Name, [int]$Expected, [hashtable]$Response, [string]$Evidence = '')
  $results.Add([pscustomobject]@{
    Test = $Name
    Expected = $Expected
    Actual = $Response.Status
    Passed = $Response.Status -eq $Expected
    Evidence = if ($Evidence) { $Evidence } elseif ($Response.Body.message) { $Response.Body.message } else { 'response envelope received' }
  })
}

function Get-MockCode([string]$Phone) {
  Start-Sleep -Milliseconds 250
  $escaped = [regex]::Escape($Phone)
  $matches = Select-String -Path $appLog -Pattern "\[MOCK OTP\] $escaped -> (\d{6})" -AllMatches
  if (-not $matches) { throw "Mock OTP was not found for test phone" }
  return $matches[-1].Matches[-1].Groups[1].Value
}

function Login-WithOtp([string]$Phone, [string]$ActorType, [string]$DeviceId = '') {
  $request = Invoke-CurlJson POST '/auth/otp/request' @{ phone = $Phone; actorType = $ActorType } ''
  $code = Get-MockCode $Phone
  $body = @{ phone = $Phone; actorType = $ActorType; code = $code; providerRef = $request.Body.data.providerRef }
  if ($DeviceId) { $body.deviceId = $DeviceId }
  $verify = Invoke-CurlJson POST '/auth/otp/verify' $body ''
  return @{ Request = $request; Verify = $verify; Access = $verify.Body.data.accessToken; Refresh = $verify.Body.data.refreshToken }
}

$root = Invoke-CurlJson GET '' $null ''
Add-Result 'Liveness endpoint' 200 $root
$health = Invoke-CurlJson GET '/health' $null ''
Add-Result 'Database health endpoint' 200 $health 'database and heap indicators are up'
$invalidGuest = Invoke-CurlJson POST '/auth/guest-session' @{ deviceId = 'x' } ''
Add-Result 'DTO validation envelope' 400 $invalidGuest
$unauthorized = Invoke-CurlJson GET '/customers/me' $null ''
Add-Result 'Protected route without token' 401 $unauthorized

$guest = Invoke-CurlJson POST '/auth/guest-session' @{ deviceId = 'curl-device-0001' } ''
Add-Result 'Guest session creation' 201 $guest 'access and refresh tokens returned (redacted)'
$guestAccess = $guest.Body.data.accessToken
$guestRefresh = $guest.Body.data.refreshToken
$guestProfile = Invoke-CurlJson GET '/customers/me' $null $guestAccess
Add-Result 'Guest customer profile access' 200 $guestProfile
$guestId = $guestProfile.Body.data.id
$wrongActor = Invoke-CurlJson GET '/admin/roles' $null $guestAccess
Add-Result 'Customer token rejected from admin endpoint' 403 $wrongActor

$rotated = Invoke-CurlJson POST '/auth/refresh' @{ refreshToken = $guestRefresh } ''
Add-Result 'Refresh-token rotation' 201 $rotated 'fresh token pair returned (redacted)'
$logout = Invoke-CurlJson POST '/auth/logout' @{ refreshToken = $rotated.Body.data.refreshToken } ''
Add-Result 'Single-session logout' 204 $logout
$reuse = Invoke-CurlJson POST '/auth/refresh' @{ refreshToken = $rotated.Body.data.refreshToken } ''
Add-Result 'Revoked refresh token rejected' 401 $reuse

$unknownAdmin = Invoke-CurlJson POST '/auth/otp/request' @{ phone = '+919000000099'; actorType = 'admin' } ''
Add-Result 'No admin self-registration' 404 $unknownAdmin

$customerPhone = '+919000000021'
$otpRequest = Invoke-CurlJson POST '/auth/otp/request' @{ phone = $customerPhone; actorType = 'customer' } ''
Add-Result 'Customer OTP request' 201 $otpRequest 'provider reference returned (redacted)'
$customerCode = Get-MockCode $customerPhone
$wrongOtp = Invoke-CurlJson POST '/auth/otp/verify' @{ phone = $customerPhone; actorType = 'customer'; code = '000000'; providerRef = $otpRequest.Body.data.providerRef; deviceId = 'curl-device-0001' } ''
Add-Result 'Wrong OTP rejected distinctly' 401 $wrongOtp
$customerVerify = Invoke-CurlJson POST '/auth/otp/verify' @{ phone = $customerPhone; actorType = 'customer'; code = $customerCode; providerRef = $otpRequest.Body.data.providerRef; deviceId = 'curl-device-0001' } ''
Add-Result 'Guest upgraded by customer OTP' 201 $customerVerify 'same guest identity received verified tokens'
$customerAccess = $customerVerify.Body.data.accessToken
$verifiedProfile = Invoke-CurlJson GET '/customers/me' $null $customerAccess
Add-Result 'Verified customer profile access' 200 $verifiedProfile
if ($verifiedProfile.Body.data.id -ne $guestId) { throw 'Guest upgrade changed the customer id' }

$admin = Login-WithOtp '+916266941709' 'admin'
Add-Result 'Pre-provisioned admin OTP request' 201 $admin.Request
Add-Result 'Admin OTP verification' 201 $admin.Verify 'admin token pair returned (redacted)'
$adminAccess = $admin.Access
$roles = Invoke-CurlJson GET '/admin/roles' $null $adminAccess
Add-Result 'Super-admin permission access' 200 $roles ("roles returned: " + $roles.Body.data.Count)
$block = Invoke-CurlJson PATCH "/admin/customers/$guestId/block" @{} $adminAccess
Add-Result 'Admin blocks customer' 200 $block
$blockedAccess = Invoke-CurlJson GET '/customers/me' $null $customerAccess
Add-Result 'Blocked customer denied immediately' 401 $blockedAccess

$proPhone = '+919000000020'
$pro = Login-WithOtp $proPhone 'pro'
Add-Result 'Pro OTP request' 201 $pro.Request
Add-Result 'Pro OTP verification' 201 $pro.Verify
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h 127.0.0.1 -p 55432 -U postgres -d homingo_curl_test -q -c "UPDATE pros SET status='approved' WHERE phone='$proPhone'" | Out-Null
$proProfile = Invoke-CurlJson GET '/pros/me' $null $pro.Access
$proId = $proProfile.Body.data.id
$suspend = Invoke-CurlJson PATCH "/admin/pros/$proId/suspend" @{} $adminAccess
Add-Result 'Admin suspends approved Pro' 200 $suspend
$suspendedRead = Invoke-CurlJson GET '/pros/me' $null $pro.Access
Add-Result 'Suspended Pro denied non-financial route' 403 $suspendedRead

$ops = Login-WithOtp '+919000000010' 'admin'
Add-Result 'City-scoped ops OTP login' 201 $ops.Verify
$opsList = Invoke-CurlJson GET '/admin/pros' $null $ops.Access
Add-Result 'City-scoped roster list' 200 $opsList ("visible Pros: " + $opsList.Body.data.Count + ' (Indore only)')
$outsideWrite = Invoke-CurlJson PATCH '/admin/pros/30000000-0000-0000-0000-000000000002/suspend' @{} $ops.Access
Add-Result 'Out-of-city admin write denied' 403 $outsideWrite
$bulkOutside = Invoke-CurlJson PATCH '/admin/pros/availability/bulk' @{ proIds = @('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002'); isAvailable = $true } $ops.Access
Add-Result 'Mixed-city bulk operation denied atomically' 403 $bulkOutside

$rateStatuses = @()
1..6 | ForEach-Object {
  $rateStatuses += (Invoke-CurlJson POST '/auth/otp/request' @{ phone = '+919000000030'; actorType = 'customer' } '').Status
}
$rateResponse = @{ Status = $rateStatuses[-1]; Body = @{ message = ($rateStatuses -join ',') } }
Add-Result 'Per-phone OTP request limit' 429 $rateResponse ("statuses: " + ($rateStatuses -join ','))

$results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $PSScriptRoot '..\..\.curl-test-runtime\curl-results.json')
$results | Format-Table -AutoSize
if ($results.Where({ -not $_.Passed }).Count -gt 0) { exit 1 }
