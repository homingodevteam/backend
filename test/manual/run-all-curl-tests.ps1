$ErrorActionPreference = 'Stop'

$base = 'http://127.0.0.1:53000/api/v1'
$runtime = Join-Path $PSScriptRoot '..\..\.curl-test-runtime'
$appLog = if ($env:CURL_TEST_APP_LOG) {
  $env:CURL_TEST_APP_LOG
} else {
  Join-Path $runtime 'app.out.log'
}
$resultFile = Join-Path $runtime 'all-curl-results.json'
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$databaseArgs = @('-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', 'homingo_curl_test', '-q')
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-CurlJson {
  param(
    [string]$Method,
    [string]$Path,
    [AllowNull()][object]$Body,
    [string]$Token = '',
    [string]$RawBody = ''
  )
  $arguments = @('-sS', '-X', $Method, "$base$Path", '-H', 'Accept: application/json')
  if ($Token) { $arguments += @('-H', "Authorization: Bearer $Token") }
  if ($RawBody) {
    $arguments += @('-H', 'Content-Type: application/json', '--data-binary', $RawBody)
  } elseif ($null -ne $Body) {
    $bodyFile = Join-Path $runtime 'request-body.json'
    [IO.File]::WriteAllText($bodyFile, ($Body | ConvertTo-Json -Compress -Depth 12))
    $arguments += @('-H', 'Content-Type: application/json', '--data-binary', "@$bodyFile")
  }
  $raw = (& curl.exe @arguments -w "`n%{http_code}") -join "`n"
  $lines = $raw -split "`n"
  $status = [int]$lines[-1]
  $lastBodyIndex = $lines.Length - 2
  $bodyText = if ($lastBodyIndex -ge 0) { ($lines[0..$lastBodyIndex] -join "`n").Trim() } else { '' }
  $parsed = $null
  if ($bodyText) {
    try { $parsed = $bodyText | ConvertFrom-Json } catch { $parsed = $bodyText }
  }
  return @{ Status = $status; Body = $parsed; RawBody = $bodyText }
}

function Add-Result {
  param(
    [string]$Area,
    [string]$Name,
    [string]$Expected,
    [int]$Actual,
    [bool]$Passed,
    [string]$Evidence = ''
  )
  $results.Add([pscustomobject]@{
    Area = $Area
    Test = $Name
    Expected = $Expected
    Actual = $Actual
    Passed = $Passed
    Evidence = $Evidence
  })
}

function Assert-Status {
  param([string]$Area, [string]$Name, [int]$Expected, [hashtable]$Response, [string]$Evidence = '')
  $message = $Evidence
  if (-not $message -and $Response.Body -and $Response.Body.message) { $message = [string]$Response.Body.message }
  if (-not $message) { $message = 'HTTP response received' }
  Add-Result $Area $Name ([string]$Expected) $Response.Status ($Response.Status -eq $Expected) $message
}

function Assert-Property {
  param([string]$Area, [string]$Name, [hashtable]$Response, [bool]$Condition, [string]$Expected, [string]$Evidence)
  Add-Result $Area $Name $Expected $Response.Status ($Response.Status -lt 400 -and $Condition) $Evidence
}

function Invoke-Psql {
  param([string]$Sql, [switch]$Scalar)
  $sqlFile = Join-Path $runtime 'fixture-command.sql'
  [IO.File]::WriteAllText($sqlFile, $Sql)
  $args = $databaseArgs + @('-v', 'ON_ERROR_STOP=1')
  if ($Scalar) { $args += @('-tA') }
  $args += @('-f', $sqlFile)
  $output = & $psql @args
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL fixture command failed' }
  if ($Scalar) { return (($output -join "`n").Trim()) }
}

function Get-MockCode([string]$Phone) {
  Start-Sleep -Milliseconds 150
  $escaped = [regex]::Escape($Phone)
  $matches = Select-String -Path $appLog -Pattern "\[MOCK OTP\] $escaped -> (\d{6})" -AllMatches
  if (-not $matches) { throw "Mock OTP was not found for $Phone" }
  return $matches[-1].Matches[-1].Groups[1].Value
}

function Login-WithOtp {
  param([string]$Phone, [string]$ActorType, [string]$DeviceId = '')
  $request = Invoke-CurlJson POST '/auth/otp/request' @{ phone = $Phone; actorType = $ActorType }
  if ($request.Status -ne 201) { return @{ Request = $request; Verify = $null; Access = ''; Refresh = '' } }
  $body = @{
    phone = $Phone
    actorType = $ActorType
    code = Get-MockCode $Phone
    providerRef = $request.Body.data.providerRef
  }
  if ($DeviceId) { $body.deviceId = $DeviceId }
  $verify = Invoke-CurlJson POST '/auth/otp/verify' $body
  return @{
    Request = $request
    Verify = $verify
    Access = $verify.Body.data.accessToken
    Refresh = $verify.Body.data.refreshToken
  }
}

function Wait-GeocoderSlot { Start-Sleep -Milliseconds 1100 }

# Platform catalog fixture. There is intentionally no city mutation API yet.
Invoke-Psql @"
INSERT INTO cities (id, "createdAt", "updatedAt", name, state, timezone, "isActive") VALUES
('10000000-0000-4000-8000-000000000001', now(), now(), 'Indore', 'Madhya Pradesh', 'Asia/Kolkata', true),
('10000000-0000-4000-8000-000000000002', now(), now(), 'Mumbai', 'Maharashtra', 'Asia/Kolkata', true),
('10000000-0000-4000-8000-000000000003', now(), now(), 'New Delhi', 'Delhi', 'Asia/Kolkata', false)
ON CONFLICT (id) DO NOTHING;
"@
$indoreCityId = '10000000-0000-4000-8000-000000000001'
$mumbaiCityId = '10000000-0000-4000-8000-000000000002'
$inactiveCityId = '10000000-0000-4000-8000-000000000003'

# Core and catalog
$response = Invoke-CurlJson GET '' $null
Assert-Status 'Core' 'Application liveness root' 200 $response
$response = Invoke-CurlJson GET '/health' $null
Assert-Status 'Core' 'Database/heap health' 200 $response
$response = Invoke-CurlJson GET '/cities' $null
Assert-Status 'Catalog' 'List active cities' 200 $response
Assert-Property 'Catalog' 'Inactive cities are excluded' $response (-not ($response.Body.data.id -contains $inactiveCityId)) 'inactive city absent' 'only active city ids returned'
$response = Invoke-CurlJson GET '/route-that-does-not-exist' $null
Assert-Status 'Core' 'Unknown route uses 404 envelope' 404 $response
$response = Invoke-CurlJson POST '/auth/guest-session' $null '' '{bad json'
Assert-Status 'Validation' 'Malformed JSON rejected' 400 $response
$response = Invoke-CurlJson GET '/customers/me' $null
Assert-Status 'Authorization' 'Missing bearer token rejected' 401 $response

# Session lifecycle and guest identity
$response = Invoke-CurlJson POST '/auth/guest-session' @{ deviceId = 'x' }
Assert-Status 'Guest' 'Short deviceId rejected' 400 $response
$guest = Invoke-CurlJson POST '/auth/guest-session' @{ deviceId = 'curl-all-device-main-0001' }
Assert-Status 'Guest' 'Guest session created' 201 $guest
$guestAccess = $guest.Body.data.accessToken
$guestRefresh = $guest.Body.data.refreshToken
$guestProfile = Invoke-CurlJson GET '/customers/me' $null $guestAccess
Assert-Status 'Guest' 'Guest profile readable' 200 $guestProfile
$guestId = $guestProfile.Body.data.id
$resumedGuest = Invoke-CurlJson POST '/auth/guest-session' @{ deviceId = 'curl-all-device-main-0001' }
Assert-Property 'Guest' 'Same device resumes same Customer row' $resumedGuest ($resumedGuest.Body.data.accessToken -ne $null) 'same customer identity' 'new tokens issued for existing device identity'
$wrongActor = Invoke-CurlJson GET '/admin/roles' $null $guestAccess
Assert-Status 'Authorization' 'Customer token rejected by admin guard' 403 $wrongActor
$rotated = Invoke-CurlJson POST '/auth/refresh' @{ refreshToken = $guestRefresh }
Assert-Status 'Session' 'Refresh token rotates' 201 $rotated
$reuse = Invoke-CurlJson POST '/auth/refresh' @{ refreshToken = $guestRefresh }
Assert-Status 'Session' 'Consumed refresh token cannot be reused' 401 $reuse
$logout = Invoke-CurlJson POST '/auth/logout' @{ refreshToken = $rotated.Body.data.refreshToken }
Assert-Status 'Session' 'Single session logout' 204 $logout
$afterLogout = Invoke-CurlJson POST '/auth/refresh' @{ refreshToken = $rotated.Body.data.refreshToken }
Assert-Status 'Session' 'Logged-out refresh token rejected' 401 $afterLogout

# Customer OTP and guest upgrade
$unknownAdmin = Invoke-CurlJson POST '/auth/otp/request' @{ phone = '+919100000099'; actorType = 'admin' }
Assert-Status 'OTP' 'Unknown admin cannot self-register' 404 $unknownAdmin
$response = Invoke-CurlJson POST '/auth/otp/request' @{ phone = '6266941709'; actorType = 'customer' }
Assert-Status 'OTP' 'Indian national phone is canonicalized before OTP send' 201 $response
$customerPhone = '+919100000021'
$customerOtp = Invoke-CurlJson POST '/auth/otp/request' @{ phone = $customerPhone; actorType = 'customer' }
Assert-Status 'OTP' 'Customer OTP request returns provider reference' 201 $customerOtp
$customerCode = Get-MockCode $customerPhone
$wrongRef = Invoke-CurlJson POST '/auth/otp/verify' @{ phone = $customerPhone; actorType = 'customer'; code = $customerCode; providerRef = 'invalid-reference'; deviceId = 'curl-all-device-main-0001' }
Assert-Status 'OTP' 'Unknown provider reference rejected' 401 $wrongRef
$wrongCodePhone = '+919100000029'
$wrongCodeRequest = Invoke-CurlJson POST '/auth/otp/request' @{ phone = $wrongCodePhone; actorType = 'customer' }
$wrongCode = Invoke-CurlJson POST '/auth/otp/verify' @{ phone = $wrongCodePhone; actorType = 'customer'; code = '000000'; providerRef = $wrongCodeRequest.Body.data.providerRef }
Assert-Status 'OTP' 'Wrong code distinguished as user error' 401 $wrongCode
$customerVerify = Invoke-CurlJson POST '/auth/otp/verify' @{ phone = $customerPhone; actorType = 'customer'; code = $customerCode; providerRef = $customerOtp.Body.data.providerRef; deviceId = 'curl-all-device-main-0001' }
Assert-Status 'OTP' 'Correct customer OTP issues tokens' 201 $customerVerify
$customerAccess = $customerVerify.Body.data.accessToken
$customerRefresh = $customerVerify.Body.data.refreshToken
$customerProfile = Invoke-CurlJson GET '/customers/me' $null $customerAccess
Assert-Property 'Guest upgrade' 'Guest is upgraded in place' $customerProfile ($customerProfile.Body.data.id -eq $guestId) 'same Customer id' "customer id $guestId preserved"

# Customer profile
$response = Invoke-CurlJson PATCH '/customers/me' @{ fullName = '  Curl Customer  '; email = ' CURL.TEST@EXAMPLE.COM ' } $customerAccess
Assert-Status 'Customer profile' 'Update name and invoice email' 200 $response
Assert-Property 'Customer profile' 'Email is normalized' $response ($response.Body.data.email -eq 'curl.test@example.com') 'lowercase trimmed email' ([string]$response.Body.data.email)
$response = Invoke-CurlJson PATCH '/customers/me' @{ email = 'not-an-email' } $customerAccess
Assert-Status 'Customer profile' 'Invalid email rejected' 400 $response
$response = Invoke-CurlJson PATCH '/customers/me' @{ phone = '+919999999999' } $customerAccess
Assert-Status 'Customer profile' 'Phone cannot be changed through profile endpoint' 400 $response

# Address, pin, city, cache, ownership and defaults
Wait-GeocoderSlot
$response = Invoke-CurlJson GET '/customers/me/addresses/reverse-geocode?pinLat=22.7196&pinLng=75.8577' $null $customerAccess
Assert-Status 'Address' 'Reverse geocode supported Indore pin' 200 $response
Assert-Property 'Address' 'Reverse geocode resolves active city' $response ($response.Body.data.cityId -eq $indoreCityId -and $response.Body.data.serviceable) 'Indore and serviceable' ([string]$response.Body.data.cityName)
$cached = Invoke-CurlJson GET '/customers/me/addresses/reverse-geocode?pinLat=22.7196&pinLng=75.8577' $null $customerAccess
Assert-Status 'Address' 'Cached reverse geocode bypasses provider slot' 200 $cached
$busy = Invoke-CurlJson GET '/customers/me/addresses/reverse-geocode?pinLat=19.076&pinLng=72.8777' $null $customerAccess
Assert-Status 'Address' 'Shared geocoder rate slot surfaces busy state' 503 $busy
$response = Invoke-CurlJson GET '/customers/me/addresses/reverse-geocode?pinLat=95&pinLng=75' $null $customerAccess
Assert-Status 'Address' 'Invalid latitude rejected' 400 $response
$addressOne = Invoke-CurlJson POST '/customers/me/addresses' @{ label = 'home'; addressLine = 'Human-entered home text'; landmark = 'Test landmark'; pinLat = 22.7196; pinLng = 75.8577 } $customerAccess
Assert-Status 'Address' 'Create first pinned address' 201 $addressOne
$addressOneId = $addressOne.Body.data.id
Assert-Property 'Address' 'First address becomes default' $addressOne ($addressOne.Body.data.isDefault -eq $true) 'isDefault=true' 'first address atomically selected'
$addressOneGeoJson = $addressOne.Body.data.geoPoint | ConvertTo-Json -Compress -Depth 4
Assert-Property 'Address' 'Pin produces authoritative GeoJSON' $addressOne ($addressOneGeoJson -match '75\.8577' -and $addressOneGeoJson -match '22\.7196') '[lng,lat]' $addressOneGeoJson
Wait-GeocoderSlot
$addressTwo = Invoke-CurlJson POST '/customers/me/addresses' @{ label = 'office'; addressLine = 'Office text'; pinLat = 19.076; pinLng = 72.8777 } $customerAccess
Assert-Status 'Address' 'Create second pinned address' 201 $addressTwo
$addressTwoId = $addressTwo.Body.data.id
Assert-Property 'Address' 'Second address is not default' $addressTwo ($addressTwo.Body.data.isDefault -eq $false) 'isDefault=false' 'existing default unchanged'
$response = Invoke-CurlJson GET '/customers/me/addresses' $null $customerAccess
Assert-Status 'Address' 'List owned addresses' 200 $response
$response = Invoke-CurlJson PATCH "/customers/me/addresses/$addressTwoId/default" @{} $customerAccess
Assert-Status 'Address' 'Change default address' 200 $response
$addresses = Invoke-CurlJson GET '/customers/me/addresses' $null $customerAccess
$defaultCount = @($addresses.Body.data | Where-Object { $_.isDefault }).Count
Assert-Property 'Address' 'Exactly one default remains' $addresses ($defaultCount -eq 1 -and $addresses.Body.data[0].id -eq $addressTwoId) 'one default and customer pointer aligned' "default count: $defaultCount"
$response = Invoke-CurlJson PATCH "/customers/me/addresses/$addressOneId" @{ addressLine = 'Updated human text'; landmark = 'Updated landmark' } $customerAccess
Assert-Status 'Address' 'Text-only address edit' 200 $response
Wait-GeocoderSlot
$response = Invoke-CurlJson PATCH "/customers/me/addresses/$addressOneId" @{ pinLat = 19.076; pinLng = 72.8777 } $customerAccess
Assert-Status 'Address' 'Pin edit re-resolves city once' 200 $response
$updatedGeoJson = $response.Body.data.geoPoint | ConvertTo-Json -Compress -Depth 4
Assert-Property 'Address' 'Pin edit updates city and GeoJSON' $response ($response.Body.data.cityId -eq $mumbaiCityId -and $updatedGeoJson -match '72\.8777') 'Mumbai city and new pin' ([string]$response.Body.data.cityId)
Wait-GeocoderSlot
$response = Invoke-CurlJson POST '/customers/me/addresses' @{ label = 'other'; addressLine = 'Unsupported city'; pinLat = 28.6139; pinLng = 77.209 } $customerAccess
Assert-Status 'Address' 'Inactive/unsupported city cannot be saved' 422 $response
$response = Invoke-CurlJson GET "/customers/me/serviceability?cityId=$indoreCityId" $null $customerAccess
Assert-Property 'Address' 'Active city is serviceable' $response ($response.Body.data.serviceable -eq $true) 'serviceable=true' 'active catalog city'
$response = Invoke-CurlJson GET "/customers/me/serviceability?cityId=$inactiveCityId" $null $customerAccess
Assert-Property 'Address' 'Inactive city is not serviceable' $response ($response.Body.data.serviceable -eq $false) 'serviceable=false' 'inactive catalog city'
$response = Invoke-CurlJson GET '/customers/me/serviceability?cityId=90000000-0000-4000-8000-000000000099' $null $customerAccess
Assert-Property 'Address' 'Unknown city is not serviceable' $response ($response.Body.data.serviceable -eq $false) 'serviceable=false' 'unknown catalog id'

# A second customer proves address ownership and merge behavior.
$otherCustomer = Login-WithOtp '+919100000022' 'customer'
Assert-Status 'OTP' 'Second customer OTP login' 201 $otherCustomer.Verify
$response = Invoke-CurlJson PATCH "/customers/me/addresses/$addressOneId" @{ addressLine = 'Attempted takeover' } $otherCustomer.Access
Assert-Status 'Ownership' 'Other customer cannot edit address' 404 $response
$response = Invoke-CurlJson DELETE "/customers/me/addresses/$addressOneId" $null $otherCustomer.Access
Assert-Status 'Ownership' 'Other customer cannot delete address' 404 $response

# In-flight booking guard required by M2. The current result is intentionally
# recorded as a failure if the implementation permits the edit.
$otherCustomerProfile = Invoke-CurlJson GET '/customers/me' $null $otherCustomer.Access
$otherCustomerId = $otherCustomerProfile.Body.data.id
Invoke-Psql "INSERT INTO bookings (id, `"createdAt`", `"updatedAt`", `"bookingNumber`", `"customerId`", `"serviceId`", `"addressId`", status) VALUES ('40000000-0000-4000-8000-000000000001', now(), now(), 'CURL-LIVE-ADDR-1', '$guestId', 'svc-address', '$addressOneId', 'created');"
$response = Invoke-CurlJson PATCH "/customers/me/addresses/$addressOneId" @{ pinLng = 72.88 } $customerAccess
Assert-Status 'Address guard' 'In-flight booking blocks address edit' 409 $response
Invoke-Psql "DELETE FROM bookings WHERE id='40000000-0000-4000-8000-000000000001';"
$response = Invoke-CurlJson DELETE "/customers/me/addresses/$addressTwoId" $null $customerAccess
Assert-Status 'Address' 'Delete current default address' 200 $response
$addresses = Invoke-CurlJson GET '/customers/me/addresses' $null $customerAccess
Assert-Property 'Address' 'Deleting default promotes a replacement' $addresses ($addresses.Body.data.Count -eq 1 -and $addresses.Body.data[0].isDefault) 'remaining address is default' 'default pointer promoted transactionally'

# Super admin authentication and fixed role model
$admin = Login-WithOtp '+916266941709' 'admin'
Assert-Status 'Admin auth' 'Pre-provisioned admin OTP request' 201 $admin.Request
Assert-Status 'Admin auth' 'Pre-provisioned admin OTP verification' 201 $admin.Verify
$adminAccess = $admin.Access
$roles = Invoke-CurlJson GET '/admin/roles' $null $adminAccess
Assert-Status 'Roles' 'List four fixed roles' 200 $roles
Assert-Property 'Roles' 'Exactly four canonical roles seeded' $roles ($roles.Body.data.Count -eq 4) 'four fixed roles' "count: $($roles.Body.data.Count)"
$opsRole = $roles.Body.data | Where-Object { $_.name -eq 'ops' }
$supportRole = $roles.Body.data | Where-Object { $_.name -eq 'support' }
$financeRole = $roles.Body.data | Where-Object { $_.name -eq 'finance' }
$response = Invoke-CurlJson POST '/admin/roles' @{ name = 'ops'; description = 'duplicate'; permissionCodes = @() } $adminAccess
Assert-Status 'Roles' 'Duplicate fixed role rejected' 409 $response
$response = Invoke-CurlJson POST '/admin/roles' @{ name = 'custom_role'; permissionCodes = @() } $adminAccess
Assert-Status 'Roles' 'Non-canonical role name rejected' 400 $response
$response = Invoke-CurlJson PATCH "/admin/roles/$($financeRole.id)" @{ description = 'Finance test role' } $adminAccess
Assert-Status 'Roles' 'Update fixed role metadata' 200 $response
$response = Invoke-CurlJson PATCH '/admin/roles/90000000-0000-4000-8000-000000000099' @{ description = 'missing' } $adminAccess
Assert-Status 'Roles' 'Unknown role update returns 404' 404 $response

# Admin provisioning, deactivation and per-request permissions
$response = Invoke-CurlJson GET '/admin/admin-users' $null $adminAccess
Assert-Status 'Admin users' 'List admins' 200 $response
$response = Invoke-CurlJson POST '/admin/admin-users' @{ phone = '+919100000010'; fullName = 'Indore Ops'; roleId = $opsRole.id; cityScopeJson = @($indoreCityId) } $adminAccess
Assert-Status 'Admin users' 'Provision city-scoped ops admin' 201 $response
$opsAdminId = $response.Body.data.id
$response = Invoke-CurlJson POST '/admin/admin-users' @{ phone = '+919100000013'; fullName = 'Invalid Role Admin'; roleId = '90000000-0000-4000-8000-000000000099' } $adminAccess
Assert-Status 'Admin users' 'Unknown roleId rejected' 400 $response
$response = Invoke-CurlJson POST '/admin/admin-users' @{ phone = '+919100000010'; fullName = 'Duplicate'; roleId = $opsRole.id } $adminAccess
Assert-Status 'Admin users' 'Duplicate admin phone rejected' 409 $response
$response = Invoke-CurlJson PATCH "/admin/admin-users/$opsAdminId" @{ fullName = 'Indore Ops Updated' } $adminAccess
Assert-Status 'Admin users' 'Update admin profile' 200 $response
$response = Invoke-CurlJson POST '/admin/admin-users' @{ phone = '+919100000014'; fullName = 'Finance Admin'; roleId = $financeRole.id } $adminAccess
Assert-Status 'Admin users' 'Provision finance admin' 201 $response
$financeAdminId = $response.Body.data.id
$finance = Login-WithOtp '+919100000014' 'admin'
Assert-Status 'Admin auth' 'Finance admin login' 201 $finance.Verify
$response = Invoke-CurlJson PATCH "/admin/customers/$otherCustomerId/block" @{} $finance.Access
Assert-Status 'Permissions' 'Finance admin denied customer mutation' 403 $response
$response = Invoke-CurlJson PATCH "/admin/admin-users/$financeAdminId" @{ isActive = $false } $adminAccess
Assert-Status 'Admin users' 'Deactivate admin' 200 $response
$response = Invoke-CurlJson GET '/admin/admin-users' $null $finance.Access
Assert-Status 'Admin users' 'Deactivation revokes existing admin access' 401 $response
$response = Invoke-CurlJson POST '/auth/otp/request' @{ phone = '+919100000014'; actorType = 'admin' }
Assert-Status 'Admin auth' 'Deactivated admin cannot request OTP' 401 $response

# Customer moderation and immediate session revocation
$response = Invoke-CurlJson PATCH '/admin/customers/90000000-0000-4000-8000-000000000099/block' @{} $adminAccess
Assert-Status 'Customer moderation' 'Blocking unknown customer returns 404' 404 $response
$response = Invoke-CurlJson PATCH "/admin/customers/$otherCustomerId/block" @{} $adminAccess
Assert-Status 'Customer moderation' 'Block customer' 200 $response
$response = Invoke-CurlJson GET '/customers/me' $null $otherCustomer.Access
Assert-Status 'Customer moderation' 'Blocked customer token denied immediately' 401 $response
$blockedOtp = Login-WithOtp '+919100000022' 'customer'
Assert-Status 'Customer moderation' 'Blocked customer cannot complete login' 401 $blockedOtp.Verify
$response = Invoke-CurlJson PATCH "/admin/customers/$otherCustomerId/unblock" @{} $adminAccess
Assert-Status 'Customer moderation' 'Unblock customer' 200 $response
$otherCustomer = Login-WithOtp '+919100000022' 'customer'
Assert-Status 'Customer moderation' 'Unblocked customer can log in again' 201 $otherCustomer.Verify

# Pro self-service and manual KYC
$pro = Login-WithOtp '+919100000020' 'pro'
Assert-Status 'Pro auth' 'First Pro login auto-creates applied Pro' 201 $pro.Verify
$proAccess = $pro.Access
$proProfile = Invoke-CurlJson GET '/pros/me' $null $proAccess
Assert-Status 'Pro profile' 'Read Pro profile' 200 $proProfile
$proId = $proProfile.Body.data.id
Assert-Property 'Pro profile' 'New Pro begins applied and unavailable' $proProfile ($proProfile.Body.data.status -eq 'applied' -and -not $proProfile.Body.data.isAvailable) 'applied, unavailable' 'dispatch gates start closed'
$response = Invoke-CurlJson PATCH '/pros/me' @{ email = 'pro@example.com'; languages = @('Hindi', 'English'); emergencyContactName = 'Emergency Person'; emergencyContactPhone = '+919123456789'; emergencyContactRelation = 'sibling'; addressLine = 'Indore home base'; homeBaseLat = 22.7196; homeBaseLng = 75.8577 } $proAccess
Assert-Status 'Pro profile' 'Update Pro-owned fields' 200 $response
$response = Invoke-CurlJson PATCH '/pros/me' @{ fullName = 'Illegal Legal Name Edit' } $proAccess
Assert-Status 'Pro profile' 'Legal name rejected from self-service endpoint' 400 $response
$response = Invoke-CurlJson PATCH '/pros/me/profile-photo' @{ key = 'https://example.invalid/photo.jpg' } $proAccess
Assert-Status 'Pro profile' 'Arbitrary profile photo URL is rejected' 400 $response
$photoUpload = Invoke-CurlJson POST '/pros/me/profile-photo/upload-url' @{ contentType = 'image/jpeg' } $proAccess
Assert-Status 'Pro profile' 'Generate controlled profile photo upload URL' 201 $photoUpload
$response = Invoke-CurlJson PATCH '/pros/me/profile-photo' @{ key = $photoUpload.Body.data.key } $proAccess
Assert-Status 'Pro profile' 'Pro can attach issued profile photo key' 200 $response
$response = Invoke-CurlJson POST '/pros/me/location' @{ lat = 22.7196; lng = 75.8577 } $proAccess
Assert-Status 'Pro location' 'Off-duty/unapproved location ingest denied' 403 $response
$response = Invoke-CurlJson GET '/pros/me/applications' $null $proAccess
Assert-Status 'KYC' 'List own applications before submission' 200 $response
$response = Invoke-CurlJson POST '/pros/me/kyc/upload-url' @{ docType = 'passport'; contentType = 'image/jpeg' } $proAccess
Assert-Status 'KYC' 'Unsupported KYC document type rejected' 400 $response
$aadhaarUpload = Invoke-CurlJson POST '/pros/me/kyc/upload-url' @{ docType = 'aadhaar'; contentType = 'image/jpeg' } $proAccess
Assert-Status 'KYC' 'Generate Aadhaar S3 upload URL' 201 $aadhaarUpload
$panUpload = Invoke-CurlJson POST '/pros/me/kyc/upload-url' @{ docType = 'pan'; contentType = 'application/pdf' } $proAccess
Assert-Status 'KYC' 'Generate PAN S3 upload URL' 201 $panUpload
$response = Invoke-CurlJson POST '/pros/me/applications' @{ documentFullName = 'Legal Pro'; documentDateOfBirth = '1995-08-17'; documentGender = 'male'; aadhaarSource = 'manual'; panSource = 'manual'; panUrl = $panUpload.Body.data.key } $proAccess
Assert-Status 'KYC' 'Manual Aadhaar URL is mandatory' 400 $response
$response = Invoke-CurlJson POST '/pros/me/applications' @{ documentFullName = 'Legal Pro'; documentDateOfBirth = '1995-08-17'; documentGender = 'male'; aadhaarSource = 'digilocker'; aadhaarUrl = 'x'; panSource = 'manual'; panUrl = 'y' } $proAccess
Assert-Status 'KYC' 'DigiLocker source is disabled for now' 400 $response
$applicationBody = @{
  documentFullName = 'Legal Pro'
  documentDateOfBirth = '1995-08-17'
  documentGender = 'male'
  referredByType = 'customer'
  referredById = $guestId
  aadhaarSource = 'manual'
  aadhaarUrl = $aadhaarUpload.Body.data.key
  aadhaarNumberMasked = 'XXXX-XXXX-1234'
  panSource = 'manual'
  panUrl = $panUpload.Body.data.key
  panNumberMasked = 'XXXXX1234F'
}
$application = Invoke-CurlJson POST '/pros/me/applications' $applicationBody $proAccess
Assert-Status 'KYC' 'Submit manual KYC application' 201 $application
$applicationId = $application.Body.data.id
$applicationBody.documentFullName = 'Legal Pro Corrected'
$resubmitted = Invoke-CurlJson POST '/pros/me/applications' $applicationBody $proAccess
Assert-Status 'KYC' 'Resubmit open application' 201 $resubmitted
Assert-Property 'KYC' 'Pending resubmission updates same queue item' $resubmitted ($resubmitted.Body.data.id -eq $applicationId) 'same application id' ([string]$applicationId)

# Client-provided masked values must not allow raw identifiers at rest.
$rawKycPro = Login-WithOtp '+919100000023' 'pro'
$rawKyc = Invoke-CurlJson POST '/pros/me/applications' @{
  documentFullName = 'Masking Test'
  documentDateOfBirth = '1990-01-01'
  documentGender = 'female'
  aadhaarSource = 'manual'
  aadhaarUrl = 'pros/test/kyc/aadhaar.jpg'
  aadhaarNumberMasked = '123412341234'
  panSource = 'manual'
  panUrl = 'pros/test/kyc/pan.jpg'
  panNumberMasked = 'XXXXX1234F'
} $rawKycPro.Access
Assert-Status 'KYC security' 'Unmasked Aadhaar number is rejected' 400 $rawKyc

# Admin KYC queue, document decisions, call, view and approval.
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/profile" @{ cityId = $indoreCityId; monthlySalary = 25000 } $adminAccess
Assert-Status 'Admin Pro profile' 'Admin assigns city and reference salary' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/profile" @{ cityId = '90000000-0000-4000-8000-000000000099' } $adminAccess
Assert-Status 'Admin Pro profile' 'Unknown city assignment rejected' 400 $response
$response = Invoke-CurlJson GET '/admin/pro-applications?status=pending' $null $adminAccess
Assert-Status 'KYC admin' 'List onboarding queue by stage' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/verify-document" @{ docType = 'aadhaar'; decision = 'rejected' } $adminAccess
Assert-Status 'KYC admin' 'Document rejection requires reason' 400 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/verify-document" @{ docType = 'aadhaar'; decision = 'verified' } $adminAccess
Assert-Status 'KYC admin' 'Verify Aadhaar independently' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/decision" @{ decision = 'approved' } $adminAccess
Assert-Status 'KYC admin' 'Approval blocked until both documents verified' 409 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/verify-document" @{ docType = 'pan'; decision = 'verified' } $adminAccess
Assert-Status 'KYC admin' 'Verify PAN independently' 200 $response
$response = Invoke-CurlJson GET "/admin/pro-applications/$applicationId/documents/aadhaar/view-url" $null $adminAccess
Assert-Status 'KYC admin' 'Generate short-lived document view URL' 200 $response
$response = Invoke-CurlJson GET "/admin/pro-applications/$applicationId/documents/passport/view-url" $null $adminAccess
Assert-Status 'KYC admin' 'Unsupported view document type rejected' 400 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/log-call" @{} $adminAccess
Assert-Status 'KYC admin' 'Log verification call' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$applicationId/decision" @{ decision = 'approved' } $adminAccess
Assert-Status 'KYC admin' 'Approve verified application' 200 $response
$approvedProfile = Invoke-CurlJson GET '/pros/me' $null $proAccess
Assert-Property 'KYC approval' 'Approval copies and locks legal identity' $approvedProfile ($approvedProfile.Body.data.fullName -eq 'Legal Pro Corrected' -and $approvedProfile.Body.data.employeeCode -match '^HG-\d{5}$') 'document identity plus employee code' ([string]$approvedProfile.Body.data.employeeCode)
$response = Invoke-CurlJson POST '/pros/me/applications' $applicationBody $proAccess
Assert-Status 'KYC' 'Approved identity cannot self-resubmit' 409 $response

# Changes-requested then rejected/re-application lifecycle on another Pro.
$correctionPro = Login-WithOtp '+919100000024' 'pro'
$correctionProfile = Invoke-CurlJson GET '/pros/me' $null $correctionPro.Access
$correctionProId = $correctionProfile.Body.data.id
$correctionBody = @{
  documentFullName = 'Correction Pro'
  documentDateOfBirth = '1994-02-03'
  documentGender = 'transgender'
  aadhaarSource = 'manual'
  aadhaarUrl = 'pros/test-correction/kyc/aadhaar.jpg'
  aadhaarNumberMasked = 'XXXX-XXXX-5678'
  panSource = 'manual'
  panUrl = 'pros/test-correction/kyc/pan.jpg'
  panNumberMasked = 'XXXXX1234Z'
}
$correctionApp = Invoke-CurlJson POST '/pros/me/applications' $correctionBody $correctionPro.Access
$correctionAppId = $correctionApp.Body.data.id
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/decision" @{ decision = 'changes_requested' } $adminAccess
Assert-Status 'KYC lifecycle' 'Correction request without reason rejected' 400 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/decision" @{ decision = 'changes_requested'; reason = 'Replace blurred PAN image' } $adminAccess
Assert-Status 'KYC lifecycle' 'Admin sends correction message' 200 $response
$correctionBody.documentFullName = 'Correction Pro Resubmitted'
$corrected = Invoke-CurlJson POST '/pros/me/applications' $correctionBody $correctionPro.Access
Assert-Property 'KYC lifecycle' 'Correction resubmission updates same attempt' $corrected ($corrected.Body.data.id -eq $correctionAppId) 'same attempt id' ([string]$correctionAppId)
$null = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/verify-document" @{ docType = 'aadhaar'; decision = 'verified' } $adminAccess
$null = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/verify-document" @{ docType = 'pan'; decision = 'verified' } $adminAccess
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/decision" @{ decision = 'rejected'; reason = 'Identity mismatch' } $adminAccess
Assert-Status 'KYC lifecycle' 'Reject application with reason' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pro-applications/$correctionAppId/decision" @{ decision = 'approved' } $adminAccess
Assert-Status 'KYC lifecycle' 'Final decision cannot be rewritten' 409 $response
$newAttempt = Invoke-CurlJson POST '/pros/me/applications' $correctionBody $correctionPro.Access
Assert-Status 'KYC lifecycle' 'Rejected Pro may reapply' 201 $newAttempt
Assert-Property 'KYC lifecycle' 'Reapplication creates a new attempt' $newAttempt ($newAttempt.Body.data.id -ne $correctionAppId) 'new application id' ([string]$newAttempt.Body.data.id)

# Services, roster, bank accounts, availability and location.
$response = Invoke-CurlJson POST "/admin/pros/$proId/services" @{ serviceId = 'svc-ac'; proficiency = 'skilled' } $adminAccess
Assert-Status 'Pro services' 'Assign active ProService' 201 $response
$response = Invoke-CurlJson POST "/admin/pros/$proId/services" @{ serviceId = 'svc-ac'; proficiency = 'expert' } $adminAccess
Assert-Status 'Pro services' 'Duplicate service assignment rejected' 409 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/services/svc-missing" @{ isActive = $false } $adminAccess
Assert-Status 'Pro services' 'Unknown service assignment returns 404' 404 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/services/svc-ac" @{ proficiency = 'expert' } $adminAccess
Assert-Status 'Pro services' 'Update service proficiency' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/availability" @{ isAvailable = $true } $adminAccess
Assert-Status 'Availability' 'Admin switches Pro on duty' 200 $response
$response = Invoke-CurlJson POST '/pros/me/location' @{ lat = 22.7196; lng = 75.8577 } $proAccess
Assert-Status 'Pro location' 'Approved on-duty location accepted' 201 $response
$proAfterLocation = Invoke-CurlJson GET '/pros/me' $null $proAccess
Assert-Property 'Pro location' 'Location cold copy persisted' $proAfterLocation ($proAfterLocation.Body.data.lastKnownLat -eq 22.7196 -and $proAfterLocation.Body.data.lastLocationAt) 'last known coordinate and timestamp' 'Redis GEO plus PostgreSQL cold copy'
$response = Invoke-CurlJson POST '/pros/me/bank-accounts' @{ accountHolderName = 'Legal Pro'; accountNumberMasked = '123456789012'; ifscCode = 'HDFC0001234'; isPrimary = $true } $proAccess
Assert-Status 'Bank security' 'Unmasked bank account number is rejected' 400 $response
$bankOne = Invoke-CurlJson POST '/pros/me/bank-accounts' @{ accountHolderName = 'Legal Pro'; accountNumberMasked = 'XXXXXXXX9012'; ifscCode = 'HDFC0001234'; upiId = 'pro@exampleupi'; isPrimary = $true } $proAccess
Assert-Status 'Bank' 'Create masked primary bank account' 201 $bankOne
$bankOneId = $bankOne.Body.data.id
$bankTwo = Invoke-CurlJson POST '/pros/me/bank-accounts' @{ accountHolderName = 'Legal Pro'; accountNumberMasked = 'XXXXXXXX3456'; ifscCode = 'ICIC0005678'; isPrimary = $true } $proAccess
Assert-Status 'Bank' 'Create second primary bank account' 201 $bankTwo
$bankTwoId = $bankTwo.Body.data.id
$response = Invoke-CurlJson GET '/pros/me/bank-accounts' $null $proAccess
Assert-Status 'Bank' 'List own bank accounts' 200 $response
$primaryCount = @($response.Body.data | Where-Object { $_.isPrimary }).Count
Assert-Property 'Bank' 'Exactly one bank account remains primary' $response ($primaryCount -eq 1 -and ($response.Body.data | Where-Object { $_.id -eq $bankTwoId }).isPrimary) 'one primary' "primary count: $primaryCount"
$response = Invoke-CurlJson PATCH "/pros/me/bank-accounts/$bankOneId" @{ isPrimary = $true } $proAccess
Assert-Status 'Bank' 'Switch primary bank account' 200 $response
$response = Invoke-CurlJson PATCH "/pros/me/bank-accounts/$bankOneId" @{ isVerified = $true } $proAccess
Assert-Status 'Bank security' 'Pro cannot self-verify bank account' 400 $response
$response = Invoke-CurlJson PATCH "/pros/me/bank-accounts/$bankOneId" @{ ifscCode = 'HDFC0009999' } $correctionPro.Access
Assert-Status 'Ownership' 'Other Pro cannot edit bank account' 404 $response

# History fixtures support all read APIs and suspension payment guarantees.
Invoke-Psql @"
UPDATE pros SET "ratingSum"=9, "ratingCount"=2, "assignmentsOffered"=4,
  "assignmentsAcknowledged"=3, "acceptanceRate"=0.75, "completedJobs"=1,
  "countersRebuiltAt"=now() WHERE id='$proId';
INSERT INTO bookings (id, "createdAt", "updatedAt", "bookingNumber", "customerId", "serviceId", "addressId", status, "proId", "assignedAt", "completedAt", "actualDurationMinutes")
VALUES ('40000000-0000-4000-8000-000000000010', now()-interval '2 days', now(), 'CURL-DONE-1', '$guestId', 'svc-ac', '$addressOneId', 'completed', '$proId', now()-interval '2 days', now()-interval '1 day', 65);
INSERT INTO reviews (id, "createdAt", "updatedAt", "bookingId", "customerId", "proId", rating, comment, tags, "isHidden")
VALUES ('50000000-0000-4000-8000-000000000010', now()-interval '1 day', now(), '40000000-0000-4000-8000-000000000010', '$guestId', '$proId', 5, 'Good work', '["punctual"]', false);
INSERT INTO booking_commissions (id, "createdAt", "updatedAt", "bookingId", "proId", "customerFlatAmount", "actualDurationMinutes", "commissionType", "commissionValue", "commissionAmount", "platformAmount", "incentiveAmount", "deductionAmount", "netPayable", status, "computedAt")
VALUES ('60000000-0000-4000-8000-000000000010', now(), now(), '40000000-0000-4000-8000-000000000010', '$proId', 1000, 65, 'percentage', 70, 700, 300, 50, 20, 730, 'approved', now()-interval '1 day');
INSERT INTO commission_payouts (id, "createdAt", "updatedAt", "proId", "bankAccountId", "periodStart", "periodEnd", "commissionAmount", "incentiveAmount", "deductionAmount", "netAmount", status, "paidAt", "payoutReference")
VALUES ('70000000-0000-4000-8000-000000000010', now(), now(), '$proId', '$bankOneId', current_date-7, current_date, 700, 50, 20, 730, 'paid', now(), 'CURL-PAYOUT-1');
UPDATE booking_commissions SET "payoutId"='70000000-0000-4000-8000-000000000010' WHERE id='60000000-0000-4000-8000-000000000010';
"@
$response = Invoke-CurlJson GET '/pros/me/standing' $null $proAccess
Assert-Status 'Pro history' 'Read standing' 200 $response
Assert-Property 'Pro history' 'Standing distinguishes rating and acceptance effects' $response ($response.Body.data.ratingAffectsDispatch -and -not $response.Body.data.acceptanceAffectsDispatch -and $response.Body.data.acceptanceRatePercent -eq 75) 'rating affects dispatch; acceptance does not' 'raw 3 of 4 and 75 percent exposed'
$response = Invoke-CurlJson GET '/pros/me/jobs?page=1&limit=10' $null $proAccess
Assert-Status 'Pro history' 'Read paginated job history' 200 $response
$response = Invoke-CurlJson GET '/pros/me/jobs?page=0&limit=101' $null $proAccess
Assert-Status 'Pro history' 'Invalid history pagination rejected' 400 $response
$response = Invoke-CurlJson GET '/pros/me/ratings' $null $proAccess
Assert-Status 'Pro history' 'Read ratings received' 200 $response
$response = Invoke-CurlJson GET '/pros/me/earnings' $null $proAccess
Assert-Status 'Pro history' 'Read commission-only earnings' 200 $response
Assert-Property 'Pro history' 'Earnings explicitly exclude salary' $response ($response.Body.data.basis -eq 'commission_only' -and -not $response.Body.data.salaryIncluded) 'commission only' 'salaryIncluded=false'
$response = Invoke-CurlJson GET '/pros/me/earnings?from=not-a-date' $null $proAccess
Assert-Status 'Pro history' 'Invalid date filter rejected' 400 $response
$response = Invoke-CurlJson GET '/pros/me/commissions' $null $proAccess
Assert-Status 'Pro history' 'Read commission history' 200 $response
$response = Invoke-CurlJson GET '/pros/me/payouts' $null $proAccess
Assert-Status 'Pro history' 'Read payout history' 200 $response
$response = Invoke-CurlJson GET '/pros/me/payouts/70000000-0000-4000-8000-000000000010' $null $proAccess
Assert-Status 'Pro history' 'Read own payout details' 200 $response
$response = Invoke-CurlJson GET '/pros/me/payouts/70000000-0000-4000-8000-000000000099' $null $proAccess
Assert-Status 'Ownership' 'Unknown/foreign payout is non-disclosed as 404' 404 $response

# City scope and permission revocation on the next request.
$mumbaiPro = Login-WithOtp '+919100000025' 'pro'
$mumbaiProfile = Invoke-CurlJson GET '/pros/me' $null $mumbaiPro.Access
$mumbaiProId = $mumbaiProfile.Body.data.id
$null = Invoke-CurlJson PATCH "/admin/pros/$mumbaiProId/profile" @{ cityId = $mumbaiCityId } $adminAccess
$ops = Login-WithOtp '+919100000010' 'admin'
Assert-Status 'City scope' 'City-scoped ops admin login' 201 $ops.Verify
$response = Invoke-CurlJson GET '/admin/pros' $null $ops.Access
Assert-Status 'City scope' 'City-scoped roster list' 200 $response
Assert-Property 'City scope' 'Roster excludes Pros outside scope' $response (-not ($response.Body.data.id -contains $mumbaiProId)) 'Mumbai Pro absent' 'Indore-only projection'
$response = Invoke-CurlJson PATCH "/admin/pros/$mumbaiProId/availability" @{ isAvailable = $true } $ops.Access
Assert-Status 'City scope' 'Out-of-city Pro mutation denied' 403 $response
$response = Invoke-CurlJson PATCH '/admin/pros/availability/bulk' @{ proIds = @($proId, $mumbaiProId); isAvailable = $false } $ops.Access
Assert-Status 'City scope' 'Mixed-city bulk toggle denied atomically' 403 $response
$response = Invoke-CurlJson GET "/admin/pros?cityId=$mumbaiCityId" $null $ops.Access
Assert-Status 'City scope' 'Requested out-of-scope roster city is denied' 403 $response
$originalOpsPermissions = @('pro.application.review', 'pro.moderate', 'pro.availability.set')
$response = Invoke-CurlJson PATCH "/admin/roles/$($opsRole.id)" @{ permissionCodes = @('pro.application.review', 'pro.availability.set') } $adminAccess
Assert-Status 'Permissions' 'Remove permission from role' 200 $response
$response = Invoke-CurlJson GET '/admin/pros' $null $ops.Access
Assert-Status 'Permissions' 'Permission removal applies on next request' 403 $response
$null = Invoke-CurlJson PATCH "/admin/roles/$($opsRole.id)" @{ permissionCodes = $originalOpsPermissions } $adminAccess

# Bulk availability positive route.
$response = Invoke-CurlJson PATCH '/admin/pros/availability/bulk' @{ proIds = @($proId); isAvailable = $true } $adminAccess
Assert-Status 'Availability' 'Bulk availability toggle' 200 $response
$response = Invoke-CurlJson PATCH '/admin/pros/availability/bulk' @{ proIds = @(); isAvailable = $true } $adminAccess
Assert-Status 'Availability' 'Empty bulk toggle rejected' 400 $response

# Live-booking suspension handling, token revocation, suspended read-only access,
# dispatch gates, and reinstatement.
Invoke-Psql "INSERT INTO bookings (id, `"createdAt`", `"updatedAt`", `"bookingNumber`", `"customerId`", `"serviceId`", `"addressId`", status, `"proId`", `"assignedAt`") VALUES ('40000000-0000-4000-8000-000000000011', now(), now(), 'CURL-LIVE-PRO-1', '$guestId', 'svc-ac', '$addressOneId', 'en_route', '$proId', now());"
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/suspend" @{} $adminAccess
Assert-Status 'Suspension' 'Live booking requires explicit handling' 409 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/suspend" @{ confirmLiveBookingHandling = $true } $adminAccess
Assert-Status 'Suspension' 'Live booking handling requires reason' 400 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/suspend" @{ confirmLiveBookingHandling = $true; reason = 'Safety suspension test' } $adminAccess
Assert-Status 'Suspension' 'Suspend Pro and resolve pre-arrival live work' 200 $response
$bookingState = Invoke-Psql "SELECT status || ':' || coalesce(`"proId`"::text, 'none') FROM bookings WHERE id='40000000-0000-4000-8000-000000000011';" -Scalar
Add-Result 'Suspension' 'Pre-arrival booking returned to dispatch' 'assigning:none' 200 ($bookingState -eq 'assigning:none') $bookingState
$response = Invoke-CurlJson GET '/pros/me' $null $proAccess
Assert-Status 'Suspension' 'Suspension blocks prior Pro session from non-history routes' 403 $response
$suspendedPro = Login-WithOtp '+919100000020' 'pro'
Assert-Status 'Suspension' 'Suspended Pro can authenticate for owed-history access' 201 $suspendedPro.Verify
$response = Invoke-CurlJson GET '/pros/me' $null $suspendedPro.Access
Assert-Status 'Suspension' 'Suspended Pro denied ordinary profile route' 403 $response
$response = Invoke-CurlJson PATCH '/pros/me' @{ email = 'blocked-change@example.com' } $suspendedPro.Access
Assert-Status 'Suspension' 'Suspended Pro denied profile mutation' 403 $response
$response = Invoke-CurlJson POST '/pros/me/location' @{ lat = 22.7196; lng = 75.8577 } $suspendedPro.Access
Assert-Status 'Suspension' 'Suspended Pro denied location ingest' 403 $response
foreach ($path in @('/pros/me/standing', '/pros/me/jobs', '/pros/me/ratings', '/pros/me/earnings', '/pros/me/commissions', '/pros/me/payouts', '/pros/me/payouts/70000000-0000-4000-8000-000000000010')) {
  $response = Invoke-CurlJson GET $path $null $suspendedPro.Access
  Assert-Status 'Suspended history' "Suspended read allowed: $path" 200 $response
}
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/services/svc-ac" @{ isActive = $false } $adminAccess
Assert-Status 'Reinstatement' 'Suspend one service independently' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/reinstate" @{} $adminAccess
Assert-Status 'Reinstatement' 'Reinstate blocked by service and availability gates' 409 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/availability" @{ isAvailable = $true } $adminAccess
Assert-Status 'Reinstatement' 'Admin opens availability gate' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/reinstate" @{} $adminAccess
Assert-Status 'Reinstatement' 'Inactive service still blocks reinstatement' 409 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/services/svc-ac" @{ isActive = $true } $adminAccess
Assert-Status 'Reinstatement' 'Reactivate service gate' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/reinstate" @{} $adminAccess
Assert-Status 'Reinstatement' 'Reinstate after all three gates pass' 200 $response
$response = Invoke-CurlJson PATCH "/admin/pros/$proId/reinstate" @{} $adminAccess
Assert-Status 'Reinstatement' 'Cannot reinstate a non-suspended Pro' 409 $response

# OTP request throttling, wrong-code lockout, logout-all and guest merge.
$rateStatuses = @()
1..6 | ForEach-Object { $rateStatuses += (Invoke-CurlJson POST '/auth/otp/request' @{ phone = '+919100000030'; actorType = 'customer' }).Status }
$ratePass = (($rateStatuses[0..4] | Where-Object { $_ -eq 201 }).Count -eq 5 -and $rateStatuses[5] -eq 429)
Add-Result 'OTP limits' 'Per-phone request throttling' '201 x5, then 429' $rateStatuses[-1] $ratePass ($rateStatuses -join ',')
$lockPhone = '+919100000031'
$lockRequest = Invoke-CurlJson POST '/auth/otp/request' @{ phone = $lockPhone; actorType = 'customer' }
$lockStatuses = @()
1..6 | ForEach-Object { $lockStatuses += (Invoke-CurlJson POST '/auth/otp/verify' @{ phone = $lockPhone; actorType = 'customer'; code = '000000'; providerRef = $lockRequest.Body.data.providerRef }).Status }
$lockPass = (($lockStatuses[0..4] | Where-Object { $_ -eq 401 }).Count -eq 5 -and $lockStatuses[5] -eq 429)
Add-Result 'OTP limits' 'Wrong-code lockout' '401 x5, then 429' $lockStatuses[-1] $lockPass ($lockStatuses -join ',')
$sessionA = Login-WithOtp '+919100000032' 'customer'
$sessionB = Login-WithOtp '+919100000032' 'customer'
$response = Invoke-CurlJson POST '/auth/logout-all' @{} $sessionA.Access
Assert-Status 'Session' 'Logout all sessions' 204 $response
$response = Invoke-CurlJson POST '/auth/refresh' @{ refreshToken = $sessionB.Refresh }
Assert-Status 'Session' 'Logout-all revokes second device session' 401 $response

$existing = Login-WithOtp '+919100000033' 'customer'
$existingProfile = Invoke-CurlJson GET '/customers/me' $null $existing.Access
$existingId = $existingProfile.Body.data.id
$mergeGuest = Invoke-CurlJson POST '/auth/guest-session' @{ deviceId = 'curl-merge-device-0001' }
$mergeGuestProfile = Invoke-CurlJson GET '/customers/me' $null $mergeGuest.Body.data.accessToken
$mergeGuestId = $mergeGuestProfile.Body.data.id
Wait-GeocoderSlot
$mergeAddress = Invoke-CurlJson POST '/customers/me/addresses' @{ label = 'home'; addressLine = 'Guest work to preserve'; pinLat = 22.7196; pinLng = 75.8577 } $mergeGuest.Body.data.accessToken
$mergeRequest = Invoke-CurlJson POST '/auth/otp/request' @{ phone = '+919100000033'; actorType = 'customer' }
$mergeVerify = Invoke-CurlJson POST '/auth/otp/verify' @{ phone = '+919100000033'; actorType = 'customer'; code = (Get-MockCode '+919100000033'); providerRef = $mergeRequest.Body.data.providerRef; deviceId = 'curl-merge-device-0001' }
Assert-Status 'Guest merge' 'Verify phone already owned by customer' 201 $mergeVerify
$mergedProfile = Invoke-CurlJson GET '/customers/me' $null $mergeVerify.Body.data.accessToken
Assert-Property 'Guest merge' 'Existing verified Customer row wins merge' $mergedProfile ($mergedProfile.Body.data.id -eq $existingId) 'existing verified id' "guest $mergeGuestId merged into $existingId"
$mergedAddresses = Invoke-CurlJson GET '/customers/me/addresses' $null $mergeVerify.Body.data.accessToken
Assert-Property 'Guest merge' 'Guest address survives merge' $mergedAddresses ($mergedAddresses.Body.data.id -contains $mergeAddress.Body.data.id) 'address moved to verified row' ([string]$mergeAddress.Body.data.id)
$guestStillExists = Invoke-Psql "SELECT count(*) FROM customers WHERE id='$mergeGuestId';" -Scalar
Add-Result 'Guest merge' 'Merged guest row is discarded' '0 rows' 200 ($guestStillExists -eq '0') "rows: $guestStillExists"

$results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultFile -Encoding utf8
$results | Format-Table Area, Test, Expected, Actual, Passed -AutoSize
$passed = @($results | Where-Object Passed).Count
$failed = @($results | Where-Object { -not $_.Passed }).Count
Write-Output "TOTAL=$($results.Count) PASSED=$passed FAILED=$failed"
if ($failed -gt 0) { exit 2 }
