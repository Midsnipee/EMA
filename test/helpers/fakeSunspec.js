// -----------------------------------------------------------------------------
// A fake APsystems ECU speaking SunSpec Modbus TCP: one register map per
// unit, laid out as a real ECU-R with DS3 answered (model 1, 101, 111, an
// undocumented 114, end marker). `connect` replaces net.connect: no socket.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

const BASE = 40000;

function ascii(regs, at, text, length) {
  const bytes = Buffer.alloc(length * 2);
  bytes.write(text, 'latin1');
  for (let i = 0; i < length; i += 1) {
    regs.set(at + i, bytes.readUInt16BE(i * 2));
  }
}
const f32 = (regs, at, value) => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(value);
  regs.set(at, b.readUInt16BE(0));
  regs.set(at + 1, b.readUInt16BE(2));
};
const u32 = (regs, at, value) => {
  regs.set(at, (value >>> 16) & 0xffff);
  regs.set(at + 1, value & 0xffff);
};
const i16 = (n) => n & 0xffff;

/**
 * The registers of one DS3 behind the ECU. `power` W, `voltage` V,
 * `frequency` Hz, `temperature` °C; `wh` the lifetime energy in the float
 * model (0 = like the real one at night, null = NaN); the integer model
 * leaves the energy "not implemented", as the real ECU-R does.
 */
export function ds3Registers({
  serial = '705000190306',
  unit = 1,
  power = 0,
  voltage = 0,
  frequency = 0,
  temperature = 0,
  wh = 0,
  intWh = null,
} = {}) {
  const regs = new Map();
  regs.set(BASE, 0x5375);
  regs.set(BASE + 1, 0x6e53);
  // Model 1, L = 66.
  regs.set(BASE + 2, 1);
  regs.set(BASE + 3, 66);
  ascii(regs, BASE + 4, 'APsystems', 16);
  ascii(regs, BASE + 20, 'DS3', 16);
  ascii(regs, BASE + 44, 'V0', 8);
  ascii(regs, BASE + 52, serial, 16);
  regs.set(BASE + 68, unit);
  // Model 101, L = 50, data at 40072.
  regs.set(BASE + 70, 101);
  regs.set(BASE + 71, 50);
  const d = BASE + 72;
  regs.set(d + 0, Math.round(power / 230 / 0.01) & 0xffff);
  regs.set(d + 4, i16(-2));
  regs.set(d + 8, Math.round(voltage * 10));
  regs.set(d + 11, i16(-1));
  regs.set(d + 12, Math.round(power * 10));
  regs.set(d + 13, i16(-1));
  regs.set(d + 14, Math.round(frequency * 100));
  regs.set(d + 15, i16(-2));
  if (intWh === null) {
    u32(regs, d + 22, 0);
    regs.set(d + 24, 0x8000);
  } else {
    u32(regs, d + 22, intWh);
    regs.set(d + 24, 0);
  }
  for (const i of [25, 27, 29]) regs.set(d + i, 0xffff);
  for (const i of [26, 28, 30]) regs.set(d + i, 0x8000);
  regs.set(d + 31, Math.round(temperature));
  regs.set(d + 35, 0);
  regs.set(d + 36, 4);
  // Model 111, L = 60, data at 40124.
  regs.set(BASE + 122, 111);
  regs.set(BASE + 123, 60);
  const f = BASE + 124;
  f32(regs, f + 0, power / 230);
  f32(regs, f + 14, voltage);
  f32(regs, f + 20, power);
  f32(regs, f + 22, frequency);
  f32(regs, f + 30, wh === null ? Number.NaN : wh);
  for (const i of [32, 34, 36]) f32(regs, f + i, Number.NaN);
  regs.set(f + 46, 0xffff);
  // Model 114, L = 48 (undocumented), then the end.
  regs.set(BASE + 184, 114);
  regs.set(BASE + 185, 48);
  regs.set(BASE + 234, 0xffff);
  return regs;
}

/**
 * An ECU: { units: { 1: regs, 2: regs }, refuse, drop(unit, address, n) }.
 * `drop` returns true to swallow a request (a lost Zigbee frame: the
 * client times out). Every request is recorded in `requests`.
 */
export function fakeSunspecEcu({ units = {}, refuse = false, drop } = {}) {
  const requests = [];
  const connections = { opened: 0, closed: 0 };
  const connect = () => {
    const socket = new EventEmitter();
    connections.opened += 1;
    socket.write = (request) => {
      const unit = request[6];
      const fn = request[7];
      const address = request.readUInt16BE(8);
      const count = request.readUInt16BE(10);
      requests.push({ unit, fn, address, count });
      const n = requests.filter((r) => r.unit === unit && r.address === address).length;
      setImmediate(() => {
        const regs = units[unit];
        if (!regs || drop?.(unit, address, n)) {
          return;
        }
        let pdu;
        if (fn !== 0x03) {
          pdu = Buffer.from([fn | 0x80, 1]);
        } else if (!regs.has(address)) {
          pdu = Buffer.from([0x83, 2]);
        } else {
          pdu = Buffer.alloc(2 + count * 2);
          pdu[0] = 0x03;
          pdu[1] = count * 2;
          for (let i = 0; i < count; i += 1) {
            pdu.writeUInt16BE(regs.get(address + i) ?? 0, 2 + i * 2);
          }
        }
        const adu = Buffer.alloc(7 + pdu.length);
        request.copy(adu, 0, 0, 4);
        adu.writeUInt16BE(1 + pdu.length, 4);
        adu[6] = unit;
        pdu.copy(adu, 7);
        socket.emit('data', adu);
      });
      return true;
    };
    socket.destroy = () => {
      connections.closed += 1;
    };
    setImmediate(() => {
      if (refuse) {
        socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
      } else {
        socket.emit('connect');
      }
    });
    return socket;
  };
  return { connect, requests, connections, units };
}

/** The 9 DS3 of the tester's ECU-R, units 1 to 9. */
export const SERIALS = [
  '705000190306',
  '705000109243',
  '705000108497',
  '705000108537',
  '705000103683',
  '705000105860',
  '705000108059',
  '705000103557',
  '705000108891',
];
