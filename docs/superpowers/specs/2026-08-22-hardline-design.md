# hardline — Design

**Date** : 2026-08-22
**Statut** : design validé, en attente de plan d'implémentation

## 1. Problème

Un PC Windows de forte puissance et un MacBook Pro partagent un seul écran. Basculer
de l'un à l'autre impose de débrancher et rebrancher le HDMI. L'objectif est de
supprimer ce geste : le Mac devient le poste de travail unique, le PC Windows tourne
sans écran et s'affiche dans une fenêtre du Mac, à travers une liaison filaire dédiée.

## 2. Ce qui a été écarté, et pourquoi

**Le transport vidéo par USB-C est impossible.** Le DisplayPort Alt Mode est
unidirectionnel, de la source vers l'écran. Un Mac est toujours source ; il ne peut
pas recevoir un signal vidéo. Le Target Display Mode a disparu avec les iMac de 2014.
Aucune couche logicielle ne contourne cette limite : il faudrait une carte de capture.

**Le Thunderbolt point-à-point est hors de portée et sans intérêt.** Le PC n'expose
aucun contrôleur Thunderbolt ou USB4 — un seul contrôleur USB sur le bus PCI,
`8086:7A60`, le xHCI du chipset Z790. Une carte ThunderboltEX 4 sur le connecteur
THB_C resterait possible, mais l'interopérabilité entre le Thunderbolt Bridge d'un Mac
Apple Silicon et le Thunderbolt Networking de Windows n'est pas garantie. Surtout,
elle ne servirait à rien : voir les mesures.

**Le débit n'a jamais été le facteur limitant.** Sunshine consomme 150 à 500 Mbit/s en
4K120 quasi sans perte. Le lien Ethernet mesuré en fournit 947.

## 3. Matériel de référence

Le projet cible ces deux machines exactement. Toute divergence doit provoquer un arrêt
explicite, jamais une tentative d'adaptation.

**Mac** — MacBook Pro `Mac15,11`, Apple M3 Max, 36 Go. Trois ports Thunderbolt 4.
Adaptateur réseau ASIX AX88179A en USB, plafonné à `1000baseT`, MTU limitée à la plage
1280–1500 : les jumbo frames sont impossibles sur ce matériel.

**PC** — ASUS ROG STRIX Z790-H GAMING WIFI, Intel Core i9-14900K, NVIDIA RTX 4090,
Windows 11 Professionnel build 26200. Carte réseau Intel I225-V, capable de 2,5 Gbit/s
mais négociée à 1 Gbit/s faute de partenaire à cette vitesse. Pilote d'écran virtuel
SudoMaker déjà présent : `oem52.inf`, version 1.10.9.289, actif. Réveil par le réseau
et partage SMB déjà activés.

## 4. Mesures de référence

Relevées le 2026-08-22 sur le lien direct, à comparer au Wi-Fi utilisé jusque-là.

| Chemin | Latence moyenne | Gigue | Perte | Débit |
|---|---|---|---|---|
| Ethernet direct | 1,04 ms | 0,21 ms | 0 % sur 200 paquets | 947 Mbit/s |
| Wi-Fi | 5,32 ms | 0,48 ms | 0 % | 540 Mbit/s |

Le débit est mesuré par `iperf3` en TCP, du PC vers le Mac, soit le sens du flux vidéo.
947 Mbit/s constitue le plafond théorique d'un lien Gigabit : aucune optimisation
logicielle ne peut l'améliorer, et les jumbo frames sont exclues par l'adaptateur.
Le plancher de latence, environ 1 ms, tient au polling USB de l'adaptateur ; il est
sans conséquence face aux 8,3 ms que dure une trame à 120 images par seconde.

## 5. Décisions

| Décision | Choix retenu |
|---|---|
| Portée | Les deux machines ci-dessus, scripts rejouables |
| Périmètre v1 | Vidéo, audio, entrées, headless au démarrage, presse-papier, accès fichiers, lancement en un geste |
| Écran de connexion | Sunshine capture la session de login ; aucun secret stocké |
| Topologie d'installation | Amorce minimale sur Windows, puis orchestration depuis le Mac par SSH |
| Contrainte transverse | Moonlight ne doit jamais être visible ni configuré à la main |

## 6. Architecture

Le Mac est le dépôt de vérité. Tout le code y vit, y compris ce qui s'exécute sur
Windows, poussé par SSH au moment de son exécution. Le PC reçoit un état, il n'en
décide aucun. Cette asymétrie est ce qui rend l'idempotence et la désinstallation
tenables : une seule base de code à raisonner.

Quatre couches, installées dans cet ordre et retirées dans l'ordre inverse.

**Transport.** Adresses fixes sur le lien direct, `10.10.10.1` côté PC et `10.10.10.2`
côté Mac, masque `/24`, **sans passerelle** — c'est ce qui garantit que macOS ne
détournera jamais sa route par défaut vers ce lien. Profil réseau privé côté Windows,
pare-feu ouvert sur ce seul sous-réseau. L'adressage link-local automatique est
abandonné dès l'installation : une adresse qui change au redémarrage est incompatible
avec l'exigence de persistance.

**Rendu.** Pilote d'écran virtuel côté Windows, réglé sur la résolution et la
fréquence de l'écran effectivement utilisé sur le Mac, détectées à l'installation et
non codées en dur. Service Sunshine autorisé à capturer le bureau sécurisé.

**Session.** Appairage Sunshine/Moonlight piloté par l'API REST de Sunshine plutôt que
par la saisie manuelle d'un code. C'est le mécanisme qui rend Moonlight invisible.

**Confort.** Montage SMB automatique du disque du PC sur le Mac, et lanceur en un
geste. Le presse-papier ne fait l'objet d'aucun composant : Moonlight synchronise
nativement le texte entre les deux machines. Aucun agent tiers ne sera installé pour
cela en v1 ; si la synchronisation du texte s'avère insuffisante à l'usage, ce sera
une décision ultérieure, pas une dette de conception.

## 7. Flux d'installation sur un PC neuf

1. Brancher le câble Ethernet entre les deux machines.
2. Sur le PC, dans un PowerShell administrateur, une seule ligne :
   `irm http://<nom-du-mac>.local:8080/bootstrap.ps1 | iex`
   Elle installe OpenSSH, dépose la clé publique du Mac dans
   `administrators_authorized_keys`, ouvre le port 22 et fixe l'adresse du lien direct.
   Le nom mDNS du Mac est résolu nativement par Windows 11, par Wi-Fi comme par
   Ethernet : aucune adresse à retenir.
3. Sur le Mac, `hardline install`. Tout le reste passe par SSH.

Le serveur HTTP de l'étape 2 est éphémère : il n'est actif que pendant la phase
d'amorçage et s'arrête ensuite.

## 8. Idempotence

Aucune étape ne dit « installe » ; toutes disent « converge ». Chaque étape constate
l'état réel, n'agit que sur l'écart constaté, puis revérifie. Sunshine déjà présent,
adresse déjà correcte, appairage déjà valide : l'étape passe sans rien faire.
`hardline install` rejoué dix fois de suite produit le même état, sans effet de bord.

## 9. Manifeste d'état et désinstallation

Un manifeste JSON, écrit côté Mac au fil de l'installation, enregistre deux choses
pour chaque élément touché : ce que hardline a posé, et **l'état antérieur qu'il a
remplacé**. Sont notamment capturés le profil réseau du lien Windows avant bascule en
privé, la configuration d'origine de l'adaptateur du Mac, et les règles de pare-feu
préexistantes.

`hardline uninstall` lit ce manifeste et défait dans l'ordre inverse, en restaurant
l'état antérieur plutôt qu'en supposant des valeurs par défaut. Un désinstalleur qui
devine est un désinstalleur qui casse la machine.

**L'ordre d'écriture est une contrainte de sûreté, pas un détail.** L'état antérieur
d'une étape est écrit sur disque *avant* que l'étape ne modifie quoi que ce soit,
jamais après. La raison est concrète : la bibliothèque d'affichage intercepte Ctrl+C
pendant un indicateur d'activité et termine le processus immédiatement et de façon
synchrone, sans laisser s'exécuter le moindre traitement de rattrapage asynchrone. Une
interruption au clavier au mauvais moment tuerait donc le programme entre la
modification et son enregistrement, laissant une machine modifiée dont plus rien ne
connaît l'état d'origine. En écrivant d'abord, le pire cas devient une étape
enregistrée mais non appliquée — situation que `install` corrige de lui-même au
prochain passage, puisque chaque étape constate avant d'agir.

## 10. Persistance au redémarrage

Survivent nativement : les adresses fixes, le service Sunshine, le pilote d'écran, les
règles de pare-feu, et l'appairage Moonlight.

Deux points exigent une attention explicite.

Côté Mac, la configuration réseau doit passer par `networksetup`, seul persistant.
`ifconfig`, utilisé pendant la phase de mesure, s'évapore au redémarrage.

Côté Windows, **le profil réseau du lien repasse en public** au rebranchement du câble
ou après certaines mises à jour, ce qui referme silencieusement le pare-feu et donne
une panne incompréhensible. Une tâche planifiée au démarrage rétablit le profil privé
sur cette seule interface.

## 11. Préconditions et gestion d'erreurs

Vérifiées avant toute action, chacune bloquante avec un message explicite : PC
joignable sur le lien direct, session SSH fonctionnelle, Windows 11, GPU NVIDIA
présent, lien Ethernet actif des deux côtés, privilèges administrateur côté Windows.

Une précondition non satisfaite arrête l'installation avant toute modification. Aucun
état partiellement appliqué n'est laissé derrière.

## 12. Commandes

| Commande | Rôle |
|---|---|
| `hardline install` | Converge les deux machines vers l'état cible |
| `hardline uninstall` | Restaure l'état antérieur à partir du manifeste |
| `hardline up` | Geste quotidien : réveille le PC si besoin, attend le lien, ouvre la session en plein écran |
| `hardline doctor` | Diagnostic : lien, adresses, service, appairage, latence |

`doctor` mesure la latence avec `ping`, toujours disponible. Le débit n'est mesuré
que si `iperf3` est présent sur les deux machines ; son absence produit une ligne
« non mesuré » et non un échec. `iperf3` n'est pas une dépendance du projet.

## 13. Stack technique

Toute la logique est écrite en TypeScript et exécutée par **Bun 1.4.0**, déjà installé
sur le Mac. Le seul autre langage du projet est le PowerShell du script d'amorçage, qui
reste volontairement minimal : il installe OpenSSH, dépose la clé et fixe l'adresse,
rien de plus. Tout le reste de la logique Windows est piloté depuis TypeScript.

**Exécution locale — `Bun.$`.** Les commandes macOS (`networksetup`, `ifconfig`,
`ping`, `scp`) passent par le shell intégré de Bun, dont l'interpolation échappe
automatiquement les variables. Deux règles systématiques : `.quiet()` pour ne pas
polluer la sortie, et `.nothrow()` partout où un code de retour non nul est un
résultat à inspecter et non une exception — le cas de `ping` quand l'hôte est absent,
qui est une situation nominale pour `hardline doctor`. À noter, le shell de Bun n'est
pas `/bin/sh` : aucun bashisme n'est disponible, ce qui n'est pas gênant ici puisque
nous n'appelons que des binaires externes. Le `ping` de macOS exige toujours `-c N`,
faute de quoi il ne se termine jamais.

**Exécution distante — `Bun.spawn`, pas `Bun.$`.** C'est le point où j'ai changé d'avis
après lecture de la documentation. L'échappement automatique du shell de Bun entre en
collision avec les règles de guillemets de PowerShell à l'autre bout du tunnel SSH, et
produit un double échappement — exactement la classe de bug rencontrée plusieurs fois
pendant la phase d'exploration. Les commandes distantes sont donc construites comme un
tableau d'arguments, `["ssh", host, commandePowerShell]`, passé à `Bun.spawn`, où
aucune interprétation shell n'est appliquée.

**Serveur d'amorçage — `Bun.serve`.** Une route unique servant le `.ps1`, un arrêt
programmatique par `server.stop()` et une minuterie de sécurité. Le script PowerShell
est embarqué dans le binaire comme asset — `import ps1 from "./bootstrap.ps1" with
{ type: "file" }` — plutôt que posé à côté de l'exécutable, ce qui le rendrait
fragile.

**API Sunshine — `fetch` avec TLS relâché, isolé.** Sunshine présente un certificat
auto-signé. Bun accepte `tls: { rejectUnauthorized: false }` par requête. La variable
d'environnement `NODE_TLS_REJECT_UNAUTHORIZED` n'est pas fiable sous Bun et ne doit pas
être employée. Ce relâchement est confiné à un client dédié dans `sunshine-api.ts` et
n'atteint jamais un `fetch` générique.

**Manifeste — écriture atomique.** `Bun.write` n'est pas atomique : une interruption en
cours d'écriture corrompt le fichier. Le manifeste étant précisément ce dont dépend la
désinstallation, il est écrit dans un fichier temporaire puis déplacé par
`fs.rename()`, atomique sur un même volume.

**Interface en ligne de commande — `commander`.** Le `parseArgs` de `node:util`, que Bun
supporte nativement, convient à un CLI plat mais pas à des sous-commandes. `commander`
est la dépendance retenue ; c'est la seule du projet en dehors des types.

**Distribution — `bun build --compile`.** Un binaire autonome ciblant
`bun-darwin-arm64`, avec `--minify` et `--bytecode` pour le temps de démarrage. Le
binaire embarque le runtime Bun et pèsera plusieurs dizaines de mégaoctets : c'est le
prix d'un exécutable sans dépendance, acceptable pour un outil local. Le champ `bin`
du `package.json` est inutile puisque la distribution ne passe pas par npm.

## 14. Structure du dépôt

```
hardline/
├── src/
│   ├── cli.ts                    # point d'entrée, commander, dispatch
│   ├── commands/
│   │   ├── install.ts
│   │   ├── uninstall.ts
│   │   ├── up.ts
│   │   └── doctor.ts
│   ├── steps/                    # une étape convergente = un fichier
│   │   ├── network-mac.ts
│   │   ├── network-windows.ts
│   │   ├── sunshine.ts
│   │   ├── virtual-display.ts
│   │   ├── pairing.ts
│   │   ├── smb.ts
│   │   └── launcher.ts
│   ├── lib/
│   │   ├── shell.ts              # wrapper Bun.$ pour macOS
│   │   ├── ssh.ts                # wrapper Bun.spawn pour PowerShell distant
│   │   ├── bootstrap-server.ts   # Bun.serve éphémère
│   │   ├── sunshine-api.ts       # client fetch, TLS relâché confiné
│   │   ├── manifest.ts           # état JSON, écriture atomique
│   │   └── preflight.ts          # vérification des préconditions
│   └── assets/
│       └── bootstrap.ps1
├── test/
├── docs/superpowers/specs/
├── bunfig.toml
├── package.json                  # type: module
└── tsconfig.json                 # strict, moduleResolution bundler
```

Chaque fichier de `steps/` expose le même contrat : une fonction qui constate l'état,
une qui applique l'écart, une qui restaure l'état antérieur. C'est cette uniformité qui
rend l'idempotence et la désinstallation vérifiables plutôt qu'espérées.

## 15. Tests

`bun test`. La difficulté est que l'essentiel du code invoque des commandes système,
qu'on ne peut ni exécuter ni mocker globalement sans fragilité. La règle du projet est
donc que **rien dans `steps/` ou `commands/` n'appelle `Bun.$` ou `Bun.spawn`
directement** : tout passe par les fonctions de `lib/shell.ts` et `lib/ssh.ts`, qui
sont les seules frontières avec le système. Les tests substituent ces modules par
`mock.module`, ce qui permet de vérifier la logique de convergence — l'étape agit-elle
quand l'état diverge, se tait-elle quand il est déjà bon — sans toucher à une vraie
machine.

Trois niveaux : les fonctions de parsing des sorties système, testées sur des sorties
réelles capturées pendant l'exploration ; la logique de convergence de chaque étape,
avec un système simulé ; et un test de bout en bout manuel, `hardline doctor`, qui
reste le seul juge de l'état réel des deux machines.

## 16. Non-objectifs

Fonctionner sur un PC Windows quelconque ou un autre Mac. Être distribuable à des
tiers. Prendre en charge des GPU non NVIDIA. Remplacer un accès distant hors du réseau
local. Optimiser un débit déjà au plafond du matériel. Fournir un binaire pour une
autre plateforme que macOS arm64.
