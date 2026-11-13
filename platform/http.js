'use strict';
/**
 * HTTP(S) for the leaderboard (Node 8): one request, a hard timeout, never throws past the promise.
 * No connection, DNS failure or timeout reject; the leaderboard then queues and retries.
 */
function request(method, url, body, ms) {
    return new Promise((resolve, reject) => {
        // settles exactly once: an answer, an error, a connection dropped half way, or the hard timeout
        let done = false, req = null;
        const fail = (e) => { if (done) return; done = true; clearTimeout(timer); try { if (req) req.abort(); } catch (x) { /* gone */ } reject(e instanceof Error ? e : new Error(String(e))); };
        const ok = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => fail(new Error('timeout')), (ms || 8000) + 1000);
        try {
            const u = new (require('url').URL)(url);
            const lib = u.protocol === 'https:' ? require('https') : require('http');
            const data = body ? Buffer.from(JSON.stringify(body)) : null;
            req = lib.request({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
                headers: Object.assign({ 'accept': 'application/json' }, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) }, (res) => {
                const parts = [];
                res.on('data', (d) => parts.push(d));
                res.on('aborted', () => fail(new Error('connection lost')));
                res.on('error', fail);
                res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (e) { /* not json */ } ok({ status: res.statusCode, json }); });
            });
            req.setTimeout(ms || 8000, () => fail(new Error('timeout')));
            req.on('error', fail);
            if (data) req.write(data);
            req.end();
        } catch (e) { fail(e); }
    });
}

module.exports = { request };
