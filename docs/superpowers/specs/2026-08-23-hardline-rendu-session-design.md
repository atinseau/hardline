# hardline — plan 2 : rendu et session

**Statut** : conception validée, prête pour le plan d'implémentation.
**Socle** : `docs/superpowers/specs/2026-08-22-hardline-design.md`, livré et fusionné.
Ce document ne réécrit pas le socle, il s'y adosse. Le contrat `Step`, le manifeste,
l'orchestrateur, la discipline SSH et l'invariant de réversibilité y sont définis et
restent en vigueur mot pour mot.

---

## 1. Ce que le plan 2 ajoute

Le socle a rendu les deux machines joignables : un câble, deux adresses fixes, une
liaison à 946 Mbit/s et 1 ms. On ne voit toujours rien. Le plan 2 met une image
dessus.

Le geste visé tient en un mot : `hardline up`, et le bureau Windows est là. Pas de
liste d'hôtes, pas de code à recopier, pas de fenêtre de réglages. La contrainte
transverse du socle — **Moonlight ne doit jamais être visible ni configuré à la
main** — devient ici le critère d'acceptation principal, pas un confort.

---

## 2. Ce qui a été écarté, et pourquoi

**Sunshine officiel avec SudoVDA.** Écarté après vérification, pas par préférence.
SudoVDA n'expose aucun moyen de commande : ni outil en ligne de commande, ni IOCTL
public, seulement une clé de registre de réglages globaux lue au chargement du
pilote. L'adaptateur présent sur le PC n'est qu'un adaptateur : il ne porte aucun
moniteur tant qu'un logiciel ne lui en crée pas. Seul Apollo sait le faire, par un
protocole privé non documenté. Sunshine officiel avec ce pilote ne produirait donc
aucun écran virtuel du tout.

**Sunshine officiel avec un autre pilote d'écran virtuel.** Techniquement viable —
le `Virtual-Display-Driver` du projet VirtualDrivers a, lui, un outil de commande.
Écarté pour son coût : il faut désinstaller Apollo, poser un second pilote, poser
Sunshine, et surtout contourner un blocage de fond. Microsoft documente que
`SetDisplayConfig` échoue en `ERROR_ACCESS_DENIED` pour tout appelant sans accès au
bureau courant, « or is running on a remote session ». Piloter l'affichage depuis
SSH est bloqué par construction. Le contournement connu est une ouverture de session
automatique au démarrage plus une tâche planifiée liée à cette session — donc le mot
de passe Windows en clair dans le registre. Apollo évite tout cela : son service
crée l'écran par son propre pilote, pas par l'API de topologie.

**Sunshine officiel sur l'écran physique.** Le plus robuste et le plus court à
écrire, mais il fige la définition sur celle du moniteur du PC et le PC n'est plus
headless : son écran affiche la session. Écarté sur les deux points.

**Le presse-papier.** Aucun composant, conformément au socle : Moonlight synchronise
nativement le texte.

**Le HDR.** Reporté. C'est la fonction la mieux documentée comme cassante sur écran
virtuel, elle réclame un réglage de délai au basculement, et quand elle rate elle
délave toute l'image. On livre une v1 qui marche.

---

## 3. État constaté des machines

Tout ce qui suit a été mesuré, pas supposé.

**Mac.** Deux écrans : le XDR intégré en 3456×2234 à 120 Hz, marqué principal,
soit 1728×1117 points ; et un ASUS PG329 en 2560×1440 à 144 Hz. `system_profiler`
**ne rapporte aucune fréquence pour l'écran interne** — il est donc inutilisable
comme source. CoreGraphics rend les deux, plus le drapeau « principal », en 0,22 s.
Moonlight est absent. Homebrew propose le cask `moonlight` 6.1.0, qui pose
`/Applications/Moonlight.app` **et** un lien `moonlight` dans le PATH.

**PC.** Apollo 0.4.6 est installé depuis le 1er juin dans `C:\Program Files\Apollo`,
posé à la main, service `ApolloService` à l'arrêt en démarrage manuel. Sa
configuration est vierge : `sunshine.conf` réduit à une ligne, **aucun client
appairé**, un unique démarrage le 2 juin. Le pilote SudoVDA 1.10.9.289 de SudoMaker
(`oem52.inf`) est actif — il appartient à Apollo, qui le livre dans
`drivers\sudovda\`. Sunshine officiel n'est pas installé.

Adresse matérielle du PC sur le lien direct : `e8:9c:25:2a:70:e1`, avec
`WakeOnMagicPacket` activé sur l'Ethernet — le réveil par le réseau est donc
possible depuis le Mac.

Disques : C: 813 Go dont 108 libres, D: « HARD » 931 Go entièrement vide, E: « 4TB »
3726 Go dont 215 libres. Un seul partage non administratif existe, `arthur`, pointant
sur `C:\Users\arthur`.

---

## 4. Décisions

| Décision | Choix retenu |
|---|---|
| Serveur | Apollo 0.4.6, **posé par `hardline install`**, jamais hérité |
| Écran virtuel | Créé par Apollo à la demande, à la définition réclamée par le client |
| Détection de l'écran | À chaque `hardline up`, sur l'écran principal du Mac |
| Mode par défaut de `up` | Fenêtré redimensionnable ; le plein écran est un second mode |
| HDR | Hors périmètre v1 |
| Débit vidéo | Laissé au choix de Moonlight |
| Appairage | Code à quatre chiffres imposé aux deux bouts, jamais lu par un humain |
| Secrets | Trousseau macOS, jamais le manifeste |
| Partages montés | `arthur`, D: et E: |
| Identifiants SMB | Le compte Windows de l'utilisateur, mot de passe au trousseau |
| Durée du montage | Le temps de la session, monté et démonté par `up` |
| Apollo étranger trouvé | **L'installation s'arrête et demande** avant d'effacer |
| Désinstallation | Tout retirer, des deux côtés, Moonlight compris |
| ViGEmBus | Retiré systématiquement — risque assumé, voir §10 |

---

## 5. Architecture — sept étapes

Le plan 2 n'invente aucune mécanique. Il ajoute sept étapes au registre existant,
chacune avec son `inspect`, son `apply` et son `restore`, chacune consignant son état
antérieur au manifeste **avant** de modifier quoi que ce soit. L'ordre d'application
est celui-ci ; le retrait suit l'ordre inverse.

Sur le PC, par SSH :

1. **`apollo-install`** — Apollo 0.4.6 présent, posé par `hardline`.
2. **`apollo-config`** — les six clés de `sunshine.conf` et les identifiants web.
3. **`apollo-service`** — `ApolloService` en démarrage automatique et démarré.
4. **`smb-shares`** — les partages de D: et E: créés.

Sur le Mac :

5. **`moonlight-install`** — le cask Homebrew posé.
6. **`pairing`** — le Mac appairé à Apollo, vérifié par relecture.
7. **`smb-credentials`** — le mot de passe Windows rangé au trousseau.

Le montage SMB lui-même n'est pas une étape : il ne dure que la session et relève
de `up`, pas de l'installation. Ce sont les **partages** qui sont installés, pas le
montage.

Deux mécanismes nouveaux, et rien d'autre.

**Le détecteur d'écran.** Une trentaine de lignes de Swift interrogeant
CoreGraphics, compilées au `bun run build` en un binaire de 54 Ko embarqué dans
l'exécutable comme asset — exactement le motif que le socle emploie déjà pour
`bootstrap.ps1`, et pour la même raison : un fichier posé à côté de l'exécutable est
fragile. Conséquence : **`hardline` ne dépend pas de Xcode à l'exécution**, seule sa
construction en dépend. Le binaire rend, pour chaque écran, sa définition en pixels,
sa fréquence, sa taille en points et s'il est principal.

**Le coffre.** Un module qui range et relit deux secrets dans le trousseau macOS :
le mot de passe de l'interface d'Apollo, tiré au hasard à l'installation, et le mot
de passe du compte Windows, demandé une fois. Il passe **toujours** par
`/usr/bin/security` et jamais par l'API native : c'est ce qui garantit que
l'application de confiance inscrite dans la liste de contrôle d'accès reste la même
d'une version de `hardline` à l'autre, et donc qu'aucune invite n'apparaît. Le
manifeste ne contient jamais de secret ; il ne sait que ce qu'il y avait avant.

---

## 6. Le geste quotidien

`hardline up` enchaîne cinq choses et rend la main quand la session se ferme.

1. **Joindre le PC.** S'il ne répond pas, envoyer le paquet magique de 102 octets
   sur son adresse matérielle — un simple datagramme UDP, aucune dépendance — puis
   attendre le lien plutôt qu'échouer.
2. **Lire l'écran.** Le détecteur rend la définition et la fréquence de l'écran
   principal. Les options `--resolution` et `--fps` les remplacent quand l'usage
   l'exige.
3. **S'assurer qu'Apollo tourne**, par SSH.
4. **Monter les partages** `arthur`, D: et E:, avec le mot de passe relu au
   trousseau.
5. **Lancer le flux** :
   `moonlight stream 10.10.10.1 "Desktop" --display-mode windowed --resolution 3456x2234 --fps 120`

C'est ici que le choix d'Apollo paie. Ses clés `dd_resolution_option = auto` et
`dd_refresh_rate_option = auto` lui font créer l'écran virtuel à la définition que le
client réclame. **On ne pousse aucune configuration par session** : la valeur voyage
dans la requête de streaming, pas dans un fichier qu'il faudrait écrire, relire et
défaire.

À la fermeture, `up` démonte les partages et appelle `moonlight quit 10.10.10.1`
pour clore la session côté serveur, ce qui déclenche le retrait de l'écran virtuel.
Sans cet appel, l'écran fantôme reste — c'est le défaut le plus visible d'un
enchaînement bâclé.

Options : `--fullscreen` bascule en `--display-mode fullscreen` ; `--resolution` et
`--fps` imposent un mode. Le redimensionnement **pendant** la session est annoncé par
Apollo mais **non vérifié** : il est inscrit comme à éprouver, pas comme acquis.

---

## 7. Installation et configuration d'Apollo

L'installeur est un NSIS. `Apollo-0.4.6.exe /S /D=C:\Program Files\Apollo` fait tout
sans une seule question : ajout au PATH, pilote SudoVDA, migration de la
configuration, règle de pare-feu, pilote de manette ViGEmBus en `/passive`, création
du service et passage en démarrage automatique. L'artefact est unique et vérifiable :

```
https://github.com/ClassicOldSong/Apollo/releases/download/v0.4.6/Apollo-0.4.6.exe
SHA-256 42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a
```

L'empreinte est vérifiée avant exécution. Un binaire téléchargé et lancé en
administrateur sans contrôle serait une porte ouverte, et le socle a déjà posé la
règle : ce qui touche au PC est décidé sur le Mac.

Les identifiants de l'interface web se posent sans jamais l'ouvrir, par
`sunshine.exe --creds <utilisateur> <motdepasse>`. Le mot de passe est tiré au hasard
et rangé au trousseau. Attention : `--creds` écrit sur disque mais ne recharge pas un
service déjà en mémoire — l'appel se fait avant le premier démarrage, ou le service
est relancé juste après.

La configuration tient en six clés dans `C:\Program Files\Apollo\config\sunshine.conf` :

```
headless_mode = enabled
dd_configuration_option = ensure_only_display
dd_resolution_option = auto
dd_refresh_rate_option = auto
dd_config_revert_on_disconnect = enabled
capture = ddx
```

`ensure_only_display` active l'écran virtuel et **désactive tous les autres** le
temps de la session, puis rétablit la topologie : c'est ce qui rend le PC headless
sans y toucher. `capture = ddx` est imposé parce que l'autre moteur de capture,
Windows.Graphics.Capture, ne fonctionne pas en mode service — le bug est ouvert chez
Sunshine et **Apollo ne l'a pas corrigé** ; sa propre documentation porte
l'avertissement.

---

## 8. Appairage

Le sens de l'appairage est imposé par le protocole : **c'est le client qui choisit le
code**. `moonlight pair 10.10.10.1 --pin 4821` permet donc d'imposer une valeur au
lieu de la subir, et `POST /api/pin` sur le port 47990 la donne au serveur.

La séquence, sans humain :

1. Tirer un code à quatre chiffres au hasard.
2. Lancer `moonlight pair` avec ce code, sans attendre sa fin.
3. Poster `{"pin":"4821","name":"<nom du Mac>"}` sur
   `https://10.10.10.1:47990/api/pin`, authentification Basic, vérification TLS
   relâchée dans le client dédié prévu par le socle.
4. **Relire `GET /api/clients/list`** pour confirmer.

L'étape 4 n'est pas une précaution de style. Le point d'entrée d'appairage est
documenté comme répondant parfois « c'est fait » sans qu'aucune session soit en
attente. On ne le croit pas sur parole.

Une réserve, tenue pour honnête plutôt que cachée : `moonlight pair` ouvre une petite
fenêtre d'attente, qui se referme dès que le serveur confirme, soit environ une
seconde. Elle n'apparaît **qu'à l'installation**, jamais au quotidien. C'est la seule
entorse à « ne jamais voir Moonlight », et elle est bornée.

Le retrait se fait par `POST /api/clients/unpair` côté PC, et par la suppression de
l'entrée d'hôte dans `~/Library/Preferences/com.moonlight-stream.Moonlight.plist`
côté Mac.

---

## 9. Partages

`arthur` existe déjà et pointe sur `C:\Users\arthur` : rien à créer, et donc rien à
défaire. Les partages de D: et E: sont créés par `hardline` et retirés par lui.
Leur état antérieur — leur absence — est consigné comme tout le reste.

L'authentification se fait avec le compte Windows de l'utilisateur, dont le mot de
passe est demandé une fois à l'installation et rangé au trousseau. Le montage se fait
par `mount_smbfs`, dure le temps de la session, et `up` le défait en sortant. Aucun
volume fantôme ne survit à une session, et le Finder ne se fige jamais sur un partage
dont le câble est débranché.

---

## 10. Désinstallation, et le désinstalleur qui ment

C'est le point le plus délicat du plan, et il est contre-intuitif.

`Uninstall.exe /S` **ne retire ni le pilote SudoVDA, ni le pilote ViGEmBus, ni le
dossier d'installation**. Trois boîtes de dialogue gardent ces suppressions, et leur
réponse par défaut en mode silencieux est « non ». Le nettoyage du PATH est imbriqué
dans la même branche, donc sauté lui aussi. Un désinstalleur silencieux qui laisse
tout en place et sort en succès.

La désinstallation complète est donc orchestrée par `hardline`, dans cet ordre :

1. `sc stop ApolloService`
2. `Uninstall.exe /S _?=C:\Program Files\Apollo` — le paramètre `_?=` **est
   obligatoire** : sans lui, le désinstalleur NSIS se recopie dans un dossier
   temporaire et se détache, la commande SSH rend la main immédiatement et l'étape
   suivante s'exécute pendant que la précédente tourne encore.
3. Retrait du pilote : `nefconc.exe --remove-device-node --hardware-id
   root\sudomaker\sudovda --class-guid "4D36E968-E325-11CE-BFC1-08002BE10318"`,
   appelé **en direct**. Surtout pas par le `uninstall.bat` fourni : il se termine
   par un `pause` qui attendrait pour toujours un appui clavier sur un tube qui n'en
   fournira jamais.
4. Retrait des certificats : `certutil -delstore root sudovda.cer` et
   `certutil -delstore TrustedPublisher sudovda.cer`. Aucun script d'Apollo ne le
   fait ; sans cette étape, deux certificats restent dans les magasins de confiance.
5. `scripts\uninstall-gamepad.ps1` pour ViGEmBus.
6. `update-path.bat remove`, puis suppression du dossier.
7. Filets de sécurité : `sc delete ApolloService` et
   `netsh advfirewall firewall delete rule name=Apollo`.

**ViGEmBus est retiré systématiquement.** C'est une décision assumée, et son risque
est nommé ici pour être tracé : ce pilote est partagé, d'autres logiciels de manette
ou d'émulation peuvent en dépendre, et sa suppression peut les priver de manette sans
aucun rapport avec `hardline`. La règle de l'outil ailleurs — ne défaire que ce qu'on
a fait — est ici volontairement enfreinte au nom d'une table rase complète.

Côté Mac, la désinstallation retire l'appairage, le mot de passe du trousseau, et
Moonlight lui-même par `brew uninstall --cask moonlight`.

---

## 11. Quand `hardline install` trouve un Apollo étranger

Le cas se présente dès la première exécution : la machine de référence porte une
installation manuelle de juin. La règle retenue est de **s'arrêter et demander**.

L'installation nomme ce qu'elle a trouvé — version, nombre de clients appairés,
présence d'une configuration — et attend un accord explicite avant d'effacer. Elle
sauvegarde la configuration existante avant de la retirer, et consigne au manifeste
qu'un Apollo étranger était là.

Ce choix a un coût, et il faut le regarder en face : il rompt l'installation en un
seul geste et rend le déroulement non scriptable. Il est retenu parce que
l'alternative — effacer en silence le travail de quelqu'un — coûte plus cher quand
elle se trompe. `--yes` lève la question pour les usages scriptés.

Une limite honnête, dans la lignée de ce que le socle dit de l'amorçage : un Apollo
étranger retiré **ne sera pas remis** par `hardline uninstall`. L'outil ne sait pas
réinstaller une version qu'il n'a pas posée. La désinstallation le dira au lieu de le
taire, et la configuration sauvegardée reste sur disque.

---

## 12. Persistance au redémarrage

Survivent nativement : le service `ApolloService` en démarrage automatique, le pilote
SudoVDA, la règle de pare-feu, l'appairage, les partages, et le mot de passe au
trousseau. Aucune tâche planifiée n'est nécessaire, contrairement à ce qu'aurait exigé
la voie Sunshine officiel.

Ne survivent pas, et n'ont pas à survivre : le montage SMB et l'écran virtuel, tous
deux liés à la session.

---

## 13. Commandes

| Commande | Rôle |
|---|---|
| `hardline up` | Réveille le PC, monte les partages, ouvre le bureau Windows en fenêtre |
| `hardline up --fullscreen` | Le même, en plein écran |
| `hardline up --resolution WxH --fps N` | Impose un mode au lieu de celui de l'écran |
| `hardline doctor` | Rend compte en plus de l'état d'Apollo et de l'appairage |

`doctor` reste scriptable selon la règle du socle : 0 quand la liaison fonctionne, 1
sinon. Un Apollo arrêté rend la session impossible et compte donc comme une anomalie.

---

## 14. Pièges connus, et ce qu'on en fait

**Le multi-écran sur macOS.** C'est la zone la plus buggée du client Moonlight :
plein écran instable sur l'écran secondaire, décalage sur l'encoche des MacBook,
mode sans bordure non respecté. Le Mac de référence a deux écrans. C'est le premier
risque à éprouver, pas le dernier — et c'est une des raisons pour lesquelles le mode
fenêtré est le mode par défaut.

**Les identifiants d'écran instables.** Les identifiants d'écran virtuel changent
d'une session à l'autre. Le plan ne les emploie jamais : Apollo choisit son écran
lui-même. C'est une fragilité évitée par conception, pas contournée.

**L'antivirus.** Apollo est signalé en faux positif par plusieurs antivirus depuis la
0.4.x, la capture d'entrées étant confondue avec un enregistreur de frappe. À
constater sur la machine, pas à contourner.

**La session Windows.** La capture sans écran physique allumé et sans session ouverte
n'est confirmée par aucune source. C'est le trou le plus important du dossier : il se
comble par un essai sur la machine, au plus tôt dans l'implémentation.

---

## 15. Tests

La discipline du socle s'applique sans changement : `bun test --isolate` obligatoire,
frontières système isolées derrière des fonctions pures, aucun test n'atteint une
vraie machine.

Les surfaces pures à couvrir : la lecture de la sortie du détecteur d'écran, la
composition de la ligne de commande de Moonlight à partir des options et de l'écran
détecté, la lecture des réponses de l'API d'Apollo, la construction et la lecture de
`sunshine.conf`, la composition du paquet magique, et la lecture des états
d'installation d'Apollo.

Trois vérifications ne se simulent pas et doivent être faites sur les machines, tôt :
le plein écran sur deux écrans, la capture sans écran physique, et le
redimensionnement en cours de session.

---

## 16. Non-objectifs

Le HDR. Le presse-papier par agent tiers. Le multi-client. L'usage hors du lien
direct. Le redimensionnement pendant la session, tant qu'il n'est pas prouvé. La
réinstallation d'un Apollo étranger. Le support d'une autre machine que les deux
machines de référence.
