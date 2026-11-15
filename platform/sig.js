'use strict';
/**
 * sig.js - this install's own key, and signatures with it (Node 8 and later).
 *
 * The key is ECDSA P-256, made on the head unit the first time a name is chosen; its private half
 * never leaves the car. The leaderboard signs every request that writes something with it, so
 * nobody can post as this driver and a request cannot be changed or sent again.
 *
 *   const s = require('./sig').signer;
 *   const k = await s.create();                 // { pub: 65-byte uncompressed point (hex), priv: 32 bytes (hex) }
 *   const sig = await s.sign(k, message);       // r || s, 64 bytes (hex): what Web Crypto verifies
 *   const h = await s.sha256(text);             // hex
 *
 * Node 8 has no generateKeyPair: the key comes from ECDH (same curve), and signing goes through a
 * SEC1 PEM built around it. The DER signature Node makes is turned into the raw r || s form.
 */
const crypto = require('crypto');

const CURVE_OID = Buffer.from('06082a8648ce3d030107', 'hex');       // prime256v1

function pad32(b) { if (b.length === 32) return b; if (b.length > 32) return b.slice(b.length - 32); return Buffer.concat([Buffer.alloc(32 - b.length), b]); }

function pemOf(privHex, pubHex) {
    const priv = pad32(Buffer.from(privHex, 'hex')), pub = Buffer.from(pubHex, 'hex');
    // ECPrivateKey ::= SEQUENCE { 1, OCTET STRING priv, [0] OID, [1] BIT STRING pub }
    const der = Buffer.concat([
        Buffer.from([0x30, 0x77, 0x02, 0x01, 0x01, 0x04, 0x20]), priv,
        Buffer.from([0xa0, 0x0a]), CURVE_OID,
        Buffer.from([0xa1, 0x44, 0x03, 0x42, 0x00]), pub,
    ]);
    const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
    return '-----BEGIN EC PRIVATE KEY-----\n' + b64 + '\n-----END EC PRIVATE KEY-----\n';
}

/** DER ECDSA-Sig-Value -> r || s (32 + 32 bytes) */
function rawOf(der) {
    let i = 2;
    if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
    const rl = der[i + 1], r = der.slice(i + 2, i + 2 + rl); i = i + 2 + rl;
    const sl = der[i + 1], s = der.slice(i + 2, i + 2 + sl);
    return Buffer.concat([pad32(r), pad32(s)]);
}

const signer = {
    create() {
        const e = crypto.createECDH('prime256v1');
        e.generateKeys();
        return Promise.resolve({ pub: e.getPublicKey().toString('hex'), priv: pad32(e.getPrivateKey()).toString('hex') });
    },
    sign(key, message) {
        try {
            const s = crypto.createSign('SHA256');
            s.update(Buffer.from(String(message), 'utf8'));
            return Promise.resolve(rawOf(s.sign(pemOf(key.priv, key.pub))).toString('hex'));
        } catch (e) { return Promise.reject(e); }
    },
    sha256(text) { return Promise.resolve(crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex')); },
    /** a key read back from disk: is it whole? */
    valid(key) { return !!(key && /^04[0-9a-f]{128}$/.test(key.pub || '') && /^[0-9a-f]{64}$/.test(key.priv || '')); },
};

module.exports = { signer, pemOf, rawOf };
