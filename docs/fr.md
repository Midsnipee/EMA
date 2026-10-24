# Flux solaire

Affiche dans Gladys les flux d'énergie de la maison : panneaux → maison,
panneaux → batterie virtuelle Urban Solar, batterie virtuelle → maison.

## Prérequis

Le **service flux-solaire** tourne sur votre réseau (conteneur
`ghcr.io/midsnipee/ema:flux-solaire`, par exemple sur un NAS). Il lit dans
Gladys la puissance de l'ECU APsystems et la puissance instantanée Ecojoko,
et tient le solde estimé de la batterie virtuelle. Cette intégration lit ce
service, rien d'autre.

## Configuration

1. **Adresse du service flux-solaire** : `http://<NAS>:8085`.
2. **Page animée** (facultatif) : une adresse **https** de la page animée,
   pour un bouton « Voir l'animation ». Gladys n'ouvre que des liens https.
3. Enregistrez, cliquez sur **Tester le service**, puis ouvrez
   **Découverte** et créez l'appareil **Flux solaire**.
4. Dans le tableau de bord, ajoutez le widget **Flux solaire**.

## L'appareil

| Fonctionnalité | Unité |
|---|---|
| Production solaire | W |
| Consommation maison | W |
| Solaire consommé sur place | W |
| Injection vers la batterie virtuelle | W |
| Soutirage de la batterie virtuelle | W |
| Solde estimé de la batterie virtuelle | kWh |
| Autoconsommation | % |

Utilisables dans les scènes (par exemple : injection > 1 000 W → lancer le
lave-linge). Le solde est une estimation tenue par le service : recalez-le
depuis la page du service.

## Le widget

Six tuiles en direct, le schéma des flux (l'épaisseur des flèches suit les
watts ; des points défilent le long des flèches, plus vite quand la puissance monte : une image WebP animée) et
l'heure des dernières lectures.

## Dépannage

- **« Le service flux-solaire ne répond pas »** : l'adresse est fausse ou le
  conteneur est arrêté. Ouvrez l'adresse dans un navigateur.
- **« le service n'arrive pas à lire Gladys »** : voir les journaux du
  conteneur flux-solaire (identifiants Gladys, fonctionnalités introuvables).
- **Les tuiles affichent « — »** : l'appareil n'est pas encore créé
  (Découverte).
