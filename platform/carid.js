'use strict';
/**
 * carid.js - this car's anonymous identity for the leaderboard: one driver per car, and an account
 * that comes back after a reinstall. Read-only; nothing here throws (no answer resolves null).
 */
const crypto = require('crypto');

const DME = 0x12, DID_VIN = [0xF1, 0x90], DID_SERIAL = [0xF1, 0x8C];
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

let diag = null, diagTried = false;

async function link(ctx, log) {
    if (diag || diagTried) return diag;
    diagTried = true;
    try {
        const { Diag } = require('./kit/diag');
        const d = await new Diag(ctx.signals, log).init();
        if (!d.p) return null;
        d.quiet = true; d.busyLog = false;
        diag = d;
    } catch (e) { if (log) log.info('car id: no diagnostic transport (' + String(e && e.message || e).slice(0, 60) + ')'); }
    return diag;
}

async function readDid(d, did) {
    const { replyTo } = require('./kit/diag');
    try {
        const r = await d.physical(DME, 0x22, did, 3000, replyTo(0x22, did), { hardTimeoutMs: 9000, maxRetries: 2 });
        if (r && r[0] === 0x62) return r.slice(3);
    } catch (e) { /* refused, busy, gone */ }
    return null;
}

/** resolves { car: hex hash } or null; never rejects */
async function readCarId(ctx, log) {
    try {
        const d = await link(ctx, log);
        if (!d) return null;
        const vb = await readDid(d, DID_VIN);
        const vin = vb ? vb.map((c) => String.fromCharCode(c)).join('').replace(/[^A-Z0-9]/gi, '').toUpperCase() : '';
        if (!VIN.test(vin)) { if (log) log.info('car id: no answer'); return null; }
        const sb = await readDid(d, DID_SERIAL);
        const serial = sb ? sb.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('').trim() || Buffer.from(sb).toString('hex') : '';
        if (!serial || serial.length < 4) { if (log) log.info('car id: incomplete'); return null; }
        const car = crypto.createHash('sha256').update('sideways-car:' + vin + ':' + serial).digest('hex');
        if (log) log.info('car id: read (VIN ' + vin.slice(0, 3) + '...' + vin.slice(-2) + ')');
        return { car };
    } catch (e) {
        if (log) log.info('car id: ' + String(e && e.message || e).slice(0, 80));
        return null;
    }
}

module.exports = { readCarId };
