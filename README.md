# JKL Telegram Backup

**Statut : prototype expérimental v0.1.4 — téléchargement non validé sur Telegram Web.**

Userscript Tampermonkey pour la sauvegarde et le renommage des photos et vidéos Telegram. L'objectif est de retrouver une expérience comparable à JKL Instagram Backup, adaptée à Telegram. Le prototype actuel vise **Telegram WebK uniquement**.

> **Attention :** des modules internes de Telegram WebK utilisés par cette version ne sont pas garantis accessibles depuis `window`. Les tests automatisés vérifient la logique de transformation et le code, **pas** les téléchargements dans une vraie session Telegram. Conserver le script Telegram qui fonctionne comme solution de secours.

## Installer le prototype

[**Installer JKL Telegram Backup v0.1.4 (Tampermonkey)**](https://raw.githubusercontent.com/JKL93sang/JKL-Telegram-backup/main/JKL_Telegram_Backup.user.js)

1. Activer Tampermonkey sur Firefox.
2. Désactiver temporairement le téléchargeur Telegram tiers pour éviter les interactions entre scripts (sans le supprimer).
3. Installer le lien ci-dessus en confirmant dans Tampermonkey.
4. Ouvrir [Telegram WebK](https://web.telegram.org/k/) et tester avec **une photo et une vidéo non sensibles**, puis une petite sélection.
5. Noter précisément si le bouton apparaît, l'erreur affichée et si le fichier est réellement sauvegardé.

## Interface et diagnostic v0.1.4

Le petit bouton **« ↓ JKL Telegram Backup v0.1.4 »** est visible en haut, près du centre de la page Telegram. Il ouvre un panneau affichant :
- si Telegram WebK (`/k/`) est utilisé ;
- si le moteur interne Telegram et la lecture des messages sont accessibles ;
- les actions expérimentales **Télécharger le média survolé** et **Télécharger la sélection** ;
- **Copier diagnostic** pour analyser un problème précis.

Si Telegram est ouvert sur `/a/`, le panneau propose un lien vers WebK ; les fonctions internes du script ne sont pas prévues pour WebA. Si le moteur ou la lecture apparaissent « indisponible », les boutons de téléchargement ne peuvent pas fonctionner sur cette session : le signaler avec le diagnostic pour adapter le code, sans multiplier les essais.

**Important :** l'interface visible est vérifiée par tests automatisés. Le téléchargement réel et la détection des messages restent non validés sur le navigateur de l'utilisateur.

## Correctifs v0.1.4

- **« Média ciblé » s'actualise pendant le survol**, sans refermer le panneau.
- Dans un album, le script cherche l'identifiant du média survolé (si le DOM Telegram l'expose).
- **Déplacer le panneau :** maintiens le clic gauche sur le bouton-titre « ↓ JKL Telegram Backup », glisse et relâche.
- La position est mémorisée localement pour les prochaines visites.
- Un glissement ne doit pas ouvrir/fermer le panneau ; un simple clic conserve ce comportement.

Les fonctions internes de téléchargement restent expérimentales, y compris le ciblage réel d'un album : cette version n'est pas encore une sauvegarde intégrale validée.

## Enregistrement renommé v0.1.4

La précédente implémentation transmettait `fileName` au téléchargement natif de Telegram WebK. **Pour les photos/vidéos, son mode streaming ne respectait pas ce nom** : Firefox enregistrait le nom d'origine.

En v0.1.4, l'action **JKL Backup** obtient le Blob complet via `downloadMedia` puis déclenche explicitement un lien temporaire `<a download="NomDuCompte - Date - NomOriginal.ext">`. Les tests vérifient le **nom effectivement transmis au navigateur**, pas seulement la chaîne calculée.

**Limites de sécurité :**
- **512 Mio maximum par média renommé** (le Blob doit tenir en mémoire). Au-delà, JKL affiche une erreur **avant** de demander le téléchargement. Il n'enregistre jamais silencieusement le nom original à la place.
- Une vidéo dont le poids téléchargé ne correspond pas au poids attendu est rejetée avant sauvegarde.
- Ne pas déduire d'une exécution CI verte que Firefox a bien écrit un fichier : vérifier une photo et une vidéo sur la vraie session Telegram.
- Le téléchargement natif Telegram/Firefox conserve son propre comportement.

## Renommage v0.1.4

L'action **« JKL Backup · Télécharger + renommer »** dans le menu contextuel Telegram, ou le bouton de téléchargement SOLO du panneau JKL, déclenche le téléchargement renommé via le moteur de Telegram WebK.

Exemples :
- `Canal Démo - 2026-10-12_00-34-21 - reunion originale.mp4`
- `Canal Démo - 2026-10-12_00-34-21 - photo_1234.jpg`

Le nom original est extrait des métadonnées `documentAttributeFilename` / `file_name` quand Telegram le fournit (vidéos et documents vidéo). Les photos normales de Telegram n'exposent généralement pas leur nom original : `photo_<ID>.jpg` sert de remplacement stable. Pour une vidéo sans nom source : `video_<ID>.<ext>`. Les caractères interdits sur Windows sont neutralisés. La date correspond au message Telegram et la convention horaire est celle du navigateur.

**Important :** cliquer sur **« Télécharger »** natif de Telegram ou **« Enregistrer l'image sous… »** dans Firefox ne déclenche pas notre traitement : le script ne modifie pas ces téléchargements. Ne pas attribuer au script JKL le nom d'un fichier issu d'une action native.

Le menu contextuel JKL reste expérimental : le test final consiste à constater le bon nom dans les téléchargements Firefox.

## Objectifs

- Téléchargement **SOLO** : bouton près de chaque média et depuis la visionneuse.
- Téléchargement **COMPLET** : scan de l'historique accessible d'un canal, groupe ou conversation.
- Albums et sélections, photos et vidéos en qualité originale lorsqu'elle est disponible.
- Renommage : `NomDuCompte - AAAA-MM-JJ_HH-mm-ss - NomOriginal.ext` (nom de la conversation/canal visible).
- Files d'attente, progression, reprise, anti-doublons et diagnostic des erreurs.
- Interface discrète, stable et adaptée à Telegram Web.
- Déploiement via GitHub avec contrôle automatique des nouvelles versions.

## État de la version 0.1.0

| Fonction | Statut |
| --- | --- |
| Noms de fichiers avec date, média et ID | Implémenté ; tests unitaires |
| Filtrage photos, vidéos, GIF | Implémenté ; tests unitaires |
| Bouton d'ouverture et diagnostic WebK/WebA | Implémenté ; tests automatisés |
| Téléchargement unitaire depuis le menu ou un message survolé | Prototype ; **non testé sur Telegram Web** |
| Téléchargement de messages sélectionnés | Prototype ; **non testé sur Telegram Web** |
| Bouton intégré à la visionneuse | Non implémenté |
| Scan d'un canal complet / historique | Non implémenté |
| Albums sans sélection manuelle | Non implémenté |
| Reprise persistante et anti-doublons | Non implémenté |
| Interface de progression par fichier | Non implémenté |
| Arborescence sur disque | Non implémenté |

## Tests

Les contrôles sont exécutés par GitHub Actions à chaque push ou PR sur `main` : syntaxe JavaScript (`node --check`) et tests unitaires (`node tests/userscript.test.cjs`).

Ils ne prouvent pas la compatibilité du script avec la version de Telegram Web chargée dans Firefox.

## Mises à jour automatiques

Les métadonnées `@updateURL` et `@downloadURL` ciblent `main/JKL_Telegram_Backup.user.js`. Après installation depuis le dépôt, Tampermonkey vérifie les nouvelles versions selon ses propres réglages. **Chaque mise à jour publiée doit incrémenter `@version`.**

## Licence

MIT, voir [LICENSE](LICENSE).
