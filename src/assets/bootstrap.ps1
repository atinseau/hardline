#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Keep this file ASCII: it can be displayed by an OEM-code-page console.
if (-not $HardlineUrl -or -not $HardlineToken -or -not $c) {
    throw 'Bootstrap must be started with the Hardline rendezvous command.'
}

function Invoke-HardlinePost($path, $value) {
    $json = $value | ConvertTo-Json -Depth 8 -Compress
    $content = [System.Net.Http.StringContent]::new(
        $json,
        [System.Text.Encoding]::UTF8,
        'application/json'
    )
    $response = $c.PostAsync("$HardlineUrl$path", $content).GetAwaiter().GetResult()
    $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
        throw "Bootstrap rendezvous refused $path (HTTP $([int]$response.StatusCode))."
    }
    return $responseBody | ConvertFrom-Json
}

Write-Host ''
Write-Host 'hardline - PC bootstrap rendezvous' -ForegroundColor Cyan
Write-Host ''

# Phase one is read-only. Only physical adapters are offered for selection.
$physicalAdapters = @(Get-NetAdapter -Physical -ErrorAction Stop)
$adapterObservations = @($physicalAdapters | ForEach-Object {
    $interfaceIndex = [int]$_.ifIndex
    $physicalMedia = [string]$_.PhysicalMediaType
    $transport = if ($physicalMedia -match '802\.3|Ethernet') {
        'ethernet'
    } elseif ($physicalMedia -match '802\.11|Wireless') {
        'wifi'
    } elseif ($physicalMedia -match 'Bluetooth') {
        'bluetooth'
    } else {
        'other'
    }
    $speedMatch = [regex]::Match([string]$_.LinkSpeed, '^[\d.]+')
    $speedMbps = if ($speedMatch.Success) {
        $multiplier = if ([string]$_.LinkSpeed -match 'Gbps') { 1000 } else { 1 }
        [double]$speedMatch.Value * $multiplier
    } else { $null }
    [pscustomobject]@{
        alias = [string]$_.Name
        interfaceIndex = $interfaceIndex
        hardwareId = [string]$_.InterfaceGuid
        hardwareName = [string]$_.InterfaceDescription
        macAddress = [string]$_.MacAddress
        speedMbps = $speedMbps
        physical = [bool]$_.HardwareInterface
        transport = $transport
        virtual = [bool]$_.Virtual
        linkState = if ([string]$_.Status -eq 'Up') { 'up' } else { 'down' }
        ipv4Addresses = @(Get-NetIPAddress -InterfaceIndex $interfaceIndex `
            -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
                "$($_.IPAddress)/$($_.PrefixLength)"
            })
    }
})
$routeObservations = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    ForEach-Object {
        [pscustomobject]@{
            interfaceIndex = [int]$_.InterfaceIndex
            destinationPrefix = [string]$_.DestinationPrefix
            nextHop = [string]$_.NextHop
        }
    })
$activeIpv4Addresses = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { [string]$_.State -notin @('Unreachable', 'Incomplete') } |
    ForEach-Object { "$([string]$_.IPAddress)/32" })
$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' |
    Select-Object -First 1
$service = Get-Service -Name sshd -ErrorAction SilentlyContinue
$firewallRule = Get-NetFirewallRule -Name 'hardline-sshd' -ErrorAction SilentlyContinue
$keyFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$hostKeyPath = Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key.pub'
$currentHostKey = $null
if (Test-Path $hostKeyPath) {
    $currentPublicKey = (Get-Content -Path $hostKeyPath -Raw).Trim()
    $currentParts = $currentPublicKey -split '\s+'
    $currentFingerprint = & ssh-keygen.exe -l -E sha256 -f $hostKeyPath
    if ($LASTEXITCODE -eq 0 -and $currentFingerprint -match '(SHA256:[^\s]+)' -and
        $currentParts.Count -ge 2) {
        $currentHostKey = [pscustomobject]@{
            algorithm = [string]$currentParts[0]
            fingerprint = [string]$Matches[1]
            publicKey = "$($currentParts[0]) $($currentParts[1])"
        }
    }
}
$machine = Get-CimInstance -ClassName Win32_ComputerSystemProduct
$nonce = [Guid]::NewGuid().ToString('N')
$observations = [pscustomobject]@{
    computerName = [string]$env:COMPUTERNAME
    machineId = [string]$machine.UUID
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    activeIpv4Addresses = $activeIpv4Addresses
    administrator = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    networkAdapters = $adapterObservations
    routes = $routeObservations
    openSsh = [pscustomobject]@{
        capabilityState = if ($capability) { [string]$capability.State } else { $null }
        serviceStartType = if ($service) { [string]$service.StartType } else { $null }
        serviceStatus = if ($service) { [string]$service.Status } else { $null }
        firewallRulePresent = [bool]$firewallRule
        administratorsAuthorizedKeysPresent = [bool](Test-Path $keyFile)
        hostKey = $currentHostKey
    }
}
$authorization = Invoke-HardlinePost '/phase-one' ([pscustomobject]@{
    clientNonce = $nonce
    observations = $observations
})
if ($authorization.kind -ne 'plan-authorized') {
    throw 'Bootstrap rendezvous did not authorize a mutation plan.'
}
$plan = $authorization.plan
$authorizedAlias = [string]$plan.directLink.interfaceAlias
$target = [string]$plan.directLink.address
$prefix = [int]$plan.directLink.prefixLength
$publicKey = [string]$plan.ssh.administratorPublicKey

# Refuse a plan that names anything except one of the observed physical adapters.
$adapter = $physicalAdapters | Where-Object { $_.Name -ceq $authorizedAlias } |
    Select-Object -First 1
if (-not $adapter) {
    throw 'The authorized interface is not an observed physical adapter.'
}
$alias = [string]$adapter.Name
$hardwareId = [string]$adapter.InterfaceGuid

# Capture the immutable recovery record after authorization and before mutation.
$stateDir = Join-Path $env:ProgramData 'hardline'
$statePath = Join-Path $stateDir 'bootstrap-state.json'
if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}
if (Test-Path $statePath) {
    $recorded = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($recorded.machineId -cne $observations.machineId -or
        $recorded.hardwareId -ne $hardwareId -or
        $recorded.address -cne $target -or
        $recorded.authorizedKeys.publicKey -cne $publicKey) {
        throw 'The immutable bootstrap recovery record belongs to another plan.'
    }
} else {
    $addresses = @(Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 `
        -ErrorAction SilentlyContinue)
    $netInterface = Get-NetIPInterface -InterfaceAlias $alias -AddressFamily IPv4 `
        -ErrorAction SilentlyContinue
    $netProfile = Get-NetConnectionProfile -InterfaceAlias $alias `
        -ErrorAction SilentlyContinue
    $hasTarget = [bool](@($addresses | Where-Object { $_.IPAddress -eq $target }).Count)
    $keyFileExisted = Test-Path $keyFile
    $keyPresent = $false
    $aclSddl = $null
    if ($keyFileExisted) {
        $keyPresent = [bool](Select-String -Path $keyFile -SimpleMatch $publicKey `
            -Quiet -ErrorAction SilentlyContinue)
        $aclSddl = [string](Get-Acl -Path $keyFile).Sddl
    }
    $recovery = [pscustomobject]@{
        version = 1
        machineId = [string]$observations.machineId
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
        interfaceAlias = $alias
        hardwareId = $hardwareId
        address = $target
        capability = [pscustomobject]@{
            name = if ($capability) { [string]$capability.Name } else { $null }
            state = if ($capability) { [string]$capability.State } else { $null }
            changed = [bool]$plan.ssh.installServer
        }
        sshd = [pscustomobject]@{
            present = [bool]$service
            startupType = if ($service) { [string]$service.StartType } else { $null }
            status = if ($service) { [string]$service.Status } else { $null }
            startupChanged = [bool]($plan.ssh.startService -and
                (-not $service -or [string]$service.StartType -ne 'Automatic'))
            statusChanged = [bool]($plan.ssh.startService -and
                (-not $service -or [string]$service.Status -ne 'Running'))
        }
        firewall = [pscustomobject]@{
            name = 'hardline-sshd'
            existed = [bool]$firewallRule
            changed = [bool]($plan.ssh.openFirewall -and -not $firewallRule)
        }
        authorizedKeys = [pscustomobject]@{
            path = [string]$keyFile
            publicKey = $publicKey
            fileExisted = [bool]$keyFileExisted
            keyPresent = [bool]$keyPresent
            aclSddl = $aclSddl
            changed = [bool](-not $keyPresent)
            aclChanged = [bool]$keyFileExisted
        }
        network = [pscustomobject]@{
            addresses = @($addresses | ForEach-Object {
                "$($_.IPAddress)/$($_.PrefixLength)"
            })
            manualAddresses = @($addresses | Where-Object {
                $_.PrefixOrigin -eq 'Manual'
            } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
            dhcp = if ($netInterface) { [string]$netInterface.Dhcp } else { $null }
            category = if ($netProfile) {
                [string]$netProfile.NetworkCategory
            } else { $null }
            addressingChanged = [bool](-not $hasTarget)
            categoryChanged = [bool]($netProfile -and
                [string]$netProfile.NetworkCategory -ne 'Private')
        }
    }
    $recoveryTemp = "$statePath.tmp"
    $recovery | ConvertTo-Json -Depth 8 | Set-Content -Path $recoveryTemp `
        -Encoding UTF8
    Move-Item -Path $recoveryTemp -Destination $statePath -Force
    [System.IO.File]::SetAttributes($statePath, [System.IO.FileAttributes]::ReadOnly)
}

# Phase two performs only mutations named by the authorized plan.
if ([bool]$plan.ssh.installServer) {
    $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' |
        Select-Object -First 1
    if (-not $capability) {
        throw 'OpenSSH Server capability is unavailable.'
    }
    if ($capability.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name $capability.Name | Out-Null
    }
}
if ([bool]$plan.ssh.startService) {
    Set-Service -Name sshd -StartupType Automatic
    if ((Get-Service -Name sshd).Status -ne 'Running') {
        Start-Service -Name sshd
    }
}
if ([bool]$plan.ssh.openFirewall -and
    -not (Get-NetFirewallRule -Name 'hardline-sshd' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'hardline-sshd' -DisplayName 'hardline - OpenSSH' `
        -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow `
        -Profile Private | Out-Null
}

if (-not (Test-Path $keyFile)) {
    New-Item -ItemType File -Path $keyFile -Force | Out-Null
}
if (-not (Select-String -Path $keyFile -SimpleMatch $publicKey -Quiet `
    -ErrorAction SilentlyContinue)) {
    Add-Content -Path $keyFile -Value $publicKey -Encoding ascii
}
icacls $keyFile /inheritance:r /grant '*S-1-5-32-544:F' `
    /grant '*S-1-5-18:F' | Out-Null

if (-not (Get-NetIPAddress -InterfaceAlias $alias -IPAddress $target `
    -ErrorAction SilentlyContinue)) {
    New-NetIPAddress -InterfaceAlias $alias -IPAddress $target `
        -PrefixLength $prefix | Out-Null
}
Set-NetConnectionProfile -InterfaceAlias $alias `
    -NetworkCategory ([string]$plan.directLink.networkCategory) `
    -ErrorAction Stop

if (-not (Test-Path $hostKeyPath)) {
    throw 'The OpenSSH host key was not created.'
}
$hostPublicKey = (Get-Content -Path $hostKeyPath -Raw).Trim()
$hostKeyParts = $hostPublicKey -split '\s+'
$fingerprintOutput = & ssh-keygen.exe -l -E sha256 -f $hostKeyPath
if ($LASTEXITCODE -ne 0 -or $fingerprintOutput -notmatch '(SHA256:[^\s]+)') {
    throw 'The OpenSSH host key fingerprint could not be read.'
}
$completion = Invoke-HardlinePost '/phase-two' ([pscustomobject]@{
    clientNonce = $nonce
    hostKey = [pscustomobject]@{
        algorithm = [string]$hostKeyParts[0]
        fingerprint = [string]$Matches[1]
        publicKey = "$($hostKeyParts[0]) $($hostKeyParts[1])"
    }
})
if ($completion.kind -ne 'ssh-authorized') {
    throw 'Bootstrap rendezvous did not authorize SSH completion.'
}

Write-Host ''
Write-Host 'Bootstrap complete. Return to the Mac.' -ForegroundColor Green
Write-Host ''
