# Étendre Hardline au Wi-Fi — rapport d'analyse

Status: ready-for-human

## Ce qui est réellement câblé à l'Ethernet

La couche d'observation n'est PAS le problème : elle modélise déjà le Wi-Fi.

- src/target-resolution/network.ts définit NetworkTransport avec "wifi".
- src/target-resolution/mac-observations.ts:transportFor() classe déjà Wi-Fi / AirPort.
- src/assets/bootstrap.ps1:40-44 classe déjà 802.11|Wireless en wifi.
- src/lib/bootstrap-server.ts:352 accepte déjà wifi dans le payload validé.

Le verrou est en trois points seulement :

1. **La sélection.** selectPhysicalEthernetCandidate() (network.ts) exclut
   transport !== "ethernet", mais aussi inUse et hasDefaultRoute. Ces deux
   dernières exclusions sont plus bloquantes que la première : une carte Wi-Fi
   normale porte une adresse DHCP et la route par défaut. Elle est exclue trois fois.
2. **L'adressage.** Tout le modèle suppose un /30 alloué puis **imposé** aux deux
   bouts : allocatePrivate30(), steps/network-mac.ts (networksetup -setmanualip sur
   le service entier), steps/network-windows.ts (New-NetIPAddress + -Dhcp Disabled
   + NetworkCategory Private).
3. **Le schéma.** TargetProfile.mac.ethernet / .windows.ethernet sont des clés
   validées strictement (target-profile.ts:189-200), relues par link-recovery.ts
   (69 occurrences), bootstrap-workflow.ts, project-config.ts.

## Le vrai choix : il y a deux « Wi-Fi », pas un

### A. Wi-Fi infrastructure (les deux machines sur le même réseau)

Le cas que 95 % des gens ont en tête. Le PC et le Mac sont sur la box. Il n'y a plus
de Direct Link : pas de /30 à allouer, rien à muter, l'adressage appartient au DHCP
de la box. Hardline devient **observateur** du lien au lieu d'en être le propriétaire.

Conséquence heureuse : c'est le mode le moins cher à implémenter, parce qu'il consiste
surtout à **sauter** des étapes, pas à en ajouter.

### B. Wi-Fi point-à-point (SoftAP / Wi-Fi Direct)

Le PC monte un Mobile Hotspot, le Mac s'y associe. Le modèle Direct Link survit intact
(lien dédié, isolé, /30). Mais :

- le Mac perd son Internet Wi-Fi en s'associant au hotspot (radio unique) ;
- le Mobile Hotspot Windows n'a pas d'API PowerShell, il faut passer par WinRT
  (NetworkOperatorTetheringManager) ; netsh wlan start hostednetwork est mort sur
  les pilotes récents ;
- la réversibilité devient bien plus dure à garantir que sur un câble ;
- le débit d'un SoftAP 5 GHz est très en dessous du gigabit : pour du streaming c'est
  souvent pire que la box.

**Recommandation : implémenter A, ne pas implémenter B.** B coûte 3 à 4 fois plus cher
et donne un lien moins bon que celui qu'il remplace.

## Forme proposée : un linkKind dans le profil

Une seule notion nouvelle dans le domaine, à ajouter à CONTEXT.md :

> **Link Kind** : la nature du chemin par lequel Hardline opère le PC. direct = câble
> dédié dont Hardline possède l'adressage. shared = réseau existant que Hardline
> observe sans jamais le muter.

Dans TargetProfile : linkKind: "direct" | "shared" (absent = direct, donc les profils
existants restent valides sans migration de schéma).

**Ne pas renommer mac.ethernet en mac.link.** 143 lignes dans 13 fichiers, zéro
comportement gagné, et une migration de profil à écrire. Ajouter un champ
transport: "ethernet" | "wifi" à l'intérieur du bloc existant suffit.

## Ce qui change, couche par couche

| Couche | Fichier | Changement |
|---|---|---|
| Sélection | network.ts | selectPhysicalEthernetCandidate(obs, {transports, requireIdle}). En shared, inUse / default-route ne sont plus des exclusions mais des prérequis. |
| Allocation | bootstrap-target.ts | En shared, pas de allocatePrivate30() : le lien est lu depuis les adresses déjà observées des deux côtés. |
| Plan d'amorçage | bootstrap-protocol.ts, bootstrap.ps1 | plan.directLink devient nullable. Le PS1 saute New-NetIPAddress, -Dhcp Disabled et le flip NetworkCategory. |
| Pare-feu | bootstrap.ps1 | **Point dur.** La règle sshd est aujourd'hui portée par le profil Private obtenu en forçant la catégorie. Sur un réseau domestique classé Public, SSH est fermé — et reclasser la box en Private mute un réglage qui n'appartient pas à Hardline. Il faut une règle -Profile Any scopée par -RemoteAddress sur l'adresse du Mac. |
| Mutation Mac | steps/network-mac.ts | Étape entièrement sautée en shared. Rien à restaurer : c'est le gain de réversibilité du mode. |
| Mutation PC | steps/network-windows.ts | Idem. Toute la mécanique de queue détachée (la partie la plus subtile du repo) devient sans objet en shared. |
| Projection | project-config.ts | subnetMask /30 codé en dur ; sourceAddress + bindInterface forcent le SSH sur le lien. À rendre conditionnels. |
| Link Recovery | link-recovery.ts | La migration /30 (≈ 400 lignes) ne s'applique pas. Ce qu'il faut en shared existe déjà : recoveryChannel.observeRecovery() retrouve le PC par hostAliases et valide machineId + MAC. En shared, ce chemin devient le chemin normal, et « recovered » = le bail DHCP a changé, on réécrit le profil. |
| Préflight | preflight.ts:184 | « Check the cable » n'a plus de sens. |
| Réveil | wol.ts, commands/up.ts | Wake-on-LAN ne traverse pas le Wi-Fi (WoWLAN quasi jamais actif sur PC fixe). L'étape windows-fast-startup perd sa raison d'être en shared. |
| Débit | throughput.ts, apollo-conf.ts | max_bitrate: "0" (illimité) est un réglage de gigabit dédié. Sur un Wi-Fi partagé il faut au minimum le rendre configurable, sinon Apollo saturera le lien. |

## Ce qu'on perd, et qu'il faut dire à l'utilisateur

1. **Le modèle de menace change.** Aujourd'hui le trafic ne quitte jamais un câble
   entre deux machines. En shared, SMB et l'interface web Apollo (47990) deviennent
   joignables par tout le LAN. Le SSH reste sûr (clé d'hôte épinglée), pas le reste.
2. **Le réveil du PC disparaît.**
3. **L'adressage dérive** au gré des baux DHCP : Link Recovery passe d'exception à
   régime normal.
4. **La latence et la gigue** ne sont plus bornées, ce qui est précisément la raison
   d'être du projet. Le mode shared est une commodité, pas un équivalent.

## Plan minimal, dans l'ordre

1. linkKind dans TargetProfile + validateur, défaut direct. Aucun comportement.
2. Paramétrer selectPhysicalEthernetCandidate. Tests purs, aucune machine requise.
3. plan.directLink nullable + branche pare-feu -RemoteAddress dans le PS1.
4. Court-circuiter network-mac / network-windows en shared.
5. Router Link Recovery vers le chemin recoveryChannel en shared.
6. Préflight, up sans WoL, bitrate, README.

Les étapes 1-2 sont testables entièrement hors machine avec l'outillage existant
(test/target-resolution/network.test.ts). L'étape 3 est la seule qui demande un vrai
PC — et c'est elle qui porte le seul risque de sécurité du lot.

## Ce qui est volontairement écarté

- Le renommage ethernet vers link : gros diff, zéro comportement.
- Le SoftAP / Wi-Fi Direct (variante B) : à rouvrir seulement si quelqu'un veut
  vraiment un lien dédié sans câble, en sachant qu'il sera plus lent que la box.
- L'auto-détection du mode : demander à l'amorçage, ne pas deviner.

## Ce qui a été implémenté

Le plan ci-dessus a été suivi, avec deux écarts assumés.

**Écart 1 : la sélection est un repli automatique, pas un mode à choisir.** Hardline
tente d'abord le lien dédié. Si l'un des deux bouts n'a aucun adaptateur libre, il
cherche un réseau où les deux machines portent déjà une adresse, et ne demande que
lorsqu'il en trouve plusieurs. L'auto-détection écartée dans le plan était celle du
mode ; ici c'est le chemin lui-même qui est constaté, pas deviné.

**Écart 2 : le débit.** `max_bitrate: "0"` reste côté Apollo, mais Moonlight demandait
500 Mbit/s en dur, un chiffre de gigabit dédié. Le client demande maintenant 80 Mbit/s
sur un lien partagé, et `hardline up --bitrate` corrige dans les deux sens.

| Ce qui change | Où |
|---|---|
| `linkKind` et `DirectLink.prefixLength` | `src/target-resolution/types.ts`, validés dans `target-profile.ts` |
| Sélection paramétrable et appariement par sous-réseau | `src/target-resolution/network.ts` |
| Repli, plan de mutation, question posée | `src/target-resolution/bootstrap-target.ts` |
| Adresse, catégorie et pare-feu conditionnels | `src/assets/bootstrap.ps1` |
| Récupération sans mutation | `src/target-resolution/shared-link.ts` |
| Étapes d'adressage absentes en mode partagé | `src/steps/index.ts` (`linkSteps`) |
| Question unique, deux formes | `src/cli.ts` |

Le renommage `ethernet` vers `link` reste écarté, et le SoftAP n'est pas implémenté.

Limite connue, non traitée : un câble branché des deux côtés mais qui ne relie pas
les deux machines (chacun sur un switch différent) fait toujours choisir le lien
dédié, qui ne s'établira pas. Le préflight le dit — « PC unreachable » — mais hardline
ne retombe pas sur le réseau partagé tout seul. Le corriger demande de rejouer
l'amorçage avec un autre plan, ce qui est une autre histoire.

## Deuxième passe : test de bout en bout sur les vraies machines

Le premier jet marchait sur une installation neuve. Sur une machine déjà installée au
câble, il ne marchait pas du tout — et c'est l'essai réel qui l'a montré.

**Ce qui bloquait.** Le profil nomme un adaptateur ; quand ce dongle est débranché,
`observeMacLink` levait une erreur anonyme et toutes les commandes tombaient avec
« The persisted Mac Ethernet adapter is unavailable ». install, uninstall, up et doctor
passent par la même résolution de cible : aucune n'était utilisable, et rien ne
permettait de basculer une installation câble vers le Wi-Fi.

**Le correctif.** Un adaptateur est une localisation, pas une identité — exactement ce
que le projet dit déjà d'une adresse IP. Ce qui lie la paire, ce sont les deux
identifiants machine. Quand l'adaptateur nommé disparaît, hardline joint le PC sous ses
noms connus, vérifie que c'est bien lui, et adopte un réseau que les deux machines
partagent déjà. L'adoption est restreinte aux liens partagés, et la restriction EST
l'argument : adopter un lien partagé n'exige aucune écriture. Construire un lien dédié
demanderait d'adresser le PC par le canal de secours, qui est en lecture seule.

**Dette refermée au passage.** `network-mac` et `network-windows` restauraient contre
l'interface de la configuration courante. Après un ré-appariement, c'en est une autre :
la désinstallation aurait rendu le DHCP au mauvais service. L'interface relevée fait
désormais partie de l'état, comme le relevé d'amorçage le fait depuis toujours, et
`stampLinkOwnership` inscrit l'ancienne dans les manifestes écrits avant ce champ.

**Wake-on-LAN.** Il ne traverse pas la radio : une carte Wi-Fi éteinte n'est plus
alimentée. Aucun code ne corrige cela. Le profil retient donc si le PC est relié par
radio, et `up` le dit tout de suite au lieu d'attendre trois minutes. Quand le PC est
câblé au même réseau, le réveil fonctionne, et l'appariement préfère déjà ce chemin.

**Mesures réelles**, MacBook en Wi-Fi et PC en Wi-Fi 6E sur la même box :

| Observation | Valeur |
|---|---|
| Sélection | `shared`, 192.168.1.0/24, aucune question posée |
| Préflight | 6 contrôles sur 6 au vert |
| Étapes | 10 conformes, les 3 d'adressage absentes |
| Latence | 4,65 ms moyenne, 0,62 ms de gigue, 0 % de perte |
| Débit | 357,7 Mbit/s |
| Session | Moonlight ouvert, `--bitrate 80000` |

**Reste non exécuté sur matériel réel :** l'amorçage en mode partagé (adresse nulle,
catégorie nulle, règle de pare-feu bornée au sous-réseau). Le basculer demanderait de
remplacer une installation câble qui fonctionne, ce qui appartient à l'opérateur.

## Troisième passe : le câble et le réseau partagé ne s'excluent pas

Question de l'opérateur, et elle était juste : pourquoi « une installation câble » et
« une installation Wi-Fi » ? Ce ne sont pas deux installations. Apollo, Moonlight,
l'appairage et les partages sont identiques ; seul le CHEMIN diffère. Ce qui était figé,
c'est le chemin — et il ne devait pas l'être.

**Ce qui manquait.** Après un ré-appariement vers le Wi-Fi, rebrancher le câble ne
changeait rien : la récupération de lien constatait que l'adaptateur Wi-Fi répondait,
répondait « validated », et hardline restait sur la radio indéfiniment.

**Le constat qui rend le correctif trivial.** Débrancher un câble n'efface rien. Le Mac
garde `10.0.0.2/30` sur le service AX88179A, le PC garde `10.0.0.1/30` sur son Ethernet
— les deux vérifiés sur les vraies machines. Le lien dédié est intégralement configuré
des deux côtés ; il dort. Y revenir ne demande donc AUCUNE écriture, seulement de le
remarquer.

**Lien en sommeil.** Le profil retient le lien dédié qu'il n'emprunte pas. L'asymétrie
avec le lien partagé est voulue et dit quelque chose de vrai : un lien partagé se
retrouve par simple observation, puisque les deux machines y portent déjà leurs
adresses ; un lien dédié, non — son adressage, hardline l'a écrit, et personne d'autre
ne sait le décrire.

**Détection automatique, dans un seul sens.** Chaque commande commence par chercher le
lien en sommeil. La sonde est d'abord locale : sans adaptateur branché, rien n'est
demandé au réseau et le cas courant ne coûte rien. Adaptateur présent et qui répond,
hardline reprend le câble et oublie ce qui dormait. Présent mais muet, ou remplacé par
un autre matériel, le lien partagé reste en place et rien n'est écrit.

Le sens unique est délibéré : hardline revient au câble parce que c'est le lien qu'il
existe pour offrir, et il ne le quitte que lorsqu'il a disparu.

**Choix explicite : volontairement pas fait.** Un drapeau `--link direct|shared` ne sert
qu'à forcer la radio alors que le câble répond, ce qui est un cas de test, pas un cas
d'usage. À ajouter le jour où quelqu'un le demande pour de bon.

## Quatrième passe : le choix explicite

`--link auto|direct|shared`, global, accepté avant comme après la sous-commande.

La valeur du drapeau est le REFUS, pas la sélection : `auto` fait déjà le bon choix.
Demander le lien dédié et recevoir le réseau de la maison sans le savoir est
exactement la surprise que le drapeau supprime, donc `--link direct` ne retombe jamais.
Il échoue en disant lequel des trois cas s'applique, parce que chacun appelle un geste
différent :

| Cas | Message |
|---|---|
| Aucun lien dédié connu | établir un lien avec le câble et `hardline install` |
| Adaptateur non branché | le nom du service à brancher |
| Branché mais muet | l'adresse à laquelle le PC ne répond pas |

`--link shared` quitte délibérément un câble qui marche ; le lien dédié part en sommeil
et une exécution sans drapeau le reprendra.

Vérifié en live, dongle débranché : `--link direct` échoue avec « The dedicated link
runs over AX88179A, which is not connected », le profil reste intact, et rien n'est
écrit — aussi bien depuis un profil câble que depuis un profil déjà basculé en partagé.

## Cinquième passe : désinstallation réelle, et ce qu'elle a révélé

`hardline uninstall --yes` exécuté de bout en bout sur les vraies machines, par le lien
Wi-Fi. Les six étapes du manifeste ont été défaites dans l'ordre inverse, la
désinstallation a annoncé ce qui resterait, et l'état local a été supprimé.

**Un défaut corrigé juste avant, et il aurait été irréparable.** `bootstrap-windows`
prenait l'interface dans le relevé — le relevé fait autorité, c'est la règle du projet —
mais l'ADRESSE dans la configuration courante. Après un ré-appariement, la configuration
nomme le réseau partagé : la queue aurait exécuté
`Remove-NetIPAddress -InterfaceAlias 'Ethernet' -IPAddress '192.168.1.48'`, sans effet,
et laissé `10.0.0.1` orpheline sur un PC devenu injoignable. L'adresse vient désormais
du relevé, comme l'interface.

**Ce que la désinstallation a observé :** fast-startup, appairage, configuration Apollo
et Moonlight rendus ; Apollo désinstallé (port 47990 fermé, vérifié) ; l'étape Apollo a
cédé en nommant ce qu'elle ne savait pas rendre.

**Ce qu'elle n'a pas pu observer, et le signal inquiétant :** la queue détachée. Voir
`issues/01-queue-detachee.md`. Cinquante secondes après son lancement, le port 22 du PC
répondait encore, alors que la charge dort deux secondes avant d'arrêter `sshd`. Le
mécanisme est antérieur à ce travail et sert aussi à l'étape d'adressage ; s'il ne
survit pas à la fermeture de la session SSH, aucun de ses deux usages n'aboutit.

C'est une limite du projet mise au jour par le premier uninstall réellement exécuté,
pas une régression introduite ici.
