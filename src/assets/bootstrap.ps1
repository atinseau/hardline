#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Ce script est volontairement SANS ACCENTS : il s'affiche dans une console
# Windows en page de code OEM, ou les accents sont mutiles.

Write-Host ''
Write-Host 'hardline - amorcage du PC' -ForegroundColor Cyan
Write-Host ''

$alias = '@@INTERFACE_ALIAS@@'
$target = '@@WINDOWS_IP@@'
$prefix = @@PREFIX_LENGTH@@
$publicKey = '@@PUBLIC_KEY@@'
# Un compte administrateur n'utilise PAS ~/.ssh/authorized_keys mais ce fichier commun.
$keyFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$stateDir = Join-Path $env:ProgramData 'hardline'
$statePath = Join-Path $stateDir 'bootstrap-state.json'

# --- 0. Rien a faire sans interface --------------------------------------
# Ce controle passe AVANT la capture : sur une machine ou l'amorcage ne peut
# pas aboutir, mieux vaut ne rien ecrire du tout que d'y laisser un releve
# d'un etat qu'on n'a pas modifie.
$adapter = Get-NetAdapter -Name $alias -ErrorAction SilentlyContinue
if (-not $adapter) {
    Write-Host ''
    Write-Host "  ECHEC : aucune interface nommee '$alias'." -ForegroundColor Red
    Write-Host '  Verifier que le cable Ethernet est branche.' -ForegroundColor Red
    exit 1
}

# --- 1. Capture de l'etat d'origine --------------------------------------
# Ce que fait l'amorcage n'est PAS observable apres coup : quand hardline
# reussit enfin a ouvrir une session SSH, c'est justement parce que l'amorcage
# a deja tout change. Le seul releve honnete est celui-ci, ecrit avant la
# premiere modification.
#
# Chaque 'changed' est une PREVISION, pas un constat : l'amorcage est
# deterministe et sait deja, a cet instant, ce qu'il va modifier. Cela vaut
# mieux que de marquer les drapeaux apres coup, car une interruption entre une
# modification et son drapeau laisserait une modification que plus rien ne
# saurait defaire. Ici, le pire cas est l'inverse : un drapeau leve pour une
# modification qui n'a pas eu lieu, et toutes les instructions de restauration
# sont ecrites pour etre sans effet dans ce cas.
#
# Un releve deja present n'est JAMAIS reecrit : un second amorcage sur un PC
# deja amorce capturerait l'etat d'apres amorcage, et l'etat d'origine serait
# perdu pour toujours.
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }

if (Test-Path $statePath) {
    Write-Host '  etat d''origine deja releve, conserve tel quel'
} else {
    $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    $service = Get-Service -Name sshd -ErrorAction SilentlyContinue
    $rule = Get-NetFirewallRule -Name 'hardline-sshd' -ErrorAction SilentlyContinue

    $keyFileExisted = Test-Path $keyFile
    $keyPresent = $false
    $aclSddl = $null
    if ($keyFileExisted) {
        $keyPresent = [bool](Select-String -Path $keyFile -SimpleMatch $publicKey -Quiet -ErrorAction SilentlyContinue)
        $aclSddl = [string](Get-Acl -Path $keyFile).Sddl
    }

    $addresses = @(Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction SilentlyContinue)
    $netInterface = Get-NetIPInterface -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction SilentlyContinue
    $netProfile = Get-NetConnectionProfile -InterfaceAlias $alias -ErrorAction SilentlyContinue
    $category = if ($netProfile) { [string]$netProfile.NetworkCategory } else { $null }
    $hasTarget = [bool](@($addresses | Where-Object { $_.IPAddress -eq $target }).Count)

    $state = [pscustomobject]@{
        version        = 1
        capturedAt     = (Get-Date).ToString('s')
        interfaceAlias = $alias
        capability     = [pscustomobject]@{
            name    = if ($capability) { [string]$capability.Name } else { $null }
            state   = if ($capability) { [string]$capability.State } else { $null }
            changed = [bool]($capability -and $capability.State -ne 'Installed')
        }
        sshd           = [pscustomobject]@{
            present        = [bool]$service
            startupType    = if ($service) { [string]$service.StartType } else { $null }
            status         = if ($service) { [string]$service.Status } else { $null }
            startupChanged = if ($service) { [bool]($service.StartType -ne 'Automatic') } else { $true }
            statusChanged  = if ($service) { [bool]($service.Status -ne 'Running') } else { $true }
        }
        firewall       = [pscustomobject]@{
            name    = 'hardline-sshd'
            existed = [bool]$rule
            changed = [bool](-not $rule)
        }
        authorizedKeys = [pscustomobject]@{
            path        = [string]$keyFile
            publicKey   = $publicKey
            fileExisted = [bool]$keyFileExisted
            keyPresent  = [bool]$keyPresent
            aclSddl     = $aclSddl
            changed     = [bool](-not $keyPresent)
            aclChanged  = [bool]$keyFileExisted
        }
        network        = [pscustomobject]@{
            addresses         = @($addresses | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
            manualAddresses   = @($addresses | Where-Object { $_.PrefixOrigin -eq 'Manual' } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
            dhcp              = if ($netInterface) { [string]$netInterface.Dhcp } else { $null }
            category          = $category
            addressingChanged = [bool](-not $hasTarget)
            categoryChanged   = [bool]($category -ne 'Private')
        }
    }

    # Ecriture a cote puis renommage : un releve tronque par une coupure de
    # courant serait pire que pas de releve du tout, puisqu'il empecherait
    # l'amorcage suivant d'en ecrire un valide.
    $tmp = "$statePath.tmp"
    $state | ConvertTo-Json -Depth 6 | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Path $tmp -Destination $statePath -Force
    Write-Host '  etat d''origine releve'
}

# --- 1bis. Ce que l'amorcage s'autorise a retirer ------------------------
# Le menage d'adresses de la section 5 ne s'autorise QUE les adresses que le
# releve d'origine connait deja.
#
# Le releve n'est jamais reecrit, par conception. Un second amorcage d'un PC
# deja amorce trouve donc un releve qui decrit le PC d'AVANT le premier, et un
# menage inconditionnel emporterait toute adresse posee depuis : une adresse
# qui ne figure alors dans aucun releve, et dont plus rien ne sait qu'elle a
# existe. C'est une perte de donnees silencieuse, pas une imperfection.
#
# On choisit donc de refuser de retirer ce dont on ne peut pas rendre compte :
# une adresse de trop sur l'interface est un desagrement, une adresse detruite
# sans trace est irreversible. Un releve illisible ou d'une forme inconnue
# donne une liste vide, donc aucun retrait : le meme choix, pousse a son terme.
$known = @()
try {
    $recorded = Get-Content -Path $statePath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($recorded.network.addresses) {
        $known = @($recorded.network.addresses | ForEach-Object { ($_ -split '/')[0] })
    }
} catch {
    Write-Host '  releve illisible : aucune adresse ne sera retiree'
}

# --- 2. OpenSSH Server ---------------------------------------------------
$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($capability.State -ne 'Installed') {
    Write-Host '  installation d''OpenSSH Server...'
    Add-WindowsCapability -Online -Name $capability.Name | Out-Null
} else {
    Write-Host '  OpenSSH Server deja installe'
}

Set-Service -Name sshd -StartupType Automatic
if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd }
Write-Host '  service sshd demarre'

# --- 3. Pare-feu ---------------------------------------------------------
if (-not (Get-NetFirewallRule -Name 'hardline-sshd' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'hardline-sshd' -DisplayName 'hardline - OpenSSH' `
        -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Private | Out-Null
}
Write-Host '  regle de pare-feu SSH en place'

# --- 4. Cle publique du Mac ----------------------------------------------
if (-not (Test-Path $keyFile)) { New-Item -ItemType File -Path $keyFile -Force | Out-Null }
if (-not (Select-String -Path $keyFile -SimpleMatch $publicKey -Quiet -ErrorAction SilentlyContinue)) {
    # ASCII et non utf8 : PowerShell 5.1 ajoute une marque d'ordre des octets
    # en utf8, qui rend le fichier illisible pour OpenSSH, sans aucune erreur.
    Add-Content -Path $keyFile -Value $publicKey -Encoding ascii
    Write-Host '  cle publique ajoutee'
} else {
    Write-Host '  cle publique deja presente'
}

# Identifiants de securite plutot que noms de groupes : "Administrators" n'existe
# pas sur un Windows francais, ou le groupe se nomme "Administrateurs".
icacls $keyFile /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null

# --- 5. Adresse du lien direct -------------------------------------------
# L'adresse cible d'abord, le menage ensuite, comme dans network-windows.ts.
# L'ordre inverse laissait l'interface SANS AUCUNE adresse IPv4 des lors que
# New-NetIPAddress echouait, $ErrorActionPreference valant 'Stop'.
if (Get-NetIPAddress -InterfaceAlias $alias -IPAddress $target -ErrorAction SilentlyContinue) {
    Write-Host "  adresse $target deja posee"
} else {
    New-NetIPAddress -InterfaceAlias $alias -IPAddress $target -PrefixLength $prefix | Out-Null
    Write-Host "  adresse $target posee sur $alias"
}

Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne $target } |
    ForEach-Object {
        if ($known -contains $_.IPAddress) {
            $_ | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
        } else {
            Write-Host "  adresse $($_.IPAddress) conservee : absente du releve d'origine"
        }
    }

Set-NetConnectionProfile -InterfaceAlias $alias -NetworkCategory Private -ErrorAction SilentlyContinue
Write-Host '  profil reseau prive'

Write-Host ''
Write-Host 'Amorcage termine. Lancer maintenant "hardline install" sur le Mac.' -ForegroundColor Green
Write-Host ''
