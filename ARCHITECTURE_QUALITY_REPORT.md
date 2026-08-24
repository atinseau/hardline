# Rapport d'architecture et de qualité

Date de l'audit : 2026-08-23  
Périmètre : état courant du worktree, y compris les modifications non commitées.

## Synthèse

Le projet présente une architecture saine et adaptée à son domaine : une CLI mince déclenche des cas d'usage, eux-mêmes appuyés sur un orchestrateur transactionnel et un registre d'étapes idempotentes. Le manifeste persistant tient lieu de journal de restauration. Cette idée centrale est bien exprimée, bien documentée dans le code et fortement testée.

Appréciation globale : **8,3 / 10 — bonne qualité, avec une dette surtout opérationnelle et de modularité.**

Les points les plus solides sont les invariants de sûreté, le modèle `inspect/apply/restore`, l'ordre explicite des étapes, la rigueur du typage et la densité des tests. Les principaux risques sont la configuration personnelle compilée dans le binaire, quelques modules trop volumineux, le faible niveau de validation réelle des frontières macOS/Windows et l'absence de pipeline qualité visible dans le dépôt.

## Méthode et limites

L'audit ne repose pas sur une lecture exhaustive. Il combine :

- une analyse structurelle des 44 fichiers de production sous `src/` ;
- une lecture ciblée des points d'entrée, du contrat `Step`, de l'orchestrateur, du registre d'étapes, de la configuration et de quelques adaptateurs ;
- un échantillon de tests autour de l'installation, de la restauration et du manifeste ;
- l'exécution du typage, de la suite complète et de la couverture.

Le graphe contient 373 nœuds, 941 relations et 11 communautés. Aucun cycle d'import n'a été détecté. Son diagnostic signale toutefois 24 relations à extrémité pendante et 7 relations fusionnées : ces limites viennent de l'extraction statique et invitent à ne pas surinterpréter les métriques de centralité.

## Architecture observée

```text
CLI (cli.ts)
  └─ commandes : install / uninstall / up / doctor
       ├─ orchestration et préconditions
       ├─ manifeste transactionnel
       └─ étapes ordonnées : inspect → apply → restore
            ├─ Mac : réseau, Moonlight, trousseau, montages SMB
            ├─ capture : état Windows issu du bootstrap
            └─ Windows : réseau, Apollo, service, partages, pairing
                 └─ adaptateurs : shell, SSH, PowerShell, API, fichiers
```

Les frontières sont globalement cohérentes :

- `src/cli.ts` ne fait que déclarer les commandes et traduire l'erreur finale en sortie CLI ;
- `src/commands/` porte les parcours utilisateur et les décisions de haut niveau ;
- `src/lib/orchestrator.ts` concentre le protocole générique de convergence et de restauration ;
- `src/steps/` encapsule chaque changement de système sous le même contrat ;
- `src/lib/` fournit les adaptateurs techniques et les fonctions de support.

Le cœur conceptuel est profond : le petit contrat `Step<P>` masque une forte complexité de réseau, de processus distants et de rollback. C'est la meilleure décision architecturale du projet.

## Points forts

### 1. Invariants de sûreté explicites

L'état antérieur est écrit avant toute mutation. La restauration s'effectue en ordre inverse et un enregistrement n'est supprimé qu'après une restauration observée. La distinction entre échec observé, action détachée non confirmable et cession à une étape plus profonde évite les faux succès.

### 2. Ordonnancement métier visible

Les groupes `LOCAL_STEPS`, `CAPTURE_STEPS` et `REMOTE_STEPS` rendent les dépendances temporelles lisibles. L'ordre n'est pas caché dans un framework : il est déclaré dans un seul registre et testé explicitement.

### 3. Très bonne discipline de test

- 765 tests, 1 781 assertions, 45 fichiers de test ;
- 0 échec ;
- 91,51 % de couverture de lignes et 92,58 % de fonctions ;
- tests dédiés à l'idempotence, à l'atomicité, aux verrous, aux secrets, aux erreurs partielles et aux ordres destructifs ;
- typage `strict` et `noUncheckedIndexedAccess`, sans erreur TypeScript.

Le ratio d'environ 11 684 lignes de test pour 7 087 lignes de production confirme que le projet privilégie la sûreté plutôt que la vitesse d'écriture.

### 4. Dépendances limitées et absence de cycles

Le runtime ne dépend que de Commander et Clack. Le graphe statique ne relève aucun cycle d'import, ce qui facilite la navigation et réduit les initialisations implicites.

### 5. Documentation locale utile

Les commentaires expliquent surtout les contraintes non évidentes et les raisons de l'ordre des opérations. Sur ce type d'outil système, cette documentation proche du code a une vraie valeur.

## Risques et dettes

### Priorité haute — configuration personnelle compilée

`src/config.ts` contient l'utilisateur Windows, les adresses, le nom d'interface, le chemin de clé SSH, les partages et les chemins de montage. C'est acceptable pour un outil strictement personnel, mais cela mélange modèle de configuration et instance locale. Cela limite la réutilisation, rend les changements environnementaux dépendants d'un rebuild et augmente le risque d'exécuter le binaire contre la mauvaise machine.

Recommandation : charger une configuration validée au démarrage, conserver des valeurs par défaut non sensibles et afficher la cible avant toute mutation. Un mode `--dry-run` ou au minimum un récapitulatif de cible renforcerait encore la sûreté.

### Priorité haute — frontières système peu validées en conditions réelles

La couverture globale est excellente, mais `ssh.ts` est à 33,33 % des lignes, `shell.ts` à 62,77 %, `wol.ts` à 72,73 % et `brew.ts` à 70 %. `keychain.ts` est annoncé à 0 % des lignes par Bun malgré des tests de consommateurs, signe que les mocks contournent la frontière réelle.

Les tests prouvent très bien les décisions et les scripts générés, moins leur comportement sur les versions concrètes de macOS, Windows, OpenSSH, PowerShell, Apollo et Moonlight.

Recommandation : ajouter un petit niveau de tests contractuels opt-in, exécuté sur les deux machines réelles ou dans une matrice dédiée, sans chercher à remplacer les tests unitaires actuels.

### Priorité moyenne — modules centraux volumineux

Les fichiers les plus lourds de production sont `manifest.ts` (568 lignes), `bootstrap-windows.ts` (476), `apollo-install.ts` (454), `install.ts` (382) et `up.ts` (364). Leur taille n'est pas artificielle : ils portent des scénarios complexes. Elle augmente néanmoins le coût de modification et favorise les tests eux-mêmes très volumineux.

Recommandation : extraire uniquement les sous-domaines stables, par exemple le verrou du manifeste, la validation/IO du manifeste, les scripts Apollo et la préparation d'une session `up`. Éviter un découpage purement métrique qui disperserait les invariants.

### Priorité moyenne — couplage global des commandes

Les commandes importent directement `CONFIG`, `ui`, les adaptateurs et modifient `process.exitCode`. Les tests compensent ce couplage avec de nombreux `mock.module`. Cela fonctionne avec `bun test --isolate`, mais rend les tests sensibles à l'ordre des imports et complique l'intégration de plusieurs profils ou interfaces.

Recommandation : introduire progressivement un petit objet de dépendances au niveau des commandes (`config`, `ui`, horloge, adaptateurs), sans ajouter de conteneur d'injection. Commencer par `install` ou `up`, pas par une refonte globale.

### Priorité moyenne — perte de type dans le registre hétérogène

Les tableaux d'étapes utilisent `Step<any>[]`. Le paramètre `P` reste utile dans chaque étape, mais la relation entre l'état capturé et la valeur passée à `restore` disparaît dans l'orchestrateur. La validation du manifeste devient donc la dernière barrière à l'exécution d'un ancien état.

Recommandation : encapsuler la création des étapes dans un helper typé et ajouter un validateur/versionneur de l'état `previous` par étape. La priorité est la validation runtime, davantage que l'élimination cosmétique de `any`.

### Priorité moyenne — garde-fous de dépôt absents

Le dépôt n'expose ni README racine, ni script `typecheck`, ni lint/format, ni workflow CI visible. La commande de test est bonne, mais la qualité dépend actuellement de la discipline locale.

Recommandation : ajouter au minimum `typecheck`, `check` et une CI exécutant typage + tests. Documenter les prérequis macOS/Windows, les actions destructives possibles et la procédure de récupération du manifeste.

### Priorité basse — version dupliquée

La version `0.1.0` est présente dans `package.json` et dans `src/cli.ts`. Elle finira probablement par diverger.

Recommandation : injecter ou lire la version du package pendant le build.

## Plan d'amélioration recommandé

1. **Sécuriser l'exploitation** : configuration externe validée, cible affichée, documentation de récupération.
2. **Automatiser les garde-fous** : scripts `typecheck/check`, CI et éventuellement format/lint léger.
3. **Tester les frontières réelles** : smoke tests opt-in SSH, PowerShell, trousseau, réseau et Moonlight.
4. **Réduire les points chauds** : séparer manifeste/lock et les générateurs de scripts, en conservant les invariants dans des modules profonds.
5. **Améliorer l'injection des dépendances** : d'abord sur une commande pilote, puis seulement si le gain de testabilité est confirmé.

## Verdict

Le projet n'a pas un problème d'architecture fondamental. Son modèle central est cohérent, sa sûreté est pensée en profondeur et ses tests sont inhabituellement solides. La prochaine marche de qualité ne consiste pas à ajouter davantage de couches : elle consiste à rendre l'outil moins dépendant de la machine de son auteur, à valider ses frontières réelles et à automatiser les contrôles déjà respectés localement.
