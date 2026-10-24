// -----------------------------------------------------------------------------
// Flux solaire for Gladys: reads the flux-solaire service of the house (its
// /api/flow, on the local network), exposes one device with the flows and a
// dashboard widget with the picture of them. Read-only.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { renderPicture } from './src/render.js';
import { labelsOf, pictureKey } from './src/picture.js';
import {
  WIDGET,
  batteryStatesOf,
  buildBatteryDevice,
  buildDevice,
  flowsOf,
  statesOf,
  widgetContent,
} from './src/flux.js';

const TIME_ZONE = process.env.TZ || 'Europe/Paris';
const themeOf = (settings) => (settings?.theme === 'light' ? 'light' : 'dark');

const gladys = new GladysIntegration();
const DEVICE = gladys.externalIds('house', 'main').device;
const BATTERY = gladys.externalIds('battery', 'urban-solar').device;
const discovered = () => [buildDevice(DEVICE), buildBatteryDevice(BATTERY)];

const state = {
  config: { service_url: '', page_url: '', poll_interval: 15 },
  flows: null,
  error: null,
  timer: null,
  images: new Map(), // key -> base64 picture, finished ones only, the last few
  ready: new Map(), // theme -> key of its last finished picture
  themes: new Set(['dark']), // the themes the widgets asked for
  rendering: Promise.resolve(), // one render at a time: it is CPU work on the Gladys host
  pending: new Map(), // theme -> key being rendered
  created: false,
  batteryCreated: false,
};

function normalize(raw = {}) {
  const interval = Math.min(300, Math.max(10, Math.round(Number(raw.poll_interval) || 15)));
  return {
    service_url: String(raw.service_url ?? '').trim().replace(/\/+$/, ''),
    page_url: String(raw.page_url ?? '').trim(),
    poll_interval: interval,
  };
}

/**
 * Render the picture of the current flows for a theme, in the background,
 * one render at a time. The widget never waits for it: it shows the last
 * finished picture, and is nudged once the new one is ready.
 */
function scheduleRender(theme) {
  if (!state.flows) {
    return Promise.resolve();
  }
  const flows = state.flows;
  const labels = labelsOf(flows, { now: new Date(), timeZone: TIME_ZONE });
  const key = pictureKey(flows, theme, labels);
  if (state.ready.get(theme) === key || state.pending.get(theme) === key) {
    return state.rendering;
  }
  state.pending.set(theme, key);
  state.rendering = state.rendering.then(async () => {
    const started = Date.now();
    try {
      state.images.set(key, await renderPicture(flows, { theme, labels }));
      // The core caches an image an hour by key: keep only the recent ones here.
      while (state.images.size > 12) {
        state.images.delete(state.images.keys().next().value);
      }
      state.ready.set(theme, key);
      const ms = Date.now() - started;
      if (ms > 5000) {
        logger.warn(`picture (${theme}) took ${ms} ms`);
      }
      gladys.requestWidgetRefresh(WIDGET);
    } catch (err) {
      logger.warn(`picture (${theme}): ${err.message}`);
    } finally {
      if (state.pending.get(theme) === key) {
        state.pending.delete(theme);
      }
    }
  });
  return state.rendering;
}

async function refreshCreated() {
  const devices = await gladys.getDevices();
  state.created = devices.some((d) => d.external_id === DEVICE);
  state.batteryCreated = devices.some((d) => d.external_id === BATTERY);
}

async function poll() {
  const url = state.config.service_url;
  if (!url) {
    await gladys.setConnectionStatus(false, {
      en: 'Type the address of the flux-solaire service (http://<NAS>:8085).',
      fr: "Saisissez l'adresse du service flux-solaire (http://<NAS>:8085).",
    });
    return;
  }
  try {
    const res = await fetch(`${url}/api/flow`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`le service n'arrive pas à lire Gladys (${data.error})`);
    }
    const before = state.flows ? JSON.stringify(state.flows) : null;
    state.flows = flowsOf(data);
    state.error = null;
    const states = [
      ...(state.created ? statesOf(DEVICE, state.flows) : []),
      ...(state.batteryCreated ? batteryStatesOf(BATTERY, state.flows) : []),
    ];
    if (states.length > 0) {
      await gladys.publishChangedStates(states, { heartbeat: 15 * 60_000 });
    }
    await gladys.setConnectionStatus(true, {
      en: `Production ${state.flows.production} W, house ${state.flows.consumption} W.`,
      fr: `Production ${state.flows.production} W, maison ${state.flows.consumption} W.`,
    });
    if (before !== JSON.stringify(state.flows)) {
      // New pictures in the background; the widgets are nudged when they are ready.
      for (const theme of state.themes) {
        scheduleRender(theme);
      }
    }
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'pas de réponse en 8 s' : err.message;
    if (state.error !== message) {
      logger.warn(`flux-solaire ${url}: ${message}`);
    }
    state.error = message;
    await gladys.setConnectionStatus(false, {
      en: `The flux-solaire service at ${url} does not answer: ${message}. Check the address and that the container runs.`,
      fr: `Le service flux-solaire (${url}) ne répond pas : ${message}. Vérifiez l'adresse et que le conteneur tourne.`,
    });
  }
}

async function start(raw) {
  stop();
  state.config = normalize(raw);
  await gladys.publishDiscoveredDevices(discovered());
  await refreshCreated();
  await poll();
  state.timer = setInterval(() => poll().catch((e) => logger.error(e)), state.config.poll_interval * 1000);
  state.timer.unref?.();
}

function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

// --- Handlers, before connect() ------------------------------------------------------
gladys.onScanRequest(() => gladys.publishDiscoveredDevices(discovered()));
gladys.onDeviceCreated(async () => {
  await refreshCreated();
  if (state.flows) {
    await gladys.publishChangedStates([
      ...(state.created ? statesOf(DEVICE, state.flows) : []),
      ...(state.batteryCreated ? batteryStatesOf(BATTERY, state.flows) : []),
    ]);
  }
});
gladys.onDeviceDeleted(() => refreshCreated());
gladys.onWidgetGet(WIDGET, async ({ settings }) => {
  const theme = themeOf(settings);
  state.themes.add(theme);
  if (state.flows && !state.ready.has(theme)) {
    // First picture of this theme: wait a little, never up to the core's deadline.
    await Promise.race([scheduleRender(theme), new Promise((r) => setTimeout(r, 4000))]);
  } else {
    scheduleRender(theme);
  }
  const imageKey = state.ready.get(theme);
  return widgetContent({
    flows: state.flows,
    imageKey: imageKey && state.images.has(imageKey) ? imageKey : undefined,
    pageUrl: state.config.page_url,
    error: state.error,
    preparing: Boolean(state.flows),
  });
});
gladys.onWidgetGetImage(async (key) => {
  const image = state.images.get(key);
  if (!image) {
    throw new Error(`unknown image ${key}`);
  }
  return image;
});
gladys.onAction('test_connection', async () => {
  await poll();
  if (state.error) {
    return { en: `No answer: ${state.error}`, fr: `Pas de réponse : ${state.error}` };
  }
  const f = state.flows;
  return {
    en: `OK. Production ${f.production} W, house ${f.consumption} W, to Urban Solar ${f.charge} W, from Urban Solar ${f.discharge} W.`,
    fr: `OK. Production ${f.production} W, maison ${f.consumption} W, vers Urban Solar ${f.charge} W, depuis Urban Solar ${f.discharge} W.`,
  };
});
gladys.onConfigUpdated((config) => start(config));
gladys.on('connected', async () => {
  try {
    await start(await gladys.getConfig());
  } catch (err) {
    logger.error('start failed', err);
  }
});
gladys.on('disconnected', stop);
gladys.handleShutdown(stop);

gladys.connect().catch((err) => {
  logger.error('connection failed', err);
  process.exit(1);
});
