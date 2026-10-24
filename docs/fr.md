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

## La batterie virtuelle Urban Solar

Un second appareil, **Batterie virtuelle Urban Solar**, avec l'énergie du
jour : **Envoyé vers la batterie aujourd'hui** (kWh injectés) et **Pris sur
la batterie aujourd'hui** (kWh soutirés). Le service flux-solaire les calcule
à partir de la puissance Ecojoko toutes les 10 s et les remet à zéro à
minuit. Une coupure de plus de 10 minutes du service n'est pas comptée.

## Le widget

Le schéma de la page flux-solaire : panneaux, maison et batterie virtuelle, des points qui défilent le long des flèches (plus vite quand la puissance monte), les valeurs sur les flèches, et à droite les quatre mesures (production, consommation, Ecojoko, autoconsommation) avec l'heure de la dernière lecture. C'est une image WebP animée : réglage **Thème du schéma** (sombre ou clair) dans les paramètres du widget, à accorder au thème de Gladys. Sur PC, placez le widget dans une colonne étroite du tableau de bord pour qu'il ne prenne pas toute la largeur.

## Dépannage

- **« Le service flux-solaire ne répond pas »** : l'adresse est fausse ou le
  conteneur est arrêté. Ouvrez l'adresse dans un navigateur.
- **« le service n'arrive pas à lire Gladys »** : voir les journaux du
  conteneur flux-solaire (identifiants Gladys, fonctionnalités introuvables).
