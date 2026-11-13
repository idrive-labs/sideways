'use strict';
/**
 * leaderboard.js - online leaderboard, offline first.
 *
 *   const lb = new Leaderboard({ http, load, save, url, log, signer });
 *   lb.setPlayer(saved)                    // the profile kept on disk (or null)
 *   await lb.join({ name? })               // a new driver, or this car's driver coming back after a reinstall
 *   await lb.rename(name)                  // once a day at most (the server decides)
 *   lb.setCar(hash)                        // this car's identity, when the car gives it (platform/carid.js)
 *   lb.submit(run)                         // a banked chain driven on live car data
 *   await lb.myRuns()                      // this driver's runs on the server (to restore a reinstall)
 *   lb.tick(now)                           // call often: syncs when due, never throws, never blocks
 *   lb.view                                // { status, queued, boards, me, players, at, flagged }
 *
 * Writes are signed with this install's own key (platform/sig.js on the car, Web Crypto in a
 * browser). Nothing driven is ever lost: runs wait on disk until the server has them; only a run
 * the server calls malformed is dropped. Runs the server holds back come back in `flagged`.
 * http(method, url, bodyObject, timeoutMs) -> Promise<{ status, json }> is the host's.
 */
const MIN_RETRY = 15, MAX_RETRY = 300, REFRESH = 60;

function randomHex(n) {
    let s = '';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const b = new Uint8Array(n); crypto.getRandomValues(b); for (const x of b) s += x.toString(16).padStart(2, '0');
        return s;
    }
    try { return require('crypto').randomBytes(n).toString('hex'); } catch (e) { /* fall through */ }
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    return s;
}
function newPlayer(name) { return { id: randomHex(12), name: name || '', registered: false }; }

/** names: 3-16 characters, letters (A-Z), digits, space, - _ . ; upper case */
function cleanName(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16); }
function validName(s) { const c = cleanName(s); return c.length >= 3 && c === String(s).toUpperCase().trim(); }
const keyOk = (k) => !!(k && /^04[0-9a-f]{128}$/.test(k.pub || '') && /^[0-9a-f]{64}$/.test(k.priv || ''));

class Leaderboard {
    constructor(o) {
        this.http = o.http; this.load = o.load; this.save = o.save; this.url = (o.url || '').replace(/\/+$/, ''); this.log = o.log || { info() {}, warn() {} };
        this.signer = o.signer || null;
        const st = (this.load && this.load('leaderboard')) || {};
        // only live drives are ever sent (an old queue may hold something else: it is dropped)
        this.queue = Array.isArray(st.queue) ? st.queue.filter((q) => q && q.mode === 'live').slice(-500) : [];
        this.cache = st.cache || { all: [], week: [], me: { all: null, week: null }, at: 0 };
        this.flagged = st.flagged && typeof st.flagged === 'object' ? st.flagged : {};      // run id -> why (under review)
        this.player = null; this.carHash = null;
        this.status = this.url ? 'idle' : 'off';           // off, idle, syncing, online, offline, banned, moved
        this.next = 0; this.retry = MIN_RETRY; this.busy = false; this.lastError = '';
    }
    persist() { if (this.save) this.save('leaderboard', { queue: this.queue, cache: this.cache, flagged: this.flagged }); }
    savePlayer() { if (this.save && this.player) this.save('player', this.player); }
    setUrl(url) { this.url = (url || '').replace(/\/+$/, ''); this.status = this.url ? 'idle' : 'off'; this.next = 0; }
    refresh() { this.cache.at = 0; if (this.status !== 'banned' && this.status !== 'moved') this.next = 0; }
    /** the saved profile; one from before signed requests (no key) has to join again */
    setPlayer(p) {
        if (!p || typeof p !== 'object' || !p.id) { this.player = null; return; }
        this.player = p;
        if (!keyOk(p.key)) p.registered = false;
        this.next = 0;
    }
    get registered() { return !!(this.player && this.player.registered && keyOk(this.player.key)); }
    setCar(hash) {
        if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || this.carHash === hash) return;
        this.carHash = hash; this.next = 0;
    }
    submit(run) {
        if (!run || run.mode !== 'live') return;            // kept before the driver has a name: sent once they join
        if (this.queue.some((q) => q.id === run.id)) return;
        this.queue.push(Object.assign({ id: run.id || randomHex(10), ts: Date.now() }, run));
        this.persist(); this.next = 0;
    }
    waiting(id) { return this.queue.some((q) => q.id === id); }

    /* ---------- requests ---------- */
    async _call(method, path, body) {
        const r = await this.http(method, this.url + path, body, path === '/v1/scores' ? 20000 : 9000);
        if (!r || typeof r.status !== 'number') throw new Error('no response');
        if (r.status >= 500) throw new Error('server ' + r.status);
        return r;
    }
    /** a signed POST: a one-time number from the server, the data signed with this install's key */
    async _signed(path, data, key, asPlayer) {
        if (!this.signer) throw new Error('no signer');
        const text = JSON.stringify(data || {});
        for (let attempt = 0; attempt < 2; attempt++) {
            const n = await this._call('GET', '/v1/nonce');
            if (n.status === 429) return n;
            if (n.status !== 200 || !n.json || typeof n.json.nonce !== 'string') throw new Error('nonce ' + n.status);
            const msg = 'sideways1\n' + path + '\n' + n.json.nonce + '\n' + await this.signer.sha256(text);
            const sig = await this.signer.sign(key, msg);
            const r = await this._call('POST', path, { player: asPlayer || undefined, nonce: n.json.nonce, sig, data: text });
            if (r.status === 401 && r.json && r.json.error === 'stale' && attempt === 0) continue;       // the number expired on the way: once more
            return r;
        }
        throw new Error('stale');
    }
    /** the connection test: the server's health, round trip in ms; never throws */
    async ping() {
        if (!this.url) return { ok: false, why: 'no-server' };
        if (!this.http) return { ok: false, why: 'no-network' };
        const t0 = Date.now();
        try {
            const r = await this.http('GET', this.url + '/v1/health', null, 6000);
            const ms = Date.now() - t0;
            if (r && r.status === 200 && r.json && r.json.ok) return { ok: true, ms, version: r.json.version };
            return { ok: false, why: r && typeof r.status === 'number' ? 'server-' + r.status : 'no-response', ms };
        } catch (e) { return { ok: false, why: 'offline', error: String(e && e.message || e).slice(0, 60) }; }
    }

    /**
     * join: this install's key is made (once) and sent with the car's identity; the server answers
     * with this car's driver when it has one (a reinstall: the account comes back), else asks for a
     * name (none given) or takes the one given. Resolves { ok, recovered, name } or
     * { ok: false, need: 'name' } or { ok: false, why: 'taken' | 'invalid' | 'banned' | 'slow' | 'offline' | 'server' | 'no-server' }.
     */
    async join(o) {
        if (!this.url) return { ok: false, why: 'no-server' };
        if (!this.http || !this.signer) return { ok: false, why: 'offline' };
        try {
            if (!this.player) this.player = newPlayer('');
            const p = this.player;
            if (!keyOk(p.key)) { p.key = await this.signer.create(); p.registered = false; this.savePlayer(); }
            const data = { id: p.id, pub: p.key.pub };
            if (o && o.name) data.name = o.name;
            if (this.carHash) data.car = this.carHash;
            const r = await this._signed('/v1/join', data, p.key, null);
            if (r.status === 409) return { ok: false, why: r.json && r.json.error === 'id taken' ? 'server' : 'taken' };
            if (r.status === 400) return { ok: false, why: 'invalid', detail: r.json && r.json.error };
            if (r.status === 403) { this.status = 'banned'; return { ok: false, why: 'banned' }; }
            if (r.status === 429) return { ok: false, why: 'slow' };
            if (r.status !== 200 || !r.json) return { ok: false, why: 'server', detail: 'HTTP ' + r.status };
            if (r.json.need === 'name') return { ok: false, need: 'name' };
            if (!r.json.ok) return { ok: false, why: 'server' };
            p.id = r.json.id; p.name = r.json.name; p.registered = true; p.renameAt = r.json.renameAt || 0; p.carBound = !!this.carHash;
            this.savePlayer();
            this.status = 'online'; this.retry = MIN_RETRY; this.next = 0; this.cache.at = 0;
            return { ok: true, recovered: !!r.json.recovered, name: p.name };
        } catch (e) {
            this.status = 'offline';
            return { ok: false, why: 'offline' };
        }
    }
    /** a new name: resolves { ok, name, renameAt } or { ok: false, why: 'taken' | 'too-soon' | 'invalid' | 'offline' | 'server', renameAt } */
    async rename(name) {
        if (!this.registered) return { ok: false, why: 'server' };
        try {
            const p = this.player;
            const r = await this._signed('/v1/rename', { name }, p.key, p.id);
            if (r.status === 409) return { ok: false, why: 'taken' };
            if (r.status === 429) { if (r.json && r.json.renameAt) { p.renameAt = r.json.renameAt; this.savePlayer(); } return { ok: false, why: r.json && r.json.renameAt ? 'too-soon' : 'slow', renameAt: r.json && r.json.renameAt }; }
            if (r.status === 400) return { ok: false, why: 'invalid' };
            if (r.status === 403) { this.status = 'banned'; return { ok: false, why: 'banned' }; }
            if (r.status === 401) { this.status = 'moved'; return { ok: false, why: 'moved' }; }
            if (r.status !== 200 || !r.json || !r.json.ok) return { ok: false, why: 'server' };
            p.name = r.json.name; p.renameAt = r.json.renameAt || 0; this.savePlayer();
            this.cache.at = 0; this.next = 0;
            return { ok: true, name: p.name, renameAt: p.renameAt };
        } catch (e) { return { ok: false, why: 'offline' }; }
    }
    /** this driver's runs on the server, newest first (at most 2,000) */
    async myRuns() {
        if (!this.registered) return [];
        const p = this.player, out = [];
        let before;
        for (let page = 0; page < 20; page++) {
            const r = await this._signed('/v1/me/runs', before ? { before } : {}, p.key, p.id);
            if (r.status !== 200 || !r.json || !Array.isArray(r.json.runs)) break;
            out.push(...r.json.runs);
            if (!r.json.next) break;
            before = r.json.next;
        }
        for (const r of out) if (r.flagged) this.flagged[r.id] = this.flagged[r.id] || 'under review';
        this.persist();
        return out;
    }
    /** another driver's replay (or your own from another install): resolves to the clip's string */
    async fetchReplay(id) {
        if (!this.url || !this.http) throw new Error('no server');
        const r = await this._call('GET', '/v1/replay?id=' + encodeURIComponent(id));
        if (r.status !== 200 || !r.json || typeof r.json.data !== 'string') throw new Error(r.status === 404 ? 'no replay' : 'replay ' + r.status);
        return r.json;
    }
    /** a one-time link for a phone to make a video of an own drift: resolves { id, url, expires } */
    async exportClip(clip, edit, meta) {
        if (!this.url || !this.http) throw new Error('no server');
        if (!this.registered) throw new Error('not registered');
        const p = this.player;
        const r = await this._signed('/v1/exports', { clip, edit, meta }, p.key, p.id);
        if (r.status !== 200 || !r.json || !r.json.url) throw new Error(r.status === 401 || r.status === 403 ? 'not allowed' : r.status === 413 ? 'too long' : 'export ' + r.status);
        return r.json;
    }
    async exportState(id) {
        const r = await this._call('GET', '/v1/exports/' + encodeURIComponent(id) + '/state');
        return r.status === 200 && r.json ? r.json : { state: 'gone' };
    }
    get view() {
        return { status: this.status, queued: this.queue.length, boards: { all: this.cache.all, week: this.cache.week }, me: this.cache.me, players: this.cache.players || {}, at: this.cache.at, error: this.lastError, flagged: this.flagged };
    }

    /** do what is due; returns at once (the work runs in the background) */
    tick(now) {
        now = now || Date.now();
        if (!this.url || !this.http || this.busy || now < this.next) return;
        // not joined yet: only the connection is watched (a health check every 30 s)
        if (!this.registered) {
            this.busy = true;
            this.ping().then((r) => { if (this.status !== 'banned') this.status = r.ok ? 'online' : 'offline'; this.next = Date.now() + 30000; }, () => { this.status = 'offline'; this.next = Date.now() + 30000; })
                .then(() => { this.busy = false; });
            return;
        }
        const due = this.queue.length || now - this.cache.at > REFRESH * 1000 || (this.carHash && !this.player.carBound);
        if (!due) { this.next = now + 5000; return; }
        this.busy = true; if (this.status !== 'banned' && this.status !== 'moved') this.status = 'syncing';
        this._sync().then(() => {
            this.status = 'online'; this.retry = MIN_RETRY; this.lastError = '';
            this.next = Date.now() + (this.queue.length ? 1000 : REFRESH * 1000);
        }, (e) => {
            const msg = String(e && e.message || e);
            if (msg === 'banned' || msg === 'moved') { this.status = msg; this.next = Date.now() + 10 * 60000; }      // looked at again now and then
            else { this.status = 'offline'; this.next = Date.now() + this.retry * 1000; this.retry = Math.min(MAX_RETRY, this.retry * 2); }
            this.lastError = msg.slice(0, 80);
        }).then(() => { this.busy = false; });
    }
    async _sync() {
        const p = this.player;
        // the car's identity, found after joining: bound once (a reinstall then finds this account)
        if (this.carHash && !p.carBound) {
            const r = await this._signed('/v1/car', { car: this.carHash }, p.key, p.id);
            if (r.status === 403) throw new Error('banned');
            if (r.status === 401) throw new Error('moved');
            if (r.status === 200) { p.carBound = true; this.savePlayer(); }
        }
        // the queue, a few runs at a time (they carry their replays); each batch stays until the server has it
        while (this.queue.length) {
            const batch = this.queue.slice(0, 4);
            const r = await this._signed('/v1/scores', { runs: batch }, p.key, p.id);
            if (r.status === 403) throw new Error('banned');
            if (r.status === 401) throw new Error('moved');
            if (r.status === 429) throw new Error('slow down');
            if (r.status === 400 && r.json && Array.isArray(r.json.rejected)) {
                // malformed (never a real drive): those go, nothing else
                const bad = new Set(r.json.rejected); this.queue = this.queue.filter((q) => !bad.has(q.id)); this.persist();
                if (!bad.size) throw new Error('scores 400');
                continue;
            }
            if (r.status !== 200 || !r.json) throw new Error('scores ' + r.status);
            for (const f of r.json.flagged || []) if (f && f.id) this.flagged[f.id] = f.why || 'under review';
            const ids = new Set(batch.map((b) => b.id));
            this.queue = this.queue.filter((q) => !ids.has(q.id));
            this.persist();
        }
        // the boards
        for (const board of ['all', 'week']) {
            const r = await this._call('GET', '/v1/top?board=' + board + '&limit=20&player=' + encodeURIComponent(p.id));
            if (r.status !== 200 || !r.json) throw new Error('top ' + r.status);
            this.cache[board] = Array.isArray(r.json.rows) ? r.json.rows.slice(0, 20) : [];
            this.cache.players = this.cache.players || {}; this.cache.players[board] = r.json.players || 0;
            this.cache.me[board] = r.json.me || null;
        }
        this.cache.at = Date.now();
        this.persist();
    }
}

module.exports = { Leaderboard, newPlayer, cleanName, validName, randomHex };
