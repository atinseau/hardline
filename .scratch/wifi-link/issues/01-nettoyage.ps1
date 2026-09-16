# Nettoyage a coller ENSUITE, seulement si le diagnostic montre des restes.
# Reprend exactement ce que la queue detachee aurait du faire.
Remove-NetIPAddress -InterfaceAlias 'Ethernet' -IPAddress '10.0.0.1' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $env:ProgramData 'ssh\administrators_authorized_keys') -Force -ErrorAction SilentlyContinue
Remove-NetFirewallRule -Name 'hardline-sshd' -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType Disabled -ErrorAction SilentlyContinue
Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $env:ProgramData 'hardline\bootstrap-state.json') -Force -ErrorAction SilentlyContinue
Write-Host 'Nettoyage termine. Le PC est rendu a son etat d avant hardline.'
