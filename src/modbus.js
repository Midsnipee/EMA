// -----------------------------------------------------------------------------
// A minimal Modbus TCP client: function 03 (read holding registers) only.
// Nothing here can write to a device. One connection, requests one at a
// time (the ECU relays each one over its Zigbee link to a micro-inverter:
// slow, and it is not known to accept pipelining). Bounded: an answer longer
// than a Modbus frame can be is refused. The tests replace `connect`.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { EcuError } from './ecu-protocol.js';

/** MBAP header (7 bytes) + function + byte count + 125 registers at most. */
const MAX_ADU = 7 + 2 + 250;
/** The protocol caps one read at 125 registers. */
export const MAX_REGISTERS = 125;

/** A connection that could not be opened (refused, unreachable): safe to try again. */
function connectError(err) {
  const error = new EcuError('network', err?.code ?? err?.message ?? String(err));
  error.connectFailed = true;
  return error;
}

export class ModbusTcp {
  constructor({ host, port, timeout, connect = (options) => net.connect(options) }) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.connectFn = connect;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.pending = undefined;
    this.tid = 0;
    this.closed = false;
  }

  /** Opens the connection; rejects with a `connectFailed` EcuError. */
  open() {
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (err) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        if (err) {
          this.close();
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () => settle(connectError(new Error('connection timeout'))),
        Math.max(1, this.timeout),
      );
      try {
        this.socket = this.connectFn({ host: this.host, port: this.port });
      } catch (err) {
        settle(connectError(err));
        return;
      }
      this.socket.on('connect', () => settle());
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.on('error', (err) => {
        if (!done) {
          settle(connectError(err));
        } else {
          this.fail(new EcuError('network', err?.code ?? err?.message ?? String(err)));
        }
      });
      this.socket.on('close', () => {
        this.closed = true;
        if (!done) {
          settle(connectError(new Error('closed before connecting')));
        }
        this.fail(new EcuError('network', 'the ECU closed the Modbus connection'));
      });
    });
  }

  fail(err) {
    const pending = this.pending;
    if (pending) {
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_ADU * 4) {
      this.buffer = Buffer.alloc(0);
      this.fail(new EcuError('protocol', 'Modbus answer too long'));
      return;
    }
    while (this.buffer.length >= 8) {
      const length = this.buffer.readUInt16BE(4);
      if (length < 2 || 6 + length > MAX_ADU) {
        this.buffer = Buffer.alloc(0);
        this.fail(new EcuError('protocol', `impossible Modbus length ${length}`));
        return;
      }
      if (this.buffer.length < 6 + length) {
        return;
      }
      const adu = this.buffer.subarray(0, 6 + length);
      this.buffer = this.buffer.subarray(6 + length);
      const pending = this.pending;
      // A late answer to a request that already timed out: dropped.
      if (!pending || adu.readUInt16BE(0) !== pending.tid) {
        continue;
      }
      this.pending = undefined;
      clearTimeout(pending.timer);
      const fn = adu[7];
      if (fn === (0x03 | 0x80)) {
        const error = new EcuError('protocol', `Modbus exception ${adu[8]}`);
        error.exception = adu[8];
        pending.reject(error);
      } else if (fn !== 0x03 || adu.length < 9 || adu[8] !== pending.count * 2) {
        pending.reject(new EcuError('protocol', 'unexpected Modbus answer'));
      } else {
        pending.resolve(Buffer.from(adu.subarray(9, 9 + adu[8])));
      }
    }
  }

  /** Reads `count` holding registers of `unit` from `address`: resolves a Buffer. */
  readHolding(unit, address, count) {
    if (this.closed || !this.socket) {
      return Promise.reject(new EcuError('network', 'the Modbus connection is closed'));
    }
    if (this.pending) {
      return Promise.reject(new Error('one Modbus request at a time'));
    }
    if (count < 1 || count > MAX_REGISTERS) {
      return Promise.reject(new RangeError(`cannot read ${count} registers at once`));
    }
    this.tid = (this.tid % 0xffff) + 1;
    const tid = this.tid;
    const request = Buffer.alloc(12);
    request.writeUInt16BE(tid, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt16BE(6, 4);
    request.writeUInt8(unit, 6);
    request.writeUInt8(0x03, 7);
    request.writeUInt16BE(address, 8);
    request.writeUInt16BE(count, 10);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (this.pending?.tid === tid) {
            this.pending = undefined;
            reject(
              new EcuError(
                'timeout',
                `unit ${unit} did not answer within ${Math.round(this.timeout / 1000)} s`,
              ),
            );
          }
        },
        Math.max(1, this.timeout),
      );
      this.pending = { tid, count, resolve, reject, timer };
      this.socket.write(request);
    });
  }

  close() {
    this.closed = true;
    this.fail(new EcuError('network', 'the Modbus connection is closed'));
    this.socket?.destroy();
  }
}
