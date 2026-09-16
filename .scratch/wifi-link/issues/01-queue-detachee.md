# La queue détachée ne survit pas à la fermeture de la session SSH

Status: needs-triage

## Ce qui a été observé

Premier `hardline uninstall` exécuté de bout en bout contre de vraies machines
(Mac en Wi-Fi, PC Windows 11 26200, OpenSSH Server de la fonctionnalité Windows).

La restauration s'est déroulée normalement jusqu'à l'étape d'amorçage, qui a rapporté
`detached` comme prévu. Cinquante secondes plus tard, le port 22 du PC répondait encore.

```
$ nc -z 192.168.1.48 22
Connection to 192.168.1.48 port 22 succeeded!
```

Or la charge détachée dort deux secondes puis exécute, dans l'ordre : restitution de
l'adressage, retrait de l'adresse posée, retrait de la clé, retrait de la règle de
pare-feu, `Set-Service sshd -StartupType Disabled`, `Stop-Service sshd -Force`, puis
suppression du relevé immuable. Si elle avait abouti, le port serait fermé.

## Ce que cela implique

`Start-Process` a bien été invoqué : `runRemoteChecked` a vérifié le code de retour du
script porteur, et l'étape a rendu `detached`. Le processus a donc été lancé, puis
n'a pas fait son travail. L'hypothèse la plus probable est que Windows OpenSSH place
les processus de la session dans un objet Job, et que la fermeture de la session tue
le processus détaché avant la fin de sa temporisation.

Si elle se confirme, le mécanisme ne remplit sa fonction dans AUCUN de ses deux usages,
et les conséquences sont sérieuses :

- le relevé immuable reste sur le PC, ce qui fait refuser tout nouvel amorçage portant
  un plan différent — exactement le cas d'une réinstallation après désinstallation ;
- la clé publique du Mac, la règle de pare-feu et l'adresse du lien restent en place
  alors que la désinstallation les déclare rendus ;
- `sshd` reste démarré et automatique sur une machine qui ne l'avait pas avant.

La désinstallation le dit déjà honnêtement — « Its completion is intentionally
unobservable » — mais elle le dit d'un mécanisme dont on a maintenant une raison de
penser qu'il n'aboutit pas.

## Ce qui reste à établir

L'observation ci-dessus est indirecte : le port ouvert est le seul signal disponible,
puisque la désinstallation supprime l'identité locale avant qu'on puisse sonder le
reste. Il faut confirmer au clavier du PC, avec un accès Administrateur :

```powershell
Test-Path (Join-Path $env:ProgramData 'hardline\bootstrap-state.json')
Test-Path (Join-Path $env:ProgramData 'ssh\administrators_authorized_keys')
[bool](Get-NetFirewallRule -Name hardline-sshd -ErrorAction SilentlyContinue)
(Get-Service sshd).Status
(Get-NetIPAddress -InterfaceAlias Ethernet -AddressFamily IPv4).IPAddress
```

Tout à `True` / `Running` / `10.0.0.1` présent confirme que la charge n'a pas tourné.

## Pistes, si confirmé

Aucune n'est évidente, et c'est pourquoi ceci est une fiche et non un correctif.

1. Détacher par une tâche planifiée à déclenchement immédiat plutôt que par
   `Start-Process` : une tâche appartient au planificateur, pas à la session.
2. `Start-Process` avec un job object explicite qui n'hérite pas de la session.
3. Renoncer au détachement pour l'uninstall et exiger un geste au clavier du PC, ce qui
   est honnête mais dégrade fortement l'expérience.

La piste 1 est la plus prometteuse : le projet sait déjà créer et supprimer une tâche
planifiée (`network-profile-task`).
