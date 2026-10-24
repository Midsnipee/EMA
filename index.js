// -----------------------------------------------------------------------------
// Flux solaire for Gladys: reads the flux-solaire service of the house (its
// /api/flow, on the local network), exposes one device with the flows and a
// dashboard widget with the picture of them. Read-only.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { renderImage } from './src/render.js';
import {
  WIDGET,
  buildDevice,
  flowsOf,
  imageKeyOf,
  statesOf,
  svgOf,
  widgetContent,
} from './src/flux.js';

const gladys = new GladysIntegration();
const DEVICE = gladys.externalIds('house', 'main').device;

const state = {
  config: { service_url: '', page_url: '', poll_interval: 15 },
  flows: null,
  error: null,
  timer: null,
  images: new Map(), // key -> Promise of the base64 animated WebP, the last few
  created: false,
};

function normalize(raw = {}) {
  const interval = Math.min(300, Math.max(10, Math.round(Number(raw.poll_interval) || 15)));
  return {
    service_url: String(raw.service_url ?? '').trim().replace(/\/+$/, ''),
    page_url: String(raw.page_url ?? '').trim(),
    poll_interval: interval,
  };
}

/** The animated picture of the flows, rendered once per key (a new key when the drawing changes). */
function render(flows) {
  const key = imageKeyOf(flows);
  if (!state.images.has(key)) {
    state.images.set(
      key,
      renderImage(flows).catch((err) => {
        state.images.delete(key);
        throw err;
      }),
    );
    // The core caches an image an hour by key: keep only the recent ones here.
    while (state.images.size > 20) {
      state.images.delete(state.images.keys().next().value);
    }
  }
  return key;
}

async function refreshCreated() {
  const devices = await gladys.getDevices();
  state.created = devices.some((d) => d.external_id === DEVICE);
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
    const before = state.flows ? imageKeyOf(state.flows) : null;
    state.flows = flowsOf(data);
    state.error = null;
    if (state.created) {
      await gladys.publishChangedStates(statesOf(DEVICE, state.flows), { heartbeat: 15 * 60_000 });
    }
    await gladys.setConnectionStatus(true, {
      en: `Production ${state.flows.production} W, house ${state.flows.consumption} W.`,
      fr: `Production ${state.flows.production} W, maison ${state.flows.consumption} W.`,
    });
    if (before !== imageKeyOf(state.flows)) {
      // Rendered before the nudge: the widget asks for the image right after.
      await state.images.get(render(state.flows)).catch((e) => logger.warn(`image: ${e.message}`));
      gladys.requestWidgetRefresh(WIDGET);
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
  await gladys.publishDiscoveredDevices([buildDevice(DEVICE)]);
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
gladys.onScanRequest(() => gladys.publishDiscoveredDevices([buildDevice(DEVICE)]));
gladys.onDeviceCreated(async () => {
  await refreshCreated();
  if (state.flows) {
    await gladys.publishChangedStates(statesOf(DEVICE, state.flows));
  }
});
gladys.onDeviceDeleted(() => refreshCreated());
gladys.onWidgetGet(WIDGET, () =>
  widgetContent({
    flows: state.flows,
    deviceId: DEVICE,
    created: state.created,
    imageKey: state.flows ? render(state.flows) : undefined,
    pageUrl: state.config.page_url,
    error: state.error,
  }),
);
gladys.onWidgetGetImage(async (key) => {
  const image = state.images.get(key) ?? (state.flows ? state.images.get(render(state.flows)) : undefined);
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
