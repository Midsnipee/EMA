// -----------------------------------------------------------------------------
// The ECU over SunSpec Modbus TCP: the decoding of the models, the scan of
// the units, the retries over a lossy Zigbee link, the shape handed to the
// gateways, read-only (function 03 only), and the ECU devices in Gladys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ApsystemsApp } from '../src/app.js';
import { EcuQueue } from '../src/ecu.js';
import { EcuModbusClient, decodeIntInverter, inverterOf, modbusEcuId } from '../src/ecu-sunspec.js';
import { ModbusTcp } from '../src/modbus.js';
import { StateStore, memoryIo } from '../src/store.js';
import { createFakeTimers } from './helpers/fakeTimers.js';
import { SERIALS, ds3Registers, fakeSunspecEcu } from './helpers/fakeSunspec.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const HOST = '192.168.1.19';

const client = (ecu, options = {}) =>
  new EcuModbusClient({
    host: HOST,
    port: 502,
    timeout: 30,
    connect: ecu.connect,
    ...options,
  });

const day = (n, extra = {}) =>
  ds3Registers({
    serial: SERIALS[n - 1],
    unit: n,
    power: 100 + n,
    voltage: 231.4,
    frequency: 50.01,
    temperature: 38,
    wh: 1_000_000 + n * 1000,
    ...extra,
  });

test('the integer model: scale factors applied, "not implemented" values are null', () => {
  const regs = ds3Registers({ power: 245.6, voltage: 231.4, frequency: 50.01, temperature: 38 });
  const block = Buffer.alloc(80);
  for (let i = 0; i < 40; i += 1) {
    block.writeUInt16BE(regs.get(40072 + i) ?? 0, i * 2);
  }
  const reading = decodeIntInverter(block);
  assert.deepEqual(
    [reading.power, reading.voltage, reading.frequency, reading.temperature, reading.state],
    [245.6, [231.4], 50.01, 38, 4],
  );
  assert.equal(reading.energyWh, null, 'acc32 at 0 with its scale factor not implemented');
});

test('the night: the ECU says MPPT with every figure at 0, the inverter is offline', () => {
  const inverter = inverterOf(
    { unit: 1, uid: '705000190306', model: 'DS3', phases: 1 },
    { voltage: [0], power: 0, frequency: 0, temperature: 0, state: 4 },
  );
  assert.equal(inverter.online, false);
  assert.deepEqual(inverter.power, [0]);
  assert.equal(inverter.temperature, null);
  assert.equal(inverter.acOnly, true);
});

test('a reading: the units are found, summed, and only function 03 is ever sent', async () => {
  const units = Object.fromEntries([1, 2, 3].map((n) => [n, day(n)]));
  const ecu = fakeSunspecEcu({ units });
  const { ecu: data, inverters } = await client(ecu).read();
  assert.equal(data.id, modbusEcuId(HOST, 502));
  assert.match(data.id, /^MB[0-9a-f]{10}$/);
  assert.deepEqual([...inverters.inverters.keys()], SERIALS.slice(0, 3));
  const first = inverters.inverters.get(SERIALS[0]);
  assert.deepEqual(
    [first.online, first.model, first.power, first.voltage, first.frequency, first.unit],
    [true, 'DS3', [101], [231.4], 50.01, 1],
  );
  assert.equal(data.currentPower, 101 + 102 + 103);
  assert.equal(data.online, 3);
  assert.equal(data.inverters, 3);
  assert.equal(data.lifetimeEnergy, 3006, 'the float energies of the 3 inverters, in kWh');
  assert.equal(data.todayEnergy, null);
  assert.ok(
    ecu.requests.every((r) => r.fn === 0x03),
    'read-only',
  );
  assert.equal(ecu.connections.opened, ecu.connections.closed, 'the connection is closed');
});

test('the scan stops a few units past the last one, and runs again only after an hour', async () => {
  const ecu = fakeSunspecEcu({ units: { 1: day(1), 2: day(2) } });
  let now = 0;
  const c = client(ecu, { now: () => now });
  await c.read();
  const probed = new Set(ecu.requests.filter((r) => r.address === 40000).map((r) => r.unit));
  assert.deepEqual([...probed], [1, 2, 3, 4, 5], 'three silent units past 2, then it stops');
  ecu.requests.length = 0;
  now += 5 * 60_000;
  await c.read();
  assert.ok(!ecu.requests.some((r) => r.address === 40000), 'no scan five minutes later');
  assert.equal(ecu.requests.length, 4, 'one integer block and one float energy per unit');
  ecu.units[3] = day(3);
  now += 60 * 60_000;
  const { inverters } = await c.read();
  assert.equal(inverters.inverters.size, 3, 'an inverter added in EMA Manager shows up');
});

test('a lost Zigbee frame is asked again; a unit that never answers is left out', async () => {
  const units = Object.fromEntries([1, 2, 3].map((n) => [n, day(n)]));
  let silent = false;
  const ecu = fakeSunspecEcu({
    units,
    // Unit 2 drops its first data request; once `silent`, unit 3 drops everything.
    drop: (unit, address, n) =>
      (unit === 2 && address === 40072 && n === 1) || (silent && unit === 3),
  });
  let now = 0;
  const c = client(ecu, { now: () => now });
  const first = await c.read();
  assert.equal(first.inverters.inverters.size, 3, 'retried: nothing lost');
  silent = true;
  now += 5 * 60_000;
  const second = await c.read();
  assert.deepEqual([...second.inverters.inverters.keys()], SERIALS.slice(0, 2));
  assert.equal(
    second.ecu.lifetimeEnergy,
    null,
    'a partial sum would look like a fall of the index: none',
  );
  assert.equal(second.ecu.inverters, 3, 'the silent inverter is still known');
});

test('no unit has an address: a clear error, no ECU invented', async () => {
  const ecu = fakeSunspecEcu({ units: {} });
  await assert.rejects(client(ecu).read(), /give each one an address/);
});

test('a refused connection is tried once more, then fails as a connection error', async () => {
  const ecu = fakeSunspecEcu({ refuse: true });
  await assert.rejects(client(ecu).read(), (err) => err.connectFailed === true);
  assert.equal(ecu.connections.opened, 2);
});

test('Modbus TCP: an exception answer is an error, a silent unit times out', async () => {
  const ecu = fakeSunspecEcu({ units: { 1: day(1) } });
  const conn = new ModbusTcp({ host: HOST, port: 502, timeout: 30, connect: ecu.connect });
  await conn.open();
  await assert.rejects(conn.readHolding(1, 12345, 2), /Modbus exception 2/);
  await assert.rejects(conn.readHolding(7, 40000, 2), (err) => err.code === 'timeout');
  const marker = await conn.readHolding(1, 40000, 2);
  assert.equal(marker.toString('latin1'), 'SunS');
  await assert.rejects(conn.readHolding(1, 40000, 126), RangeError);
  conn.close();
});

test('Gladys: an ECU typed with port 502 is read over Modbus; one power per inverter', async () => {
  const units = Object.fromEntries(SERIALS.map((_, i) => [i + 1, day(i + 1)]));
  const ecu = fakeSunspecEcu({ units });
  const config = {
    hosts: '',
    poll_interval: 30,
    ecu_hosts: `${HOST}:502`,
    ecu_poll_interval: 300,
  };
  const gladys = createFakeGladys({ selector: 'apsystems', config, devices: [] });
  const app = new ApsystemsApp({
    gladys,
    logger: quiet,
    timers: createFakeTimers(),
    store: new StateStore({ dir: '/data', io: memoryIo() }),
    ecuQueue: new EcuQueue({ pause: 0 }),
    ecuClientFactory: (options) => client(ecu, options),
  });
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  await gladys.connect();
  await app.start(config);
  const found = gladys.fake.discoveredDevices;
  const ecuId = modbusEcuId(HOST, 502);
  assert.equal(found.length, 10, 'the ECU and its 9 DS3');
  assert.equal(found[0].external_id, `ext:apsystems:ecu:${ecuId}`);
  assert.equal(found[0].params.find((p) => p.name === 'host').value, `${HOST}:502`);
  const ds3 = found.find((d) => d.external_id.endsWith(SERIALS[0]));
  const keys = ds3.features.map((f) => f.external_id.split(':').pop());
  assert.ok(keys.includes('power') && !keys.includes('power_1'), 'no power per panel');
  for (const device of found) {
    await gladys.fake.deviceCreated(device);
  }
  const state = (id, key) => gladys.fake.lastState(`${id}:${key}`);
  assert.equal(state(found[0].external_id, 'power'), 9 * 100 + 45);
  assert.equal(state(found[0].external_id, 'inverters_online'), 9);
  assert.equal(state(ds3.external_id, 'power'), 101);
  assert.equal(state(ds3.external_id, 'voltage'), 231.4);
  assert.equal(state(ds3.external_id, 'power_1'), undefined);
  await app.stop?.();
});
