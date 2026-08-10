$ErrorActionPreference = 'Stop'

$base = 'http://127.0.0.1:53000/api/v1'
$runtime = Join-Path $PSScriptRoot '..\..\.curl-test-runtime'
$appLog = Join-Path $runtime 'app.out.log'
$resultFile = Join-Path $runtime 'failed-cases-rerun.json'
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$databaseArgs = @('-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', 'homingo_curl_test', '-q')
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-CurlJson {
  param([string]$Method, [string]$Path, [AllowNull()][object]$Body, [string]$Token = '')
  $arguments = @('-sS', '-X', $Method, "$base$Path", '-H', 'Accept: application/json')
  if ($Token) { $arguments += @('-H', "Authorization: Bearer $Token") }
  if ($null -ne $Body) {
    $bodyFile = Join-Path $runtime 'request-body.json'
    [IO.File]::WriteAllText($bodyFile, ($Body | ConvertTo-Json -Compress -Depth 12))
    $arguments += @('-H', 'Content-Type: application/json', '--data-binary', "@$bodyFile")
  }
  $raw = (& curl.exe @arguments -w "`n%{http_code}") -join "`n"
  $lines = $raw -split "`n"
  $status = [int]$lines[-1]
  $bodyText = ($lines[0..([Math]::Max(0, $lines.Length - 2))] -join "`n").Trim()
  $parsed = if ($bodyText) { $bodyText | ConvertFrom-Json } else { $null }
  return @{ Status = $status; Body = $parsed }
}

function Assert-Status {
  param([string]$Area, [string]$Name, [int]$Expected, [hashtable]$Response)
  $evidence = if ($Response.Body.message) { [string]$Response.Body.message } else { 'response received' }
  $results.Add([pscustomobject]@{
    Area = $Area
    Test = $Name
    Expected = $Expected
    Actual = $Response.Status
    Passed = $Response.Status -eq $Expected
    Evidence = $evidence
  })
}

function Assert-Condition {
  param([string]$Area, [string]$Name, [bool]$Condition, [string]$Evidence)
  $results.Add([pscustomobject]@{
    Area = $Area
    Test = $Name
    Expected = 'true'
    Actual = if ($Condition) { 200 } else { 0 }
    Passed = $Condition
    Evidence = $Evidence
  })
}

function Invoke-Psql {
  param([string]$Sql, [switch]$Scalar)
  $sqlFile = Join-Path $runtime 'fixture-command.sql'
  [IO.File]::WriteAllText($sqlFile, $Sql)
  $arguments = $databaseArgs + @('-v', 'ON_ERROR_STOP=1')
  if ($Scalar) { $arguments += '-tA' }
  $arguments += @('-f', $sqlFile)
  $output = & $psql @arguments
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL fixture command failed' }
  if ($Scalar) { return (($output -join "`n").Trim()) }
}

function Get-MockCode([string]$CanonicalPhone) {
  Start-Sleep -Milliseconds 150
  $escaped = [regex]::Escape($CanonicalPhone)
  $matches = Select-String -Path $appLog -Pattern "\[MOCK OTP\] $escaped -> (\d{6})" -AllMatches
  if (-not $matches) { throw "Mock OTP was not found for $CanonicalPhone" }
  return $matches[-1].Matches[-1].Groups[1].Value
}

function Login-WithOtp {
  param([string]$Phone, [string]$ActorType, [string]$CanonicalPhone = '')
  $canonical = if ($CanonicalPhone) { $CanonicalPhone } else { $Phone }
  $request = Invoke-CurlJson POST '/auth/otp/request' @{ phone = $Phone; actorType = $ActorType }
  if ($request.Status -ne 201) { return @{ Request = $request; Verify = $null; Access = ''; Refresh = '' } }
  $verify = Invoke-CurlJson POST '/auth/otp/verify' @{
    phone = $Phone
    actorType = $ActorType
    code = Get-MockCode $canonical
    providerRef = $request.Body.data.providerRef
  }
  return @{
    Request = $request
    Verify = $verify
    Access = $verify.Body.data.accessToken
    Refresh = $verify.Body.data.refreshToken
  }
}

$indoreCityId = '10000000-0000-4000-8000-000000000001'
$mumbaiCityId = '10000000-0000-4000-8000-000000000002'
Invoke-Psql @"
INSERT INTO cities (id, "createdAt", "updatedAt", name, state, timezone, "isActive") VALUES
('$indoreCityId', now(), now(), 'Indore', 'Madhya Pradesh', 'Asia/Kolkata', true),
('$mumbaiCityId', now(), now(), 'Mumbai', 'Maharashtra', 'Asia/Kolkata', true);
"@

# Phone canonicalization (previously accepted without defining one identity format).
$national = Login-WithOtp '6266941709' 'customer' '+916266941709'
Assert-Status 'Phone' '10-digit Indian phone request is normalized' 201 $national.Request
Assert-Status 'Phone' 'Normalized phone verifies against the same OTP identity' 201 $national.Verify
$nationalProfile = Invoke-CurlJson GET '/customers/me' $null $national.Access
Assert-Condition 'Phone' 'Canonical E.164 phone is stored' ($nationalProfile.Body.data.phone -eq '+916266941709') ([string]$nationalProfile.Body.data.phone)

# Customer/address setup and the previously missing in-flight pin guard.
$customer = Login-WithOtp '+919200000001' 'customer'
$customerProfile = Invoke-CurlJson GET '/customers/me' $null $customer.Access
$customerId = $customerProfile.Body.data.id
Start-Sleep -Milliseconds 1100
$address = Invoke-CurlJson POST '/customers/me/addresses' @{
  label = 'home'; addressLine = 'Failed-case rerun address'; pinLat = 22.7196; pinLng = 75.8577
} $customer.Access
$addressId = $address.Body.data.id
Invoke-Psql "INSERT INTO bookings (id, `"createdAt`", `"updatedAt`", `"bookingNumber`", `"customerId`", `"serviceId`", `"addressId`", status) VALUES ('40000000-0000-4000-8000-000000000101', now(), now(), 'RERUN-ADDR-1', '$customerId', 'svc-ac', '$addressId', 'en_route');"
$response = Invoke-CurlJson PATCH "/customers/me/addresses/$addressId" @{ pinLng = 72.88 } $customer.Access
Assert-Status 'Address guard' 'Live booking blocks authoritative pin movement' 409 $response
Invoke-Psql "DELETE FROM bookings WHERE id='40000000-0000-4000-8000-000000000101';"

# Admin and Pro setup.
$admin = Login-WithOtp '+916266941709' 'admin'
$adminAccess = $admin.Access
$roles = Invoke-CurlJson GET '/admin/roles' $null $adminAccess
$opsRole = $roles.Body.data | Where-Object { $_.name -eq 'ops' }
$pro = Login-WithOtp '+919200000020' 'pro'
$proAccess = $pro.Access
$proProfile = Invoke-CurlJson GET '/pros/me' $null $proAccess
$proId = $proProfile.Body.data.id

# Controlled profile photo flow replaces arbitrary URL assignment.
$response = Invoke-CurlJson PATCH '/pros/me/profile-photo' @{ key = 'https://example.invalid/photo.jpg' } $proAccess
Assert-Status 'Profile photo' 'Arbitrary external photo URL is rejected' 400 $response
$photoUpload = Invoke-CurlJson POST '/pros/me/profile-photo/upload-url' @{ contentType = 'image/jpeg' } $proAccess
Assert-Status 'Profile photo' 'Issued S3 profile-photo upload URL' 201 $photoUpload
$response = Invoke-CurlJson PATCH '/pros/me/profile-photo' @{ key = $photoUpload.Body.data.key } $proAccess
Assert-Status 'Profile photo' 'Issued private photo key is attached' 200 $response

# Valid manual KYC and every previously cascaded admin action.
$aadhaarUpload = Invoke-CurlJson POST '/pros/me/kyc/upload-url' @{ docType = 'aadhaar'; contentType = 'image/jpeg' } $proAccess
$panUpload = Invoke-CurlJson POST '/pros/me/kyc/upload-url' @{ docType = 'pan'; contentType = 'application/pdf' } $proAccess
$applicationBody = @{
  documentFullName = 'Rerun Legal Pro'
  documentDateOfBirth = '1995-08-17'
  documentGender = 'male'
  aadhaarSource = 'manual'
  aadhaarUrl = $aadhaarUpload.Body.data.key
  aadhaarNumberMasked = 'XXXX-XXXX-1234'
  panSource = 'manual'
  panUrl = $panUpload.Body.data.key
  panNumberMasked = 'XXXXX1234F'
}
$application = Invoke-CurlJson POST '/pros/me/applications' $applicationBody $proAccess
Assert-Status 'KYC root' 'Valid manual KYC submission no longer returns 500' 201 $application
$applicationId = $application.Body.data.id
$applicationBody.documentFullName = 'Rerun Legal Pro Corrected'
$resubmitted = Invoke-CurlJson POST '/pros/me/applications' $applicationBody $proAccess
Assert-Status 'KYC root' 'Open KYC resubmission succeeds' 201 $resubmitted
Assert-Condition 'KYC root' 'Open resubmission keeps one queue item' ($resubmitted.Body.data.id -eq $applicationId) ([string]$applicationId)

$rawMaskPro = Login-WithOtp '+919200000021' 'pro'
$response = Invoke-CurlJson POST '/pros/me/applications' @{
  documentFullName = 'Raw Mask Test'; documentDateOfBirth = '1990-01-01'; documentGender = 'female'
  aadhaarSource = 'manual'; aadhaarUrl = 'kyc/raw/aadhaar'; aadhaarNumberMasked = '123412341234'
  panSource = 'manual'; panUrl = 'kyc/raw/pan'; panNumberMasked = 'XXXXX1234F'
} $rawMaskPro.Access
Assert-Status 'Masking' 'Raw Aadhaar value is rejected before persistence' 400 $response

$null = Invoke-CurlJson PATCH "/admin/pros/$proId/profile" @{ cityId = $indoreCityId } $adminAccess
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/verify-document" @{ docType = 'aadhaar'; decision = 'rejected' } $adminAccess
Assert-Status 'KYC admin' 'Document rejection still requires reason' 400 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/verify-document" @{ docType = 'aadhaar'; decision = 'verified' } $adminAccess
Assert-Status 'KYC admin' 'Aadhaar verifies independently' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/decision" @{ decision = 'approved' } $adminAccess
Assert-Status 'KYC admin' 'Approval waits for PAN verification' 409 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/verify-document" @{ docType = 'pan'; decision = 'verified' } $adminAccess
Assert-Status 'KYC admin' 'PAN verifies independently' 200 $response
$response = Invoke-CurlJson GET "/admin/pro-applications/$applicationId/documents/aadhaar/view-url" $null $adminAccess
Assert-Status 'KYC admin' 'KYC document view URL works with a real application ID' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/log-call" @{} $adminAccess
Assert-Status 'KYC admin' 'Verification call is logged' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/decision" @{ decision = 'approved' } $adminAccess
Assert-Status 'KYC admin' 'Verified application is approved' 200 $response
$approvedProfile = Invoke-CurlJson GET '/pros/me' $null $proAccess
Assert-Condition 'KYC approval' 'Legal identity and employee code copy on approval' ($approvedProfile.Body.data.fullName -eq 'Rerun Legal Pro Corrected' -and $approvedProfile.Body.data.employeeCode -match '^HG-\d{5}$') ([string]$approvedProfile.Body.data.employeeCode)
$response = Invoke-CurlJson POST '/pros/me/applications' $applicationBody $proAccess
Assert-Status 'KYC approval' 'Approved legal identity cannot self-resubmit' 409 $response

# Correction, rejection, and new-attempt reapplication.
$correctionPro = Login-WithOtp '+919200000022' 'pro'
$correctionBody = @{
  documentFullName = 'Correction Pro'; documentDateOfBirth = '1994-02-03'; documentGender = 'transgender'
  aadhaarSource = 'manual'; aadhaarUrl = 'kyc/correction/aadhaar'; aadhaarNumberMasked = 'XXXX-XXXX-5678'
  panSource = 'manual'; panUrl = 'kyc/correction/pan'; panNumberMasked = 'XXXXX1234Z'
}
$correctionApp = Invoke-CurlJson POST '/pros/me/applications' $correctionBody $correctionPro.Access
$correctionAppId = $correctionApp.Body.data.id
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/decision" @{ decision = 'changes_requested' } $adminAccess
Assert-Status 'KYC lifecycle' 'Correction request requires a message' 400 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/decision" @{ decision = 'changes_requested'; reason = 'Replace blurred PAN' } $adminAccess
Assert-Status 'KYC lifecycle' 'Admin correction message succeeds' 200 $response
$correctionBody.documentFullName = 'Correction Pro Resubmitted'
$corrected = Invoke-CurlJson POST '/pros/me/applications' $correctionBody $correctionPro.Access
Assert-Status 'KYC lifecycle' 'Correction resubmission succeeds' 201 $corrected
Assert-Condition 'KYC lifecycle' 'Correction stays on the same attempt' ($corrected.Body.data.id -eq $correctionAppId) ([string]$correctionAppId)
$null = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/verify-document" @{ docType = 'aadhaar'; decision = 'verified' } $adminAccess
$null = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/verify-document" @{ docType = 'pan'; decision = 'verified' } $adminAccess
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/decision" @{ decision = 'rejected'; reason = 'Identity mismatch' } $adminAccess
Assert-Status 'KYC lifecycle' 'Application rejection succeeds' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/decision" @{ decision = 'approved' } $adminAccess
Assert-Status 'KYC lifecycle' 'Final decision cannot be rewritten' 409 $response
$newAttempt = Invoke-CurlJson POST '/pros/me/applications' $correctionBody $correctionPro.Access
Assert-Status 'KYC lifecycle' 'Rejected Pro can reapply' 201 $newAttempt
Assert-Condition 'KYC lifecycle' 'Reapplication creates a new attempt' ($newAttempt.Body.data.id -ne $correctionAppId) ([string]$newAttempt.Body.data.id)

# Approval now opens the positive location path; masking rejects raw bank data.
$null = Invoke-CurlJson POST "/admin/pros/$proId/services" @{ serviceId = 'svc-ac'; proficiency = 'skilled' } $adminAccess
$null = Invoke-CurlJson PATCH "/admin/pros/$proId/availability" @{ isAvailable = $true } $adminAccess
$response = Invoke-CurlJson POST '/pros/me/location' @{ lat = 22.7196; lng = 75.8577 } $proAccess
Assert-Status 'Pro location' 'Approved on-duty location is accepted' 201 $response
$locationProfile = Invoke-CurlJson GET '/pros/me' $null $proAccess
Assert-Condition 'Pro location' 'Location cold copy is persisted' ($locationProfile.Body.data.lastKnownLat -eq 22.7196 -and $null -ne $locationProfile.Body.data.lastLocationAt) 'coordinate and timestamp present'
$response = Invoke-CurlJson POST '/pros/me/bank-accounts' @{ accountHolderName = 'Rerun Pro'; accountNumberMasked = '123456789012'; ifscCode = 'HDFC0001234' } $proAccess
Assert-Status 'Masking' 'Raw bank account value is rejected' 400 $response

# Secure out-of-city list behavior is explicitly 403.
$mumbaiPro = Login-WithOtp '+919200000023' 'pro'
$mumbaiProfile = Invoke-CurlJson GET '/pros/me' $null $mumbaiPro.Access
$null = Invoke-CurlJson PATCH "/admin/pros/$($mumbaiProfile.Body.data.id)/profile" @{ cityId = $mumbaiCityId } $adminAccess
$opsCreate = Invoke-CurlJson POST '/admin/admin-users' @{ phone = '+919200000010'; fullName = 'Rerun Indore Ops'; roleId = $opsRole.id; cityScopeJson = @($indoreCityId) } $adminAccess
$ops = Login-WithOtp '+919200000010' 'admin'
$response = Invoke-CurlJson GET "/admin/pros?cityId=$mumbaiCityId" $null $ops.Access
Assert-Status 'City scope' 'Explicit out-of-scope roster query is securely denied' 403 $response

# Suspension, live work handling, state enforcement, and final reinstatement.
Invoke-Psql "INSERT INTO bookings (id, `"createdAt`", `"updatedAt`", `"bookingNumber`", `"customerId`", `"serviceId`", `"addressId`", status, `"proId`", `"assignedAt`") VALUES ('40000000-0000-4000-8000-000000000102', now(), now(), 'RERUN-LIVE-PRO-1', '$customerId', 'svc-ac', '$addressId', 'en_route', '$proId', now());"
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/suspend" @{} $adminAccess
Assert-Status 'Suspension' 'Live booking requires explicit handling' 409 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/suspend" @{ confirmLiveBookingHandling = $true } $adminAccess
Assert-Status 'Suspension' 'Confirmed live handling requires a reason' 400 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/suspend" @{ confirmLiveBookingHandling = $true; reason = 'Focused rerun suspension' } $adminAccess
Assert-Status 'Suspension' 'Approved Pro suspension succeeds' 200 $response
$bookingState = Invoke-Psql "SELECT status || ':' || coalesce(`"proId`"::text, 'none') FROM bookings WHERE id='40000000-0000-4000-8000-000000000102';" -Scalar
Assert-Condition 'Suspension' 'Pre-arrival booking returns to dispatch' ($bookingState -eq 'assigning:none') $bookingState
$response = Invoke-CurlJson GET '/pros/me' $null $proAccess
Assert-Status 'Suspension' 'Existing access becomes suspended read-only immediately' 403 $response
$suspended = Login-WithOtp '+919200000020' 'pro'
$response = Invoke-CurlJson GET '/pros/me' $null $suspended.Access
Assert-Status 'Suspension' 'Suspended Pro cannot read ordinary profile' 403 $response
$response = Invoke-CurlJson PATCH '/pros/me' @{ email = 'forbidden@example.com' } $suspended.Access
Assert-Status 'Suspension' 'Suspended Pro cannot mutate profile' 403 $response
$null = Invoke-CurlJson PATCH "/admin/pros/$proId/services/svc-ac" @{ isActive = $false } $adminAccess
$null = Invoke-CurlJson PATCH "/admin/pros/$proId/availability" @{ isAvailable = $true } $adminAccess
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/reinstate" @{} $adminAccess
Assert-Status 'Reinstatement' 'Inactive service blocks reinstatement' 409 $response
$null = Invoke-CurlJson PATCH "/admin/pros/$proId/services/svc-ac" @{ isActive = $true } $adminAccess
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/reinstate" @{} $adminAccess
Assert-Status 'Reinstatement' 'All three dispatch gates permit reinstatement' 200 $response

# Real logout-all behavior against the corrected Redis-compatible SCAN.
$sessionA = Login-WithOtp '+919200000030' 'customer'
$sessionB = Login-WithOtp '+919200000030' 'customer'
$response = Invoke-CurlJson POST '/auth/logout-all' @{} $sessionA.Access
Assert-Status 'Session' 'Logout-all endpoint succeeds' 204 $response
$response = Invoke-CurlJson POST '/auth/refresh' @{ refreshToken = $sessionB.Refresh }
Assert-Status 'Session' 'Logout-all revokes the other device refresh token' 401 $response

$results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultFile -Encoding utf8
$results | Format-Table Area, Test, Expected, Actual, Passed -AutoSize
$passed = @($results | Where-Object Passed).Count
$failed = @($results | Where-Object { -not $_.Passed }).Count
Write-Output "TOTAL=$($results.Count) PASSED=$passed FAILED=$failed"
if ($failed -gt 0) { exit 2 }
