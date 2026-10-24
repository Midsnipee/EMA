// -----------------------------------------------------------------------------
// Pure part of the Flux solaire integration: the figures from the flux-solaire
// service (/api/flow), the Gladys device and its states, the picture of the
// flows (SVG, no text: the numbers are tiles) and the widget content.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
  WIDGET_COLORS,
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

// --- The picture ------------------------------------------------------------------

/** Watts to a stroke width: visible from 5 W, capped. */
const width = (w) => (w < 5 ? 0 : Math.min(22, 4 + w / 180));
/** Watts rounded for the image key: a new picture only when the drawing changes. */
const bucket = (w) => (w < 5 ? 0 : Math.round(w / 50));

export function imageKeyOf(f) {
  const sig = [f.solarToHome, f.charge, f.discharge].map(bucket).join('-');
  return `flux-${createHash('sha1').update(sig).digest('hex').slice(0, 12)}`;
}

const COLORS = { sun: '#e39b2d', home: '#22a08a', store: '#8a6ce0', track: '#8a96a5' };

function arrow(d, w, color, id) {
  if (w <= 0) {
    return `<path d="${d}" fill="none" stroke="${COLORS.track}" stroke-opacity="0.35" stroke-width="4" stroke-linecap="round" stroke-dasharray="2 14"/>`;
  }
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w.toFixed(1)}" stroke-linecap="round" marker-end="url(#${id})"/>`;
}

/** The flows as an 800 x 450 SVG (16:9, the widget's frame), transparent, no text. */
export function svgOf(f) {
  const w = { sh: width(f.solarToHome), sb: width(f.charge), bh: width(f.discharge) };
  const marker = (id, color) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3" markerHeight="3" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${color}"/></marker>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="800" height="450">
<defs>${marker('a-sun', COLORS.sun)}${marker('a-store', COLORS.store)}</defs>
${arrow('M360 150 C 290 220, 230 260, 205 300', w.sh, COLORS.sun, 'a-sun')}
${arrow('M440 150 C 510 220, 570 260, 595 300', w.sb, COLORS.sun, 'a-sun')}
${arrow('M540 375 L 270 375', w.bh, COLORS.store, 'a-store')}
<g transform="translate(400 85)">
  <circle cx="92" cy="-40" r="24" fill="${COLORS.sun}"/>
  <path d="M-86 40 L-60 -36 L60 -36 L86 40 Z" fill="${COLORS.sun}" fill-opacity="0.15" stroke="${COLORS.sun}" stroke-width="5" stroke-linejoin="round"/>
  <g stroke="${COLORS.sun}" stroke-width="3.5"><line x1="-20" y1="-36" x2="-29" y2="40"/><line x1="20" y1="-36" x2="29" y2="40"/><line x1="-73" y1="2" x2="73" y2="2"/></g>
  <line x1="0" y1="40" x2="0" y2="62" stroke="${COLORS.sun}" stroke-width="5"/>
</g>
<g transform="translate(170 360)">
  <path d="M-72 6 L0 -56 L72 6 L72 72 L-72 72 Z" fill="${COLORS.home}" fill-opacity="0.15" stroke="${COLORS.home}" stroke-width="5" stroke-linejoin="round"/>
  <rect x="-18" y="28" width="36" height="44" fill="${COLORS.home}"/>
</g>
<g transform="translate(630 365)">
  <rect x="-58" y="-46" width="116" height="112" rx="16" fill="${COLORS.store}" fill-opacity="0.15" stroke="${COLORS.store}" stroke-width="5"/>
  <rect x="-20" y="-62" width="40" height="16" rx="5" fill="${COLORS.store}"/>
  <path d="M-9 -22 L-22 12 L0 12 L-9 48 L22 2 L0 2 L9 -22 Z" fill="${COLORS.store}"/>
</g>
</svg>`;
}

// --- The widget ---------------------------------------------------------------------

const ago = (iso, now) => {
  if (!iso) {
    return '—';
  }
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  return s < 90 ? `il y a ${Math.round(s)} s` : `il y a ${Math.round(s / 60)} min`;
};

/**
 * The widget: live tiles bound to the device features (when the device is
 * created), else the last figures inline; the picture; when it was read; a
 * link to the animated page when it has an https address.
 */
export function widgetContent({ flows, deviceId, created, imageKey, pageUrl, error, now = Date.now() }) {
  if (!flows) {
    return {
      ttl_seconds: 30,
      components: [
        { type: 'text', variant: 'heading', text: 'Flux solaire' },
        {
          type: 'text',
          variant: 'body',
          text: error ? `Le service flux-solaire ne répond pas : ${error}` : 'En attente de la première lecture.',
        },
      ],
    };
  }
  const tile = (key, label, icon, value, unit, color) =>
    created
      ? { type: 'value', label, icon, color, device_feature: `${deviceId}:${key}` }
      : { type: 'value', label, icon, color, value: value ?? '—', unit };
  const components = [
    tile(FEATURE.PRODUCTION, 'Production', 'sun', flows.production, 'W', WIDGET_COLORS.WARNING),
    tile(FEATURE.CONSUMPTION, 'Maison', 'home', flows.consumption, 'W', WIDGET_COLORS.SUCCESS),
    tile(FEATURE.CHARGE, 'Vers Urban Solar', 'arrow-up-right', flows.charge, 'W', WIDGET_COLORS.PRIMARY),
    tile(FEATURE.DISCHARGE, 'Depuis Urban Solar', 'arrow-down-left', flows.discharge, 'W', WIDGET_COLORS.INFO),
    tile(FEATURE.REMAINING, 'Solde estimé', 'battery', flows.remaining, 'kWh', WIDGET_COLORS.PRIMARY),
    tile(FEATURE.SELF_CONSUMPTION, 'Autoconso.', 'percent', flows.selfConsumption, '%', WIDGET_COLORS.SUCCESS),
    {
      type: 'image',
      key: imageKey,
      fit: 'contain',
      alt: 'Flux : panneaux vers maison et batterie virtuelle',
    },
    {
      type: 'status',
      items: [
        {
          label: 'Production lue',
          value: ago(flows.productionAt, now),
          color: error ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
        },
        { label: 'Ecojoko lu', value: ago(flows.gridAt, now), color: WIDGET_COLORS.NEUTRAL },
      ],
    },
  ];
  if (pageUrl && /^https:\/\//i.test(pageUrl)) {
    // The budget is 8 components: the link takes the place of the freshness list.
    components[components.length - 1] = {
      type: 'button',
      label: "Voir l'animation",
      icon: 'play',
      style: 'secondary',
      link: { url: pageUrl },
    };
  }
  return { ttl_seconds: 15, components };
}
