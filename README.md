# Flux solaire

Page animée des flux d'énergie de la maison : panneaux → maison, panneaux →
batterie virtuelle Urban Solar, batterie virtuelle → maison. Les valeurs
viennent de Gladys :

- **Production** : l'appareil ECU de l'intégration APsystems (mode Modbus),
  `ext:<sélecteur>:ecu:<id>:power`.
- **Réseau** : la puissance instantanée signée de gladys-ecojoko
  (`…:ecojoko-meter:…:power`, + soutirage, − injection).

Consommation = production + réseau ; injection = max(0, −réseau) ;
soutirage = max(0, réseau). Le solde de la batterie virtuelle est une
**estimation** : le solde saisi, plus l'énergie injectée, moins l'énergie
soutirée (intégrée toutes les 10 s, gardée dans `/data/battery.json`). Urban
Solar n'a pas d'API publique : recalez le solde depuis votre espace client.

## Installation (ZimaOS, Docker)

1. Dans Gladys, créez un **utilisateur dédié** (Paramètres > Utilisateurs).
2. Copiez `docker-compose.yml`, remplissez `GLADYS_URL`, `GLADYS_EMAIL`,
   `GLADYS_PASSWORD`, puis `docker compose up -d`.
3. Ouvrez `http://<NAS>:8085`.

Si la détection automatique se trompe, `http://<NAS>:8085/api/features`
liste les fonctionnalités de puissance de Gladys : copiez le `selector` voulu
dans `PRODUCTION_FEATURE` ou `GRID_FEATURE`. Si Ecojoko est inversé chez
vous, `GRID_SIGN=-1`.

## API

- `GET /api/flow` : les dernières valeurs et le solde estimé.
- `POST /api/battery` `{"kwh": 123.4}` : corrige le solde.
- `GET /api/features` : aide à la configuration.

Lecture seule vis-à-vis de Gladys. La page ne s'expose pas à Internet :
gardez-la sur le réseau local.
