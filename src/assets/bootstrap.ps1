#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host ''
Write-Host 'hardline - amorcage du PC' -ForegroundColor Cyan
Write-Host ''

# --- 1. OpenSSH Server ---------------------------------------------------
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

# --- 2. Pare-feu ---------------------------------------------------------
if (-not (Get-NetFirewallRule -Name 'hardline-sshd' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'hardline-sshd' -DisplayName 'hardline - OpenSSH' `
        -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Private | Out-Null
}
Write-Host '  regle de pare-feu SSH en place'

# --- 3. Cle publique du Mac ----------------------------------------------
# Un compte administrateur n'utilise PAS ~/.ssh/authorized_keys mais ce fichier commun.
$keyFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$publicKey = '@@PUBLIC_KEY@@'

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

# --- 4. Adresse du lien direct -------------------------------------------
$alias = '@@INTERFACE_ALIAS@@'
$adapter = Get-NetAdapter -Name $alias -ErrorAction SilentlyContinue
if (-not $adapter) {
    Write-Host ''
    Write-Host "  ECHEC : aucune interface nommee '$alias'." -ForegroundColor Red
    Write-Host '  Verifier que le cable Ethernet est branche.' -ForegroundColor Red
    exit 1
}

$target = '@@WINDOWS_IP@@'
$prefix = @@PREFIX_LENGTH@@

if (-not (Get-NetIPAddress -InterfaceAlias $alias -IPAddress $target -ErrorAction SilentlyContinue)) {
    Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
    New-NetIPAddress -InterfaceAlias $alias -IPAddress $target -PrefixLength $prefix | Out-Null
    Write-Host "  adresse $target posee sur $alias"
} else {
    Write-Host "  adresse $target deja posee"
}

Set-NetConnectionProfile -InterfaceAlias $alias -NetworkCategory Private -ErrorAction SilentlyContinue
Write-Host '  profil reseau prive'

Write-Host ''
Write-Host 'Amorcage termine. Lancer maintenant "hardline install" sur le Mac.' -ForegroundColor Green
Write-Host ''
