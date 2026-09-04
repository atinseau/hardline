# Etude de faisabilite : Kyber comme seconde stack Hardline

Status: feasibility-study

Date: 2026-08-24

## Decision resumee

Kyber merite un prototype isole, mais rien ne permet aujourd'hui d'affirmer qu'il maximisera completement la qualite de Hardline.

La faisabilite technique d'une installation cote a cote est bonne : Kyber et Apollo/Moonlight emploient des services, clients, protocoles et ports differents. La faisabilite d'une qualite superieure reste a demontrer. Kyber utilise lui aussi une capture DXGI, une conversion YUV et un encodage video avec pertes. Son profil NVENC par defaut (`P2`, ultra-low-latency, sans B-frames) est meme plus oriente vitesse que l'Apollo actuel (`P5`, two-pass, 4:4:4, spatial AQ).

La recommandation est donc :

1. Conserver Apollo/Moonlight comme stack stable.
2. Installer Kyber comme stack experimentale, desactivee par defaut.
3. Desactiver le pilote d'ecran virtuel Kidd de Kyber et reutiliser d'abord l'ecran virtuel SudoVDA gere par Apollo.
4. Ne jamais activer simultanement les deux flux pendant le prototype.
5. Comparer objectivement les deux chaines avant toute integration dans `hardline up`.

Verdict actuel : **GO conditionnel pour un prototype manuel ; NO-GO pour une integration produit ou un remplacement.**

## Identite et maturite

Kyber est un projet distinct de VideoLAN, porte par Kyber SAS et construit par des contributeurs issus de VLC/FFmpeg. Il se presente comme une stack de controle distant tres basse latence fondee sur VLC, FFmpeg et QUIC [S1].

La version publique etudiee est `0.28.0`, publiee en aout 2026. Le produit reste pre-1.0, evolue rapidement et conserve deux moteurs media, `txproto` et le nouveau `libavconv`, ce dernier etant encore en cours de deploiement [S4][S6]. Le client desktop n'a pas encore d'interface graphique et le client macOS doit actuellement etre construit depuis les sources [S3][S7].

La licence est double : AGPL-3.0-or-later ou commerciale [S5]. L'execution de binaires non modifies et separes de Hardline semble compatible avec une evaluation, mais toute distribution, modification ou integration forte doit faire l'objet d'une validation de licence.

## Architecture Kyber pertinente

La chaine media visee est :

```text
Windows DXGI
  -> texture GPU
  -> FFmpeg / NVENC
  -> kymux
  -> QUIC chiffre
  -> VLC modifie en mode zero-latence
  -> decodeur et rendu macOS
```

Le serveur separe le controle, la capture/encodage, les entrees et le multiplexage en processus distincts. Seul `kymux` communique sur le reseau. Les images anciennes peuvent etre abandonnees afin d'eviter que la latence s'accumule [S1][S2].

Kyber utilise par defaut un seul port, `8080/TCP+UDP`, avec HTTPS pour le controle et QUIC/TLS pour les donnees [S3][S6]. Cela ne collisionne pas avec les ports GameStream d'Apollo/Moonlight.

## Capacites verifiees

| Exigence | Etat Kyber | Evaluation |
| --- | --- | --- |
| Serveur Windows 10/11 | Documente et package | Satisfait |
| Client macOS Apple Silicon | Documente | Satisfait, mais build source necessaire |
| NVIDIA RTX 4090 / NVENC | Backend recommande | Satisfait |
| Capture GPU sans copie CPU | DXGI vers NVENC | Satisfait |
| H.264, HEVC, AV1 | Exposes | HEVC exploitable ; AV1 annonce experimental |
| YUV 4:4:4 | Option `--444`, implementation NVENC | Satisfait a verifier en execution |
| Definition arbitraire | Annoncee depuis 0.10 | A verifier a 3456x2234 |
| 120/144 Hz | Modes configurables, pas de plafond publie | A verifier |
| Multi-ecran | `--display_count` et selection d'ecran | Satisfait fonctionnellement, UX a verifier |
| Souris, clavier, gamepad | Implementes | Satisfait |
| Presse-papiers | Texte et HTML Windows | Satisfait |
| Audio | Capture systeme et Opus | Satisfait pour stereo ; surround inconnu |
| Chiffrement | HTTPS + QUIC/TLS | Satisfait |
| Authentification | Basic, JWT, OIDC | Satisfait, configuration obligatoire |
| Reconnexion | Option d'auto-reconnexion | Satisfait en theorie |
| HDR | Pas de support public complet documente | Non demontre |
| SDR 10 bits | Pas de garantie publique | Non demontre |
| Gestion ICC/ColorSync | Aucun contrat public precis | Non demontre |
| RGB ou lossless | Aucun mode public demontre | Non satisfait a ce stade |
| Client macOS signe/notarie | Non etabli | Risque operationnel |

## Comparaison avec la stack actuelle

### Apollo/Moonlight mesure aujourd'hui

La derniere session Hardline a confirme :

- capture et bureau virtuel a `3456x2234` ;
- flux `3456x2234@120` ;
- HEVC RExt 4:4:4 8 bits ;
- Rec.709 en plage complete ;
- NVENC P5, two-pass et spatial AQ ;
- debit demande de 212 Mbit/s ;
- decodage VideoToolbox et rendu Metal ;
- absence de pertes reseau significatives.

La limite restante vient principalement de l'encodage video avec pertes, du reglage ultra-low-latency et du rendu bilineaire.

### Kyber par defaut

Le nouveau backend `libavconv` configure NVENC avec :

- preset `P2` ;
- tuning `ull` ;
- `zerolatency=1` ;
- une image de delai ;
- aucune B-frame ;
- intra-refresh facultatif ;
- 4:4:4 demande par `rgb_mode=yuv444` pour HEVC/AV1 [S8].

Ce profil ne garantit pas une meilleure image que notre Apollo P5. A debit, definition et frequence identiques, il peut etre moins efficace.

Kyber permet toutefois de remplacer cette configuration par des options FFmpeg/NVENC personnalisees [S8]. C'est son principal interet pour Hardline : tester P5/P7, les modes de controle de debit, le GOP et les tampons sans etre limite par les choix exposes par GameStream.

### Ce que Kyber ne resout pas automatiquement

- La capture reste transformee en video YUV compressee.
- Le 4:4:4 supprime le sous-echantillonnage chromatique, pas la quantification.
- QUIC ameliore le transport et la gestion de congestion, pas la fidelite de l'encodeur.
- VLC apporte une grande compatibilite, mais aucune preuve actuelle d'un rendu plus net que Metal a l'echelle 1:1.
- Aucun mode RGB brut ou mathematiquement sans pertes n'est documente.
- Aucun contrat colorimetrique complet ne couvre aujourd'hui notre exigence Rec.709 full, ICC macOS et ecrans wide-gamut.

## Exigences Hardline pour une seconde stack

Une integration ne sera acceptable que si elle respecte les contraintes suivantes.

### Qualite video

- Geometrie de bout en bout strictement 1:1.
- `2560x1440@144` et `3456x2234@120` sans fallback silencieux.
- HEVC 4:4:4 effectivement negocie et decode.
- Aucune degradation visible des motifs monochromes d'un pixel au repos.
- Rec.709 SDR, plage complete, sans noirs ecrases ni image lavee.
- Absence de redimensionnement bilineaire cote serveur et client quand les dimensions concordent.
- Debit et configuration encodeur observables dans les journaux.

### Interaction

- Souris absolue utilisable sans capturer durablement le curseur macOS.
- Clavier complet, raccourcis systeme, presse-papiers et audio.
- Selection de l'ecran Mac et de l'ecran Windows explicite.
- Reconnexion et changement de topologie sans session bloquee.

### Exploitation

- Installation et desinstallation reversibles.
- Aucun remplacement ou reconfiguration implicite d'Apollo.
- Secrets stockes dans le trousseau macOS, jamais dans le depot ou la sortie CLI.
- Service Kyber desactive par defaut tant que la stack n'est pas choisie.
- Diagnostic explicite de la version, du codec, du chroma, du debit et du chemin decodeur.
- Fonctionnement sur le lien direct `10.10.10.0/24`, sans cloud ni relay.

## Coexistence proposee

```text
                         +-> Apollo -> GameStream -> Moonlight
Hardline -> mode video --|
                         +-> Kyber  -> QUIC       -> Kyber Client

Windows display topology: SudoVDA gere par Apollo/Hardline
Kyber Kidd: disabled
SMB, reveil, SSH et nettoyage: communs, geres par Hardline
```

### Regles de coexistence

- Conserver Apollo et Kyber dans des etapes d'installation separees.
- Ne pas faire gerer la meme topologie virtuelle par SudoVDA et Kidd.
- Configurer `[kyservice.kidd] enabled = false` pendant toute l'etude [S6].
- Faire capturer a Kyber l'ecran SudoVDA deja cree pour la session Apollo, sous reserve que DXGI l'enumere correctement.
- N'avoir qu'une stack de streaming active a la fois afin d'eviter la contention NVENC, les injections d'entrees concurrentes et les changements de mode croises.
- Utiliser un port Kyber explicite et fixe, distinct des ports Apollo.
- Arreter proprement une session avant de basculer de stack.

La coexistence installee est probable. La coexistence active simultanee n'est ni necessaire ni suffisamment documentee et sort du perimetre recommande.

## Risques principaux

| Risque | Probabilite | Impact | Reduction |
| --- | --- | --- | --- |
| Qualite egale ou inferieure a Apollo | Haute | Haut | A/B objectif avant integration |
| Build macOS lourd ou non notarie | Haute | Moyen | Artefact local epingle et hash verifie |
| Conflit Kidd/SudoVDA | Moyen | Haut | Kidd desactive |
| Contention NVENC entre services | Moyen | Haut | Un seul flux actif |
| 3456x2234@120 non stable | Moyen | Haut | Monter progressivement depuis 60 Hz |
| 4:4:4 demande mais non effectif | Moyen | Haut | Verifier logs et mire chromatique |
| Colorimetrie non maitrisee | Haute | Haut | Mire, captures et mesures separees |
| Ruptures entre versions 0.x | Haute | Moyen | Epingler version et empreintes |
| Obligations AGPL | Moyen | Haut | Processus separe et revue de licence avant distribution |
| Surface d'attaque du controleur | Moyen | Haut | Lien direct, TLS, compte dedie, aucun defaut de developpement |

## Prototype recommande

Le prototype doit rester manuel et jetable. Il ne doit modifier ni le code Hardline ni son manifeste.

### Phase 1 : installation isolee

1. Sauvegarder l'etat Windows et verifier le point de restauration Hardline.
2. Installer Kyber `0.28.0` sur Windows, sur le lien direct seulement.
3. Desactiver Kidd avant le premier test.
4. Configurer un compte Basic dedie avec mot de passe fort et un certificat local epingle.
5. Construire le client macOS ARM64 depuis le tag exact correspondant.
6. Verifier que les deux services peuvent etre installes, arretes et demarres independamment.

### Phase 2 : preuve fonctionnelle minimale

Tester d'abord `2560x1440@60`, HEVC, 4:4:4, sans audio ni gamepad :

- connexion QUIC sur le lien direct ;
- capture du bon ecran SudoVDA ;
- souris et clavier ;
- plein ecran sur l'ecran Mac choisi ;
- arret et reconnexion sans laisser de processus ni d'ecran residuel.

### Phase 3 : matrice qualite

Comparer Apollo et Kyber sur la meme mire et la meme topologie :

| Definition | FPS | Debit demande | Codec/chroma |
| --- | ---: | ---: | --- |
| 2560x1440 | 60 | 124 Mbit/s | HEVC 4:4:4 |
| 2560x1440 | 144 | 124 Mbit/s | HEVC 4:4:4 |
| 3456x2234 | 60 | 212 Mbit/s | HEVC 4:4:4 |
| 3456x2234 | 120 | 212 Mbit/s | HEVC 4:4:4 |
| 3456x2234 | 120 | 300 puis 500 Mbit/s | HEVC 4:4:4 |

Pour Kyber, comparer au minimum :

- configuration NVENC par defaut P2 ;
- configuration equivalente a Apollo P5 ;
- P7 si la latence et la cadence restent acceptables ;
- protocoles `gopstream` et `unreliable_fec` ;
- intra-refresh active puis desactivee.

### Mires et mesures

- Damier noir/blanc d'un pixel.
- Traits rouges, verts et bleus d'un pixel sur gris neutre.
- Texte monochrome et colore de petite taille.
- Degrades 8 bits et patches 0/16/235/255.
- Defilement constant de texte.
- Sequence de mouvement complexe reproductible.

Relever pour chaque essai :

- dimensions capturees, encodees, decodees et affichees ;
- codec, profil, profondeur, chroma et plage ;
- debit encodeur reel ;
- temps capture, encodage, reseau, decodage et rendu ;
- pertes, retransmissions/FEC et images abandonnees ;
- charge NVENC, GPU et CPU ;
- captures de mire sans redimensionnement pour comparaison pixel a pixel ;
- evaluation visuelle sur les deux ecrans Mac.

## Criteres de decision apres prototype

### GO pour integration experimentale

Tous les criteres suivants doivent etre satisfaits :

- Kyber est objectivement plus net qu'Apollo sur au moins un mode cible, sans seulement augmenter fortement la latence.
- La colorimetrie est au moins equivalente et reproductible sur les deux ecrans.
- Le mode `3456x2234@120` tient sans perte, crash ni cadence encodeur insuffisante.
- L'installation de Kyber ne modifie pas Apollo et Kidd peut rester desactive.
- Le client macOS peut etre construit et distribue localement de facon reproductible.
- La fermeture restitue exactement l'etat d'avant session.
- Les obligations de licence sont acceptees.

### NO-GO

Un seul des points suivants suffit :

- absence de gain net face a Apollo P5 ;
- 4:4:4 ou definition native non confirmes ;
- colorimetrie moins fiable ;
- besoin d'activer Kidd en conflit avec SudoVDA ;
- instabilite a 120/144 Hz ;
- client macOS non reproductible ou non exploitable ;
- integration exigeant de fragiliser la reversibilite Hardline.

## Conclusion

Kyber est une bonne plateforme d'experimentation pour Hardline parce qu'elle ouvre davantage le pipeline FFmpeg/NVENC et le transport QUIC. Elle ne constitue pas, en l'etat des preuves, une solution pixel-perfect ni une garantie de qualite superieure.

La meilleure hypothese a tester est la suivante : **avec un preset NVENC P5/P7 personnalise, HEVC 4:4:4, un debit eleve et un transport QUIC adapte, Kyber peut reduire les artefacts sans depasser la latence d'Apollo.** Cette hypothese est falsifiable par le prototype ci-dessus.

Tant qu'elle n'est pas validee, Apollo/Moonlight reste la stack de reference et Kyber doit demeurer une stack experimentale independante.

## Sources primaires

- [S1] Kyber, README et compatibilite : https://gitlab.com/kyber/kyber/-/blob/main/README.md
- [S2] Architecture generale, VLC zero-latence, FFmpeg et QUIC : https://gitlab.com/kyber/kyber/-/blob/main/docs/Architecture/General.md
- [S3] FAQ officielle : https://gitlab.com/kyber/kyber/-/blob/main/docs/Help/FAQ.md
- [S4] Changelog desktop : https://gitlab.com/kyber/apps/kyber-desktop/-/blob/main/CHANGELOG.md
- [S5] Licence : https://gitlab.com/kyber/apps/kyber-desktop/-/blob/main/COPYING.md
- [S6] Configuration serveur de reference : https://gitlab.com/kyber/apps/kyber-desktop/-/blob/main/kyber_config.toml
- [S7] Build et execution du client macOS : https://gitlab.com/kyber/apps/kyber-desktop/-/blob/main/README.md
- [S8] Pipeline `libavconv` et options encodeur : https://gitlab.com/kyber/core/kymedia/-/blob/main/kyavservice/src/avconv/video.rs
- [S9] Installation Windows : https://gitlab.com/kyber/kyber/-/blob/main/docs/GettingStarted/Kyber-installation-notes-windows.md
- [S10] Site officiel Kyber : https://kyber.tech/technology

## Comments
