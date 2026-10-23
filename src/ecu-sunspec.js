// -----------------------------------------------------------------------------
// The APsystems ECU read through SunSpec Modbus TCP (port 502), for an ECU
// whose local port 8899 is closed. Source: APsystems "SunSpec Modbus" Rev 3.3
// (2025-01: ECU-R 2160 >= 1.3.7, 2162 >= 2.0.2, ECU-C >= C1.1.3, no ECU-B),
// the SunSpec models 1, 101-103 and 111-113, and a real ECU-R with 9 DS3
// (2026-10). Read-only: function 03 only (src/modbus.js), never the
// controls of model 123.
//
// The ECU answers for each micro-inverter on the Modbus unit id the user
// gave it in EMA Manager (ECU APP > Workspace > Modbus Configuration;
// address 0 means "not exposed"). Each unit is a SunSpec device: "SunS" at
// 40000 (40001 in the 1-based numbering of the manual), then a chain of
// models. What a real ECU-R gave for a DS3: model 1 (manufacturer
// "APsystems", model "DS3", serial = the inverter id), model 101 (integers
// and scale factors; the DC values and the lifetime energy are "not
// implemented"), model 111 (floats, its state 0xFFFF), and an undocumented
// model 114 (ignored). Every request goes over the ECU's Zigbee link to the
// inverter: slow and lossy (a few timeouts in a reading of 9 units), hence
// the retries.
//
// What this file gives back has the shape of src/ecu-protocol.js'
// parseEcuFrame / parseInverterFrame, so src/gateways.js reads both the
// same way. Two differences: the ECU id is not readable over Modbus (it is
// derived from the address, `modbusEcuId`), and only the AC side is known
// (`acOnly`: one power per inverter, no power per panel). The ECU's own
// energy of the day is not readable either; its lifetime energy is the sum
// of the inverters' when every one of them gives it.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { ECU } from './constants.js';
import { EcuError, INVERTER_MODELS, isInverterUid } from './ecu-protocol.js';
import { MAX_REGISTERS, ModbusTcp } from './modbus.js';

/** "SunS" at the base address (0-based 40000). */
export const SUNSPEC_BASE = 40000;
const SUNS = 0x53756e53;
/** The chain never runs further than this (a garbled length cannot loop). */
const CHAIN_END = SUNSPEC_BASE + 2000;
const MAX_MODELS = 20;

const INT_MODELS = new Set([101, 102, 103]);
const FLOAT_MODELS = new Set([111, 112, 113]);

/** "Not implemented" values of SunSpec. */
const NI_U16 = 0xffff;
const NI_I16 = -0x8000;

/** SunSpec operating states (model 101 St). */
export const STATES = {
  1: 'off',
  2: 'sleeping',
  3: 'starting',
  4: 'mppt',
  5: 'throttled',
  6: 'shutting_down',
  7: 'fault',
  8: 'standby',
};

/**
 * The ECU id of an ECU read over Modbus: the protocol does not carry it, so
 * it is derived from its address ("MB" + 10 hex digits, the 12 characters
 * of an ECU id). Stable as long as the ECU keeps its address (a fixed lease
 * in the router, as the configuration already asks).
 */
export function modbusEcuId(host, port) {
  const digest = createHash('sha1').update(`${host}:${port}`).digest('hex');
  return `MB${digest.slice(0, 10)}`;
}

/** Readers over the registers of one model block (index = register). */
function registers(buffer) {
  const count = buffer.length / 2;
  const need = (i, n) => {
    if (i < 0 || i + n > count) {
      throw new EcuError('protocol', `register ${i} (+${n}) past the block (${count})`);
    }
  };
  return {
    u16: (i) => (need(i, 1), buffer.readUInt16BE(i * 2)),
    i16: (i) => (need(i, 1), buffer.readInt16BE(i * 2)),
    u32: (i) => (need(i, 2), buffer.readUInt32BE(i * 2)),
    f32: (i) => (need(i, 2), buffer.readFloatBE(i * 2)),
    str: (i, n) => {
      need(i, n);
      return buffer
        .toString('latin1', i * 2, (i + n) * 2)
        .replace(/[^\x20-\x7e]/g, '')
        .trim()
        .slice(0, 40);
    },
  };
}

const round = (value, digits = 3) =>
  value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

/** A value times 10^sf, or null when either is "not implemented". */
function scaled(value, sf, notImplemented) {
  if (value === notImplemented || sf === NI_I16 || sf < -10 || sf > 10) {
    return null;
  }
  return round(value * 10 ** sf, 4);
}

/** Model 1 (common): who the unit is. */
export function decodeCommon(buffer) {
  const r = registers(buffer);
  return {
    manufacturer: r.str(0, 16),
    model: r.str(16, 16),
    version: r.str(40, 8),
    serial: r.str(48, 16).toLowerCase(),
  };
}

/** Models 101-103 (integers and scale factors). */
export function decodeIntInverter(buffer, phases = 1) {
  const r = registers(buffer);
  const vSf = r.i16(11);
  const whSf = r.i16(24);
  const wh = r.u32(22);
  const tmpSf = r.i16(35);
  return {
    current: scaled(r.u16(0), r.i16(4), NI_U16),
    voltage: (phases === 3 ? [8, 9, 10] : [8]).map((i) => scaled(r.u16(i), vSf, NI_U16)),
    power: scaled(r.i16(12), r.i16(13), NI_I16),
    frequency: scaled(r.u16(14), r.i16(15), NI_U16),
    // acc32: 0 is "not implemented", as is its scale factor.
    energyWh: wh === 0 ? null : scaled(wh, whSf, -1),
    temperature: scaled(r.i16(31), tmpSf, NI_I16),
    state: r.u16(36) === NI_U16 ? null : r.u16(36),
  };
}

/** Models 111-113 (floats; NaN is "not implemented"). */
export function decodeFloatInverter(buffer, phases = 1) {
  const r = registers(buffer);
  const f = (i) => {
    const value = r.f32(i);
    return Number.isNaN(value) ? null : round(value, 4);
  };
  return {
    current: f(0),
    voltage: (phases === 3 ? [14, 16, 18] : [14]).map(f),
    power: f(20),
    frequency: f(22),
    energyWh: f(30) || null,
    temperature: f(38),
    state: r.u16(46) === NI_U16 ? null : r.u16(46),
  };
}

/**
 * One micro-inverter in the shape of parseInverterFrame's entries. Online
 * when it shows a grid voltage or a power: at night the ECU-R still says
 * "MPPT" but every figure is 0.
 */
export function inverterOf(unit, reading) {
  const volts = reading.voltage.map((v) => v ?? 0);
  const watts = reading.power !== null && reading.power > 0 ? reading.power : 0;
  const online = volts.some((v) => v > 0) || watts > 0;
  return {
    uid: unit.uid,
    unit: unit.unit,
    online,
    type: null,
    model: unit.model,
    channels: 1,
    acOnly: true,
    phases: unit.phases,
    frequency: online ? reading.frequency : null,
    temperature: online ? reading.temperature : null,
    power: [online ? round(watts, 1) : 0],
    voltage: volts,
    state: reading.state === null ? null : (STATES[reading.state] ?? String(reading.state)),
  };
}

export class EcuModbusClient {
  constructor({
    host,
    port,
    queue,
    timeout = ECU.MODBUS.TIMEOUT,
    retries = ECU.MODBUS.RETRIES,
    attempts = ECU.CONNECT_ATTEMPTS,
    connect,
    now = Date.now,
    logger,
  }) {
    this.host = host;
    this.port = port;
    this.queue = queue;
    this.timeout = timeout;
    this.retries = Math.max(1, retries);
    this.attempts = Math.max(1, attempts);
    this.connect = connect;
    this.now = now;
    this.logger = logger;
    this.ecuId = modbusEcuId(host, port);
    /** unit id -> { unit, uid, model, phases, int, float } (what a scan found). */
    this.units = new Map();
    this.scannedAt = -Infinity;
  }

  /** A whole reading, as EcuClient.read: { ecu, inverters, inverterError }. */
  read() {
    return this.queue ? this.queue.run(() => this.readNow()) : this.readNow();
  }

  async open() {
    for (let attempt = 1; ; attempt += 1) {
      const conn = new ModbusTcp({
        host: this.host,
        port: this.port,
        timeout: this.timeout,
        ...(this.connect ? { connect: this.connect } : {}),
      });
      try {
        await conn.open();
        return conn;
      } catch (err) {
        if (!err.connectFailed || attempt >= this.attempts) {
          throw err;
        }
      }
    }
  }

  /** Reads registers, again on a timeout (the Zigbee link drops some). */
  async registers(conn, unit, address, count, tries = this.retries) {
    const parts = [];
    for (let offset = 0; offset < count; offset += MAX_REGISTERS) {
      const n = Math.min(MAX_REGISTERS, count - offset);
      for (let attempt = 1; ; attempt += 1) {
        try {
          parts.push(await conn.readHolding(unit, address + offset, n));
          break;
        } catch (err) {
          if (err.code !== 'timeout' || attempt >= tries) {
            throw err;
          }
        }
      }
    }
    return Buffer.concat(parts);
  }

  /** What one unit is: its SunSpec chain (model 1 and an inverter model). */
  async identify(conn, unit) {
    const marker = await this.registers(conn, unit, SUNSPEC_BASE, 2, ECU.MODBUS.PROBE_TRIES);
    if (marker.readUInt32BE(0) !== SUNS) {
      throw new EcuError('protocol', `unit ${unit}: no SunSpec marker`);
    }
    const found = {
      unit,
      uid: undefined,
      model: null,
      phases: 1,
      int: undefined,
      float: undefined,
    };
    let address = SUNSPEC_BASE + 2;
    for (let n = 0; n < MAX_MODELS && address < CHAIN_END; n += 1) {
      const header = await this.registers(conn, unit, address, 2);
      const id = header.readUInt16BE(0);
      const length = header.readUInt16BE(2);
      if (id === 0xffff || id === 0 || length === 0) {
        break;
      }
      const data = address + 2;
      if (id === 1) {
        const common = decodeCommon(await this.registers(conn, unit, data, Math.min(length, 66)));
        if (!isInverterUid(common.serial)) {
          throw new EcuError('protocol', `unit ${unit}: not an inverter id (${common.serial})`);
        }
        found.uid = common.serial;
        found.model = INVERTER_MODELS[common.serial.slice(0, 2)] ?? (common.model || null);
      } else if (INT_MODELS.has(id) && length >= 40 && !found.int) {
        found.int = data;
        found.phases = id === 103 ? 3 : 1;
      } else if (FLOAT_MODELS.has(id) && length >= 48 && !found.float) {
        found.float = data;
        found.phases = id === 113 ? 3 : found.int ? found.phases : 1;
      }
      address = data + length;
    }
    if (!found.uid || (!found.int && !found.float)) {
      throw new EcuError('protocol', `unit ${unit}: no SunSpec inverter model`);
    }
    return found;
  }

  /**
   * Looks for the units: 1, 2, 3... and stops after a few in a row that do
   * not answer once past every unit already known. Units already known are
   * kept (a lost Zigbee frame does not forget an inverter).
   */
  async scan(conn) {
    let misses = 0;
    const highest = Math.max(0, ...this.units.keys());
    for (let unit = 1; unit <= ECU.MODBUS.MAX_UNIT; unit += 1) {
      if (this.units.has(unit)) {
        misses = 0;
        continue;
      }
      try {
        const found = await this.identify(conn, unit);
        // Two units for one inverter (an address typed twice): the first one wins.
        if (![...this.units.values()].some((u) => u.uid === found.uid)) {
          this.units.set(unit, found);
        }
        misses = 0;
      } catch (err) {
        if (err.code === 'network') {
          throw err;
        }
        misses += 1;
        if (misses >= ECU.MODBUS.MISSES_TO_STOP && unit > highest) {
          break;
        }
      }
    }
    this.scannedAt = this.now();
  }

  async readUnit(conn, unit) {
    let reading;
    if (unit.int) {
      reading = decodeIntInverter(await this.registers(conn, unit.unit, unit.int, 40), unit.phases);
      if (reading.energyWh === null && unit.float) {
        // The integer model leaves the lifetime energy "not implemented": the float one may not.
        const wh = (await this.registers(conn, unit.unit, unit.float + 30, 2)).readFloatBE(0);
        reading.energyWh = Number.isFinite(wh) && wh > 0 ? wh : null;
      }
    } else {
      reading = decodeFloatInverter(
        await this.registers(conn, unit.unit, unit.float, 48),
        unit.phases,
      );
    }
    return { inverter: inverterOf(unit, reading), energyWh: reading.energyWh };
  }

  async readNow() {
    const conn = await this.open();
    try {
      if (this.units.size === 0 || this.now() - this.scannedAt >= ECU.MODBUS.RESCAN) {
        await this.scan(conn);
      }
      if (this.units.size === 0) {
        throw new EcuError(
          'protocol',
          'no micro-inverter answers over Modbus: give each one an address (1, 2, 3...) in EMA Manager, Modbus Configuration',
        );
      }
      const inverters = new Map();
      let energy = 0;
      let energyComplete = true;
      let lastError;
      for (const unit of [...this.units.values()].sort((a, b) => a.unit - b.unit)) {
        try {
          const { inverter, energyWh } = await this.readUnit(conn, unit);
          inverters.set(inverter.uid, inverter);
          if (energyWh > 0) {
            energy += energyWh;
          } else {
            energyComplete = false;
          }
        } catch (err) {
          if (err.code === 'network') {
            throw err;
          }
          lastError = err;
          energyComplete = false;
          this.logger?.debug?.(`ECU ${this.host}:${this.port} unit ${unit.unit}: ${err.message}`);
        }
      }
      if (inverters.size === 0) {
        throw lastError ?? new EcuError('timeout', 'no micro-inverter answered');
      }
      const list = [...inverters.values()];
      const online = list.filter((i) => i.online);
      const ecu = {
        id: this.ecuId,
        model: 'ECU (Modbus)',
        // A partial sum would look like a fall of the index: none rather than a wrong one.
        lifetimeEnergy: energyComplete && energy > 0 ? round(energy / 1000, 3) : null,
        currentPower: round(
          online.reduce((total, i) => total + i.power[0], 0),
          1,
        ),
        todayEnergy: null,
        inverters: this.units.size,
        online: online.length,
        firmware: null,
        timezone: null,
      };
      return {
        ecu,
        inverters: { timestamp: null, inverters, truncated: false },
        inverterError: undefined,
      };
    } finally {
      conn.close();
    }
  }
}
