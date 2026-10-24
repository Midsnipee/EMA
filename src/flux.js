// -----------------------------------------------------------------------------
// Pure part of the Flux solaire integration: the figures from the flux-solaire
// service (/api/flow), the Gladys device and its states, the picture of the
// flows (SVG, no text: the numbers are tiles) and the widget content.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';

/** Feature keys (forever: stored in scenes and dashboards). */
export const FEATURE = {
  PRODUCTION: 'production',
  CONSUMPTION: 'consumption',
  SOLAR_TO_HOME: 'solar_to_home',
  CHARGE: 'battery_charge',
  DISCHARGE: 'battery_discharge',
  REMAINING: 'battery_remaining',
  SELF_CONSUMPTION: 'self_consumption',
};

export const WIDGET = 'flux';

/**
 * The flows from one /api/flow answer. The grid power is signed: + drawn
 * from the grid (the virtual battery gives back), - injected (it stores).
 */
export function flowsOf(data) {
  const production = Math.max(0, Number(data?.production?.watts) || 0);
  const grid = Number(data?.grid?.watts) || 0;
  const charge = Math.max(0, -grid);
  const discharge = Math.max(0, grid);
  const solarToHome = Math.max(0, production - charge);
  const consumption = Math.max(0, production + grid);
  return {
    production: Math.round(production),
    consumption: Math.round(consumption),
    solarToHome: Math.round(solarToHome),
    charge: Math.round(charge),
    discharge: Math.round(discharge),
    remaining: Number.isFinite(data?.battery?.kwh) ? Number(data.battery.kwh.toFixed(2)) : null,
    selfConsumption: production > 0 ? Math.round((solarToHome / production) * 100) : null,
    productionAt: data?.production?.changedAt ?? null,
    gridAt: data?.grid?.changedAt ?? null,
  };
}

const feature = (deviceId, key, name, category, type, unit, max, min = 0) => ({
  name,
  external_id: `${deviceId}:${key}`,
  category,
  type,
  unit,
  min,
  max,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

/** The one device: the flows of the house, read-only. */
export function buildDevice(deviceId) {
  return {
    name: 'Flux solaire',
    external_id: deviceId,
    features: [
      feature(deviceId, FEATURE.PRODUCTION, 'Production solaire', C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER, U.WATT, 100_000),
      feature(deviceId, FEATURE.CONSUMPTION, 'Consommation maison', C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, U.WATT, 100_000),
      // Panels -> house: no core type means "self-consumed power"; a plain decimal in W.
      feature(deviceId, FEATURE.SOLAR_TO_HOME, 'Solaire consommé sur place', C.UNKNOWN, T.UNKNOWN.UNKNOWN, U.WATT, 100_000),
      // The Urban Solar virtual battery, as a battery storage: injection charges it, drawing discharges it.
      feature(deviceId, FEATURE.CHARGE, 'Injection vers la batterie virtuelle', C.BATTERY_STORAGE, T.BATTERY_STORAGE.CHARGE_POWER, U.WATT, 100_000),
      feature(deviceId, FEATURE.DISCHARGE, 'Soutirage de la batterie virtuelle', C.BATTERY_STORAGE, T.BATTERY_STORAGE.DISCHARGE_POWER, U.WATT, 100_000),
      feature(deviceId, FEATURE.REMAINING, 'Solde estimé de la batterie virtuelle', C.BATTERY_STORAGE, T.BATTERY_STORAGE.BATTERY_ENERGY_REMAINING, U.KILOWATT_HOUR, 1_000_000),
      feature(deviceId, FEATURE.SELF_CONSUMPTION, 'Autoconsommation', C.UNKNOWN, T.UNKNOWN.UNKNOWN, U.PERCENT, 100),
    ],
  };
}

export function statesOf(deviceId, f) {
  const pairs = [
    [FEATURE.PRODUCTION, f.production],
    [FEATURE.CONSUMPTION, f.consumption],
    [FEATURE.SOLAR_TO_HOME, f.solarToHome],
    [FEATURE.CHARGE, f.charge],
    [FEATURE.DISCHARGE, f.discharge],
    [FEATURE.REMAINING, f.remaining],
    [FEATURE.SELF_CONSUMPTION, f.selfConsumption],
  ];
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && Number.isFinite(v))
    .map(([key, state]) => ({ device_feature_external_id: `${deviceId}:${key}`, state }));
}

// --- The widget ---------------------------------------------------------------------

/**
 * The widget: the picture (diagram and readings, see src/picture.js), and a
 * link to the animated page when it has an https address (Gladys opens
 * nothing else). The figures also live on the device, for scenes and charts.
 */
export function widgetContent({ flows, imageKey, pageUrl, error, preparing = false }) {
  if (!flows || !imageKey) {
    return {
      ttl_seconds: 30,
      components: [
        {
          type: 'text',
          variant: 'body',
          text: error
            ? `Le service flux-solaire ne répond pas : ${error}`
            : preparing
              ? 'Préparation du schéma…'
              : 'En attente de la première lecture du service flux-solaire.',
        },
      ],
    };
  }
  const components = [
    { type: 'image', key: imageKey, fit: 'contain', alt: 'Flux : panneaux, maison et batterie virtuelle Urban Solar' },
  ];
  if (error) {
    components.push({ type: 'text', variant: 'caption', text: `Dernière lecture en échec : ${error}`.slice(0, 80) });
  }
  if (pageUrl && /^https:\/\//i.test(pageUrl)) {
    components.push({ type: 'button', label: "Voir l'animation", icon: 'play', style: 'secondary', link: { url: pageUrl } });
  }
  return { ttl_seconds: 15, components };
}
