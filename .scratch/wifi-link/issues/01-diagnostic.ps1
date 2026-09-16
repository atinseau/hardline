# Diagnostic a coller dans un PowerShell Administrateur sur le PC.
# Lecture seule : il ne modifie rien.
$record = Join-Path $env:ProgramData 'hardline\bootstrap-state.json'
$keys   = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$svc    = Get-Service sshd -ErrorAction SilentlyContinue
Write-Host ("releve immuable   : " + (Test-Path $record))
Write-Host ("cle du Mac        : " + (Test-Path $keys))
Write-Host ("regle hardline    : " + [bool](Get-NetFirewallRule -Name hardline-sshd -ErrorAction SilentlyContinue))
Write-Host ("sshd              : " + $svc.Status + " / " + $svc.StartType)
Write-Host ("adresses Ethernet : " + ((Get-NetIPAddress -InterfaceAlias Ethernet -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress -join ', '))
