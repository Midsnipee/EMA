// -----------------------------------------------------------------------------
// Flux solaire: a tiny service that reads two Gladys features (the solar
// production of the APsystems ECU, the signed grid power of Ecojoko) through
// the Gladys local REST API, and serves an animated page of the energy flows
// (panels -> house, panels -> Urban Solar virtual battery, battery -> house).
// Node 22, no dependency. Read-only towards Gladys.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (key, fallback) => process.env[key] ?? fallback;
const CONFIG = {
  gladysUrl: env('GLADYS_URL', 'http://192.168.1.10').replace(/\/+$/, ''),
  email: env('GLADYS_EMAIL', ''),
  password: env('GLADYS_PASSWORD', ''),
  // A feature selector or external id; empty = found automatically.
  production: env('PRODUCTION_FEATURE', ''),
  grid: env('GRID_FEATURE', ''),
  // Ecojoko: + when drawing from the grid, - when injecting. Set -1 if yours is the other way.
  gridSign: Number(env('GRID_SIGN', '1')) < 0 ? -1 : 1,
  pollSeconds: Math.max(5, Number(env('POLL_SECONDS', '10')) || 10),
  batteryStartKwh: Number(env('BATTERY_START_KWH', '0')) || 0,
  port: Number(env('PORT', '8080')) || 8080,
  dataDir: env('DATA_DIR', '/data'),
};

const here = dirname(fileURLToPath(import.meta.url));
const log = (...args) => console.log(new Date().toISOString(), ...args);

// --- Gladys API ----------------------------------------------------------------

let token;

async function login() {
  const res = await fetch(`${CONFIG.gladysUrl}/api/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: CONFIG.email, password: CONFIG.password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Gladys login failed (HTTP ${res.status}): check GLADYS_EMAIL / GLADYS_PASSWORD`);
  }
  const body = await res.json();
  token = body.access_token;
  if (!token) {
    throw new Error('Gladys login answered without an access_token');
  }
  log('logged in to Gladys');
}

async function api(path) {
  if (!token) {
    await login();
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${CONFIG.gladysUrl}/api/v1${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 && attempt === 0) {
      // Expired (24 h): a fresh login is simpler and more reliable than the refresh route.
      await login();
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gladys ${path}: HTTP ${res.status}`);
    }
    return res.json();
  }
  throw new Error(`Gladys ${path}: unauthorized`);
}

// --- Finding the two features ---------------------------------------------------

const allFeatures = (devices) =>
  devices.flatMap((d) =>
    (d.features ?? []).map((f) => ({ ...f, deviceName: d.name, deviceExternalId: d.external_id })),
  );

const matches = (f, wanted) => f.selector === wanted || f.external_id === wanted;
const isPower = (f) => f.type === 'power' || /power/i.test(f.external_id ?? '');

function pickProduction(features) {
  if (CONFIG.production) {
    return features.find((f) => matches(f, CONFIG.production));
  }
  // The ECU device of the APsystems integration: ext:<selector>:ecu:<ECU id>:power
  // (the selector depends on how it was installed: store or developer mode).
  return features.find((f) => /^ext:[^:]+:ecu:[0-9A-Za-z]{12}:power$/.test(f.external_id ?? ''));
}

function pickGrid(features) {
  if (CONFIG.grid) {
    return features.find((f) => matches(f, CONFIG.grid));
  }
  // gladys-ecojoko: ext:<selector>:ecojoko-meter:<gateway>-<meter>:power, the signed
  // grid exchange (grid-sensor/power, import > 0, export < 0).
  const exact = features.find((f) => /:ecojoko-meter:[^:]+:power$/.test(f.external_id ?? ''));
  if (exact) {
    return exact;
  }
  const ecojoko = features.filter(
    (f) => /ecojoko/i.test(`${f.external_id} ${f.deviceExternalId}`) && isPower(f),
  );
  return ecojoko.find((f) => (f.min ?? 0) < 0) ?? ecojoko[0];
}

// --- The virtual battery estimate (kept across restarts) ------------------------

const batteryFile = () => join(CONFIG.dataDir, 'battery.json');
const battery = { kwh: CONFIG.batteryStartKwh, setAt: null, lastAt: null, lastGridW: null };

async function loadBattery() {
  try {
    const saved = JSON.parse(await readFile(batteryFile(), 'utf8'));
    if (Number.isFinite(saved.kwh)) {
      Object.assign(battery, { kwh: saved.kwh, setAt: saved.setAt ?? null });
    }
  } catch {
    // First start: the configured starting balance.
  }
}

async function saveBattery() {
  try {
    await mkdir(CONFIG.dataDir, { recursive: true });
    const tmp = `${batteryFile()}.tmp`;
    await writeFile(tmp, JSON.stringify({ kwh: battery.kwh, setAt: battery.setAt }));
    await rename(tmp, batteryFile());
  } catch (err) {
    log('cannot save the battery estimate:', err.message);
  }
}

/** Trapezoid between two grid readings: export (-) fills the battery, import (+) empties it. */
function integrateBattery(gridW, at) {
  if (battery.lastAt !== null && battery.lastGridW !== null) {
    const hours = (at - battery.lastAt) / 3_600_000;
    // A gap longer than 10 minutes (Gladys down, restart) is not guessed.
    if (hours > 0 && hours < 1 / 6) {
      const mean = (gridW + battery.lastGridW) / 2;
      battery.kwh = Math.max(0, battery.kwh - (mean * hours) / 1000);
    }
  }
  battery.lastAt = at;
  battery.lastGridW = gridW;
}

// --- Polling --------------------------------------------------------------------

const latest = {
  ok: false,
  error: 'starting',
  at: null,
  production: null,
  grid: null,
};

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

async function poll() {
  try {
    const features = allFeatures(await api('/device'));
    const prod = pickProduction(features);
    const grid = pickGrid(features);
    if (!prod || !grid) {
      throw new Error(
        `${prod ? '' : 'production feature not found (PRODUCTION_FEATURE) '}${grid ? '' : 'Ecojoko power feature not found (GRID_FEATURE)'}`.trim(),
      );
    }
    const at = Date.now();
    const gridW = num(grid.last_value) === null ? null : CONFIG.gridSign * num(grid.last_value);
    if (gridW !== null) {
      integrateBattery(gridW, at);
    }
    Object.assign(latest, {
      ok: true,
      error: null,
      at,
      production: {
        name: prod.deviceName,
        selector: prod.selector,
        watts: Math.max(0, num(prod.last_value) ?? 0),
        changedAt: prod.last_value_changed ?? null,
      },
      grid: {
        name: grid.deviceName,
        selector: grid.selector,
        watts: gridW,
        changedAt: grid.last_value_changed ?? null,
      },
    });
  } catch (err) {
    if (latest.error !== err.message) {
      log('poll:', err.message);
    }
    Object.assign(latest, { ok: false, error: err.message });
  }
}

// --- HTTP -----------------------------------------------------------------------

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024) {
      throw new Error('body too large');
    }
  }
  return JSON.parse(raw || '{}');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, await readFile(join(here, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/flow') {
      return send(res, 200, {
        ...latest,
        battery: { kwh: Number(battery.kwh.toFixed(3)), setAt: battery.setAt },
        pollSeconds: CONFIG.pollSeconds,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/battery') {
      const { kwh } = await readJson(req);
      if (!Number.isFinite(kwh) || kwh < 0 || kwh > 100_000) {
        return send(res, 400, { error: 'kwh: a number between 0 and 100000' });
      }
      Object.assign(battery, { kwh, setAt: new Date().toISOString() });
      await saveBattery();
      return send(res, 200, { kwh });
    }
    if (req.method === 'GET' && url.pathname === '/api/features') {
      // Help to fill PRODUCTION_FEATURE / GRID_FEATURE: every power-like feature.
      const features = allFeatures(await api('/device')).filter(isPower);
      return send(
        res,
        200,
        features.map((f) => ({
          device: f.deviceName,
          name: f.name,
          selector: f.selector,
          external_id: f.external_id,
          last_value: f.last_value,
        })),
      );
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

await loadBattery();
setInterval(saveBattery, 60_000).unref();
await poll();
setInterval(poll, CONFIG.pollSeconds * 1000);
server.listen(CONFIG.port, () => log(`flux solaire on :${CONFIG.port}, Gladys ${CONFIG.gladysUrl}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await saveBattery();
    process.exit(0);
  });
}
