# JKL Telegram Backup

**Statut : prototype expérimental v0.2.7 — téléchargement non validé sur Telegram Web.**

Userscript Tampermonkey pour la sauvegarde et le renommage des photos et vidéos Telegram. L'objectif est de retrouver une expérience comparable à JKL Instagram Backup, adaptée à Telegram. Le prototype actuel vise **Telegram WebK uniquement**.

> **Attention :** des modules internes de Telegram WebK utilisés par cette version ne sont pas garantis accessibles depuis `window`. Les tests automatisés vérifient la logique de transformation et le code, **pas** les téléchargements dans une vraie session Telegram. Conserver le script Telegram qui fonctionne comme solution de secours.

## Installer le prototype

[**Installer JKL Telegram Backup v0.2.7 (Tampermonkey)**](https://raw.githubusercontent.com/JKL93sang/JKL-Telegram-backup/main/JKL_Telegram_Backup.user.js)

1. Activer Tampermonkey sur Firefox.
2. Désactiver temporairement le téléchargeur Telegram tiers pour éviter les interactions entre scripts (sans le supprimer).
3. Installer le lien ci-dessus en confirmant dans Tampermonkey.
4. Ouvrir [Telegram WebK](https://web.telegram.org/k/) et tester avec **une photo et une vidéo non sensibles**, puis une petite sélection.
5. Noter précisément si le bouton apparaît, l'erreur affichée et si le fichier est réellement sauvegardé.

## Vidéos volumineuses — v0.2.7

La limite **512 Mio** était une protection fixée par JKL Backup, **pas** une interdiction de Telegram. Cette version retire le blocage de taille **avant** et **après** récupération de l'objet `Blob`. Le programme conserve :

- le téléchargement via **Telegram WebK** puis **Tampermonkey Browser API** avec chemin de profil et nom personnalisé ;
- le contrôle de taille réelle contre la taille déclarée par Telegram pour les documents vidéo et image ;
- la validation que le résultat n'est pas vide, l'enregistrement du manifeste **seulement après succès confirmé** et la reprise sans redownload des succès ;
- la possibilité de sélectionner un dossier existant et d'en comparer les fichiers.

**Attention : ce n'est pas encore un téléchargement en streaming directement vers le disque.** L'API `downloadMedia` actuellement utilisée retourne un Blob complet. Selon les versions et les ressources disponibles, Firefox, WebK ou Tampermonkey peuvent échouer sur les très gros fichiers. En cas d'échec rapporté ou d'arrêt du navigateur, la sauvegarde reste incomplète et la prochaine exécution peut retenter le fichier. En particulier, aucune garantie n'est donnée au-delà de 2 Gio sans essai réel sous Firefox.

**Tests :** médias de 700 Mio, 2 Gio et 3 Gio via blobs *simulés sans allouer cette mémoire*, et backup complet simulé avec une vidéo de 1,5 Gio échouant puis réussissant après relance. **Essai réel indispensable** pour confirmer qu'un gros fichier arrive entier avec le bon nom dans le dossier attendu.

## Interface et diagnostic v0.2.7

Le petit bouton **« ↓ JKL Telegram Backup v0.2.7 »** est visible en haut, près du centre de la page Telegram. Il ouvre un panneau affichant :
- si Telegram WebK (`/k/`) est utilisé ;
- si le moteur interne Telegram et la lecture des messages sont accessibles ;
- les actions expérimentales **Télécharger le média survolé** et **Télécharger la sélection** ;
- **Copier diagnostic** pour analyser un problème précis.

Si Telegram est ouvert sur `/a/`, le panneau propose un lien vers WebK ; les fonctions internes du script ne sont pas prévues pour WebA. Si le moteur ou la lecture apparaissent « indisponible », les boutons de téléchargement ne peuvent pas fonctionner sur cette session : le signaler avec le diagnostic pour adapter le code, sans multiplier les essais.

**Important :** l'interface visible est vérifiée par tests automatisés. Le téléchargement réel et la détection des messages restent non validés sur le navigateur de l'utilisateur.

## Correctifs v0.2.7

- **« Média ciblé » s'actualise pendant le survol**, sans refermer le panneau.
- Dans un album, le script cherche l'identifiant du média survolé (si le DOM Telegram l'expose).
- **Déplacer le panneau :** maintiens le clic gauche sur le bouton-titre « ↓ JKL Telegram Backup », glisse et relâche.
- La position est mémorisée localement pour les prochaines visites.
- Un glissement ne doit pas ouvrir/fermer le panneau ; un simple clic conserve ce comportement.

Les fonctions internes de téléchargement restent expérimentales, y compris le ciblage réel d'un album : cette version n'est pas encore une sauvegarde intégrale validée.

## Choisir un dossier déjà téléchargé — v0.2.7

Dans le panneau **Backup complet**, cliquer **« Choisir un dossier existant »**, puis choisir dans le sélecteur Firefox :

- soit le **dossier du profil Telegram** (par exemple `Téléchargements/mon_username`) ;
- soit le **dossier parent des profils** (par exemple `Téléchargements`, contenant directement `mon_username/` et les autres comptes).

Le mécanisme utilise `<input type="file" webkitdirectory directory multiple>`, identique à celui de JKL Instagram Backup. Le navigateur révèle uniquement le **nom**, la **taille** et le **chemin relatif** des fichiers explicitement sélectionnés. Le script ne lit pas leur contenu et n'a aucun accès permanent aux fichiers du système.

Le panneau indique le nom du dossier sélectionné et le nombre de fichiers locaux indexés pour ce profil. Pendant « Tout récupérer », chaque média détecté est comparé à son **nom de fichier attendu**. Une photo déjà présente avec une taille non nulle est ignorée ; un document vidéo/image doit avoir la même taille en octets que celle déclarée par Telegram pour être considéré présent.

Si un fichier existe dans le dossier mais n'était pas mémorisé dans le manifeste, le script l'inscrit à nouveau dans le manifeste de succès et **ne le télécharge pas**. À l'inverse, si le manifeste le mentionne mais que le fichier **n'est plus dans le dossier contrôlé**, il est retéléchargé et signalé sous « Absents malgré historique ». Les succès téléchargés durant la même session ne sont pas re-téléchargés une deuxième fois dans cette session.

**Limites et précautions :**

- La sélection est **volontaire, propre à la conversation et temporaire**. Pour une nouvelle session/actualisation, il faut sélectionner à nouveau le dossier afin d'avoir une vérification actuelle du disque. Le manifeste classique reste disponible en l'absence de sélection.
- Le dossier de vérification **n'est pas une destination d'écriture** : les nouveaux fichiers restent enregistrés dans le dossier de téléchargement Firefox/Tampermonkey configuré, sous le sous-dossier de profil. Pour éviter les doublons, sélectionne ce **même emplacement** ou son parent.
- Un dossier étranger, contenant aucun sous-dossier du profil concerné, est refusé plutôt que d'ignorer arbitrairement le manifeste.
- Un fichier ayant un nom (et, si applicable, une taille) attendu est traité comme présent ; ce n'est **pas** une vérification du contenu par hachage cryptographique.
- La liste de fichiers accessible via `webkitdirectory` peut être vide pour un dossier vide. Dans ce cas, la vérification du disque n'est pas activée ; le manifeste reste utilisé.

## Voyant de fin de téléchargement — v0.2.7

À la fin du backup complet, l'état est affiché **sur le bouton flottant**, même si le panneau est replié, et **en évidence en haut du panneau** :

| État | Couleur | Signification |
| --- | --- | --- |
| **Prêt** | Gris | Aucun résultat de backup complet connu pour le profil ouvert |
| **En cours · X/Y** | Bleu | Scan et transferts en cours : X fichiers traités sur Y médias détectés à cet instant |
| **Terminé · N médias** | **Vert** | Deux filtres d'historique arrivés à leur fin, aucune erreur, sauvegardes confirmées et manifeste anti-doublons conservé |
| **À compléter · N erreurs** | Orange | Fin de scan avec échecs sur des médias ; relancer après vérification du rapport |
| **Arrêté · reprise possible** | Orange | Arrêt demandé par l'utilisateur |
| **Incomplet / Interrompu · relancer** | Rouge | Erreur de parcours ou page rechargée pendant un téléchargement ; aucun succès global annoncé |

Le voyant est **associé à la conversation et au fil Telegram ouverts**, stocké en localStorage et retrouvé après actualisation. Changer de canal affiche uniquement l'état du nouveau canal ; un succès sur un autre profil ne peut pas le rendre vert. Un rechargement survenu pendant un téléchargement ne produit jamais un faux « Terminé ».

Ce voyant concerne le **backup complet**, pas un téléchargement SOLO, ni les médias payants non débloqués. Il certifie la fin de l'historique **accessible** dans les deux filtres actuellement pris en charge, pas la totalité théorique des contenus Telegram.

## Dossiers par username réel — v0.2.7

La création des dossiers respecte désormais cet ordre **pour un profil encore inconnu** :

1. **Username Telegram actif** fourni par `appPeersManager.getPeerUsername(peerId)`, par exemple `mon_canal`, sans le signe `@`.
2. **Nom affiché lisible** s'il n'existe aucun username, par exemple `Mon Canal`.
3. **Identifiant stable Telegram** pour les titres uniquement en émojis/custom emojis ou sans texte, par exemple `Profil_-100123456789`.

Exemples : `Téléchargements/mon_canal/mon_canal - 2026-10-12_10-21-04 - source.mp4` ou `Téléchargements/Profil_-100123456789/...`.

### Ne pas disperser les sauvegardes déjà commencées

- Une fois un nom de dossier décidé, il est conservé en localStorage sous la clé `JKL_TG_FOLDER_V1:<peerId>`. Un changement ultérieur de username ou de nom affiché **ne renomme pas le dossier**.
- Si un autre profil reçoit ultérieurement un username déjà attribué à un dossier mémorisé, le script ajoute son Peer ID au nouveau dossier (par exemple `ancien_pseudo_-10098765`) pour éviter de mélanger les profils.
- **Migration depuis v0.2.3 :** lorsqu'un historique local de **téléchargements réussis du backup complet** existe déjà, le script privilégie le nom de dossier hérité (nom affiché ou `Profil_<peerId>`) avant d'activer cette nouvelle priorité. Cela évite d'envoyer la suite du backup dans un autre dossier par défaut.
- Le navigateur **ne peut pas examiner, déplacer ou renommer les dossiers déjà présents sur disque** sans une permission de système de fichiers dédiée. Si le profil a été téléchargé uniquement en SOLO avant cette version, ou si son nom a changé depuis le dernier backup, le script ne peut pas déduire automatiquement son ancien répertoire. Il faut donc vérifier le dossier proposé au premier nouveau téléchargement. Il n'y a aucune migration physique.
- Le registre de dossiers n'est **pas** une preuve que les fichiers existent encore sur disque. Supprimer le dossier Téléchargements à la main n'efface pas la liste de succès dans le navigateur.

Les modifications concernent l'identification et la stabilité du dossier. La pagination des médias, le téléchargement Firefox/Tampermonkey, le filtrage, les erreurs et la reprise fonctionnent comme en v0.2.3.

## Profils dont le nom contient uniquement des émojis — v0.2.7

Telegram WebK peut afficher le titre d'un canal ou profil exclusivement en émojis, parfois comme des images de custom emojis ne laissant **aucun texte lisible dans le DOM**. Dans les anciennes versions, le script retombait sur `Telegram` et refusait le backup complet, pour éviter que tous ces profils soient mélangés dans un seul dossier.

**Correctif :** si le titre ne contient pas de lettre ou chiffre lisible après retrait des séquences d'émojis (y compris drapeaux et chiffres en touches), ou si le titre n'est pas présent comme texte, le script utilise le **peer ID** du profil pour créer un nom de répertoire unique, par exemple :

```text
Téléchargements/
└── Profil_-3986240785/
    ├── Profil_-3986240785 - 2026-10-12_01-43-00 - photo_132.jpg
    └── Profil_-3986240785 - 2026-10-12_01-43-05 - video_originale.mp4
```

Les noms ordinaires avec des lettres, chiffres, accents et éventuellement des émojis restent inchangés. Le format SOLO, le nom des fichiers, la pagination, le manifeste anti-doublons, le bouton Arrêter et la logique des téléchargements sont conservés. Aucun mélange entre deux titres « 🔥😈 » identiques : l'identifiant interne Telegram est distinct.

Les noms d'origine de fichiers composés exclusivement d'émojis reçoivent un repli stable `video_<ID>.mp4` ou `photo_<ID>.ext` afin de réduire le risque de refus du chemin par le navigateur.

**Validation :** tests automatisés sur titres émojis, drapeaux, touches numérotées, titres sans texte et backup complet simulé. Un test sur un vrai canal émojis dans Firefox est nécessaire pour confirmer le résultat final.

## Autorisation des extensions vidéo — v0.2.7

Lors du premier test réel du backup complet sur Telegram WebK, les 21 premiers médias ont été enregistrés et **4 vidéos ont échoué avec `not_whitelisted`**. Ce code est renvoyé par Tampermonkey lorsque l'extension de sortie n'est **pas autorisée** dans sa liste blanche, même si son mode de téléchargement est déjà « Browser API ». Les quatre fichiers concernés faisaient moins de 10 Mio : ils ne relevaient pas du problème des gros médias.

**Réglage utilisateur nécessaire :** Tampermonkey → Tableau de bord → Paramètres → Téléchargements → **Whitelisted File Extensions** (extensions autorisées). Ajouter l'extension affichée dans le rapport JKL, par exemple `mp4`, **sans effacer les extensions déjà présentes**. Conserver Download Mode = Browser API et n'autoriser que les extensions nécessaires (`mp4`, et selon les vidéos réellement rencontrées `webm`, `mov`, `mkv`, etc.). Ne pas désactiver globalement la liste blanche.

Cette version rend l'erreur **actionnable** : elle identifie automatiquement le suffixe du fichier bloqué (`.mp4`, `.webm`…) et indique le réglage précis dans le panneau et le rapport copiable. Le script ne modifie pas les permissions utilisateur et ne contourne pas les restrictions de Tampermonkey. Le manifeste de succès existant reste inchangé : relancer « Tout récupérer » doit ignorer les 21 sauvegardes précédentes et retenter les quatre vidéos.

Référence : [FAQ officielle Tampermonkey, téléchargement de fichiers (Q302)](https://www.tampermonkey.net/faq.php?ext=fire&q=Q302).

## Diagnostic détaillé des échecs — v0.2.7

Après un backup avec des erreurs, le panneau indique **pour chaque fichier en échec** : identifiant du message Telegram, type de média, taille déclarée et **raison exacte** (erreur de téléchargement, extension refusée, taille incohérente, etc.).

Cliquer sur **« Copier rapport du backup »** pour recopier le rapport complet. La commande **« Copier diagnostic »** intègre également le rapport pour la conversation actuellement ouverte. Le dernier rapport est conservé dans le stockage local du navigateur ; rouvrir le panneau après actualisation suffit pour le retrouver (si le stockage de Telegram n'a pas été effacé).

**Reprise inchangée :** seuls les fichiers que Tampermonkey a confirmés comme enregistrés sont consignés dans le manifeste de succès. Relancer « Tout récupérer » ignore les succès et retente les fichiers échoués. Il n'y a pas de retry automatique aveugle ; les causes sont d'abord exposées clairement.

Le nombre de détails conservés par exécution est plafonné à 100 (le compteur total reste exact) pour éviter de saturer le panneau.

## Backup complet de l'historique accessible — v0.2.7

**Action :** ouvrir le canal, le groupe ou la conversation dans [Telegram WebK](https://web.telegram.org/k/) puis cliquer sur **« Tout récupérer »** dans le panneau JKL. Le bouton **« Arrêter »** demande l'arrêt après l'opération en cours.

Le programme interroge directement l'API interne `appMessagesManager.getHistory` utilisée par l'onglet Médias de WebK, par pages de 75 messages filtrés. Il effectue deux parcours :

1. **Photos et vidéos** avec `inputMessagesFilterPhotoVideo`.
2. **Documents** avec `inputMessagesFilterDocument`, afin de récupérer également les photos/vidéos envoyées comme fichiers et certains GIF.

Les médias sont enregistrés **un par un** sous `Téléchargements/NomDuProfil/NomDuProfil - Date - NomOriginal.ext`. Les albums sont parcourus message par message ; les identifiants de messages et de média sont utilisés pour éviter les doublons entre filtres.

### Avancement, reprise et sécurité

- Le panneau montre les pages lues, médias détectés, enregistrements réussis, déjà traités et erreurs.
- Après **chaque enregistrement confirmé par Tampermonkey**, un manifeste local anti-doublons est mis à jour, propre au compte/canal et au fil Telegram. Relancer le backup évite les médias déjà enregistrés, et réessaie les erreurs.
- Le bouton « Arrêter » ne coupe pas brutalement le transfert déjà commencé ; il empêche la suite de la file.
- Un changement de conversation pendant l'opération interrompt le backup pour éviter de classer des médias dans le mauvais dossier.
- **Plus de limite arbitraire à 512 Mio :** les vidéos volumineuses sont désormais envoyées au moteur de téléchargement existant, toujours l'une après l'autre. La mémoire disponible et les limites de Firefox/Tampermonkey restent déterminantes.
- Si la pagination ne progresse plus, si l'API d'historique est inaccessible ou si des fichiers échouent, le résultat indique **« Incomplet »**. Il n'annonce jamais « tout téléchargé » sans avoir atteint `isEnd.top` sur les deux recherches, et sans échec.

**Limites :** le backup porte sur l'historique multimédia **accessible au compte connecté**. Contenus supprimés/non accessibles, stories, messages éphémères et autres sections de Telegram ne sont pas inclus. La version 0.2.4 dépend des méthodes internes de WebK, susceptibles de changer. Pour les très gros canaux, les requêtes et téléchargements peuvent être longs, et le manifeste local du navigateur peut atteindre sa limite de stockage. Les tests GitHub vérifient la logique simulée, pas l'exhaustivité réelle d'un gros canal. Un test sur quelques médias puis un petit canal entier est recommandé avant de l'utiliser à grande échelle.

## Dossiers automatiques par profil — v0.2.7

**Objectif :** tous les médias téléchargés par JKL depuis un profil, canal, groupe ou conversation sont placés dans un dossier au nom de cette conversation, dans le répertoire Téléchargements du navigateur, sans sélection manuelle du dossier à chaque fichier.

Exemple :

```text
Téléchargements/
└── Canal Démo/
    ├── Canal Démo - 2026-10-12_00-34-21 - photo_1524.jpg
    └── Canal Démo - 2026-10-12_00-34-22 - reunion originale.mp4
```

Le nom de dossier provient du titre de la conversation Telegram affichée dans WebK, neutralisé pour les caractères interdits sous Windows. Si Telegram ne fournit aucun titre identifiable, le nom de repli `Telegram` est utilisé.

**Préparation sur Firefox :**
1. Tampermonkey → Tableau de bord → Paramètres → activer « Mode expert » si nécessaire.
2. Section « Téléchargements » → « Mode de téléchargement » : **Browser API** (autoriser la permission de téléchargement si Firefox la demande).
3. Installer/mette à jour la version 0.1.5 : les nouveaux accès `GM_download` et `unsafeWindow` doivent être autorisés.
4. Dans WebK, effectuer le téléchargement JKL d'une petite photo test, puis **vérifier que le dossier a réellement été créé** dans le dossier Téléchargements.

Le script utilise désormais `GM_download({url: Blob, name: 'Profil/Fichier.ext'})` et ne peut plus se contenter du lien HTML `<a download>` (qui remplace les séparateurs par des caractères ordinaires). Tampermonkey 5.4+ est nécessaire pour le téléchargement de Blob. Suivant les versions et les permissions du navigateur, la création du dossier peut échouer : le script affiche alors une erreur et ne déclenche pas de téléchargement non classé en secours. Les tests automatisés vérifient le chemin demandé à Tampermonkey ; **ils ne prouvent pas la création effective du dossier sur disque**.

## Enregistrement renommé v0.2.7

La précédente implémentation transmettait `fileName` au téléchargement natif de Telegram WebK. **Pour les photos/vidéos, son mode streaming ne respectait pas ce nom** : Firefox enregistrait le nom d'origine.

En v0.2.7, l'action **JKL Backup** obtient le Blob complet via `downloadMedia`, puis utilise **GM_download** avec le chemin relatif `NomDuProfil/NomDuCompte - Date - NomOriginal.ext`. Les tests vérifient le chemin effectivement transmis à Tampermonkey.

**Limites techniques :**
- Aucune limite fixe à **512 Mio** : un média de 700 Mio, 1,5 Gio ou plus est *tenté* avec le renommage et le dossier habituels. La taille maximale réellement supportée dépend de Firefox, de Tampermonkey, de la mémoire disponible et des limites de Telegram WebK ; la CI ne simule pas l'allocation réelle d'un Blob de plusieurs gigaoctets. Un plantage de Firefox reste possible sur certains très gros fichiers. Le script ne passe jamais silencieusement à un téléchargement non classé.
- Les fichiers sont traités **séquentiellement** ; évite d'ouvrir d'autres tâches gourmandes en mémoire pendant une grosse sauvegarde.
- Une vidéo dont le poids téléchargé ne correspond pas au poids attendu est rejetée avant sauvegarde.
- Ne pas déduire d'une exécution CI verte que Firefox a bien écrit un fichier : vérifier une photo et une vidéo sur la vraie session Telegram.
- Le téléchargement natif Telegram/Firefox conserve son propre comportement.

## Renommage v0.2.7

L'action **« JKL Backup · Télécharger + renommer »** dans le menu contextuel Telegram, ou le bouton de téléchargement SOLO du panneau JKL, déclenche le téléchargement renommé via le moteur de Telegram WebK.

Exemples :
- `Canal Démo - 2026-10-12_00-34-21 - reunion originale.mp4`
- `Canal Démo - 2026-10-12_00-34-21 - photo_1234.jpg`

Le nom original est extrait des métadonnées `documentAttributeFilename` / `file_name` quand Telegram le fournit (vidéos et documents vidéo). Les photos normales de Telegram n'exposent généralement pas leur nom original : `photo_<ID>.jpg` sert de remplacement stable. Pour une vidéo sans nom source : `video_<ID>.<ext>`. Les caractères interdits sur Windows sont neutralisés. La date correspond au message Telegram et la convention horaire est celle du navigateur.

**Important :** cliquer sur **« Télécharger »** natif de Telegram ou **« Enregistrer l'image sous… »** dans Firefox ne déclenche pas notre traitement : le script ne modifie pas ces téléchargements. Ne pas attribuer au script JKL le nom d'un fichier issu d'une action native.

Le menu contextuel JKL reste expérimental : le test final consiste à constater le bon nom dans les téléchargements Firefox.

## Objectifs

- Téléchargement **SOLO** : bouton près de chaque média et depuis la visionneuse.
- Téléchargement **COMPLET** : pagination de l'historique multimédia accessible d'un canal, groupe ou conversation (v0.2.7, à valider en situation réelle).
- Albums et sélections, photos et vidéos en qualité originale lorsqu'elle est disponible.
- Renommage : `NomDuCompte - AAAA-MM-JJ_HH-mm-ss - NomOriginal.ext` (nom de la conversation/canal visible).
- File séquentielle, compteurs de progression, reprise et anti-doublons via manifeste local (v0.2.7).
- Interface discrète, stable et adaptée à Telegram Web.
- Déploiement via GitHub avec contrôle automatique des nouvelles versions.

## État de la version 0.2.0

| Fonction | Statut |
| --- | --- |
| Noms de fichiers avec date, média et ID | Implémenté ; tests unitaires |
| Filtrage photos, vidéos, GIF | Implémenté ; tests unitaires |
| Bouton d'ouverture et diagnostic WebK/WebA | Implémenté ; tests automatisés |
| Téléchargement unitaire depuis le menu ou un message survolé | Prototype ; **non testé sur Telegram Web** |
| Téléchargement de messages sélectionnés | Prototype ; **non testé sur Telegram Web** |
| Bouton intégré à la visionneuse | Non implémenté |
| Scan d'un canal complet / historique | Implémenté via API historique WebK ; test Firefox attendu |
| Albums sans sélection manuelle | Non implémenté |
| Reprise persistante et anti-doublons | Implémenté par manifeste de succès local |
| Progression de backup | Compteurs scan et téléchargements, arrêt manuel ; tests simulés |
| Dossier profil sur disque | Fonctionnement validé en Firefox / Browser API |

## Tests

Les contrôles sont exécutés par GitHub Actions à chaque push ou PR sur `main` : syntaxe JavaScript (`node --check`) et tests unitaires (`node tests/userscript.test.cjs`).

Ils ne prouvent pas la compatibilité du script avec la version de Telegram Web chargée dans Firefox.

## Mises à jour automatiques

Les métadonnées `@updateURL` et `@downloadURL` ciblent `main/JKL_Telegram_Backup.user.js`. Après installation depuis le dépôt, Tampermonkey vérifie les nouvelles versions selon ses propres réglages. **Chaque mise à jour publiée doit incrémenter `@version`.**

## Licence

MIT, voir [LICENSE](LICENSE).
