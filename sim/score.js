'use strict';
/**
 * score.js - drift scoring with chains, the way drift games do it.
 *
 * - You are drifting while |angle| >= 10 deg above 20 km/h. Points flow per second from angle x
 *   speed, weighted by how steady the angle is held.
 * - A chain links drifts: it keeps going through transitions and short grip moments (1.4 s of
 *   grace). Every 2.5 s of drifting and every clean transition raises the multiplier (to x6).
 * - Skills pop on top: TRANSITION (by swing rate), BIG ANGLE (>50 deg held 1 s), SPEED DRIFT
 *   (> 80 km/h), LONG DRIFT (each 6 s), SMOOTH (steady angle for 3 s), COUNTER-STEER MASTER.
 * - When the grace runs out the chain is banked: points x multiplier into the total, with a
 *   rating. Spinning (over 110 deg) or stopping mid-chain loses it.
 */

const RATINGS = [
    [0, 'NICE'], [800, 'GREAT'], [2500, 'AWESOME'], [6000, 'INSANE'], [12000, 'LEGENDARY'], [25000, 'GODLIKE'],
];
function ratingOf(p) { let r = RATINGS[0][1]; for (const [t, n] of RATINGS) if (p >= t) r = n; return r; }
function tierOf(p) { let r = 0; RATINGS.forEach(([t], i) => { if (p >= t) r = i; }); return r; }

class Score {
    constructor() { this.reset(); }
    reset() {
        this.total = 0; this.best = 0; this.chain = 0; this.mult = 1; this.active = false; this.drifting = false;
        this.grace = 0; this.driftTime = 0; this.chainTime = 0; this.multClock = 0; this.longClock = 0;
        this.bigClock = 0; this.smoothClock = 0; this.csClock = 0; this.events = []; this.t = 0;
        this.chains = 0; this.longest = 0; this.maxAngle = 0; this.angleSum = 0; this.angleTime = 0;
        this.last = null; this.rate = 0;
    }
    _ev(kind, text, pts, extra) { const e = Object.assign({ kind, text, pts: pts | 0, t: this.t }, extra || {}); this.events.push(e); if (this.events.length > 24) this.events.shift(); return e; }
    _mult(add, why) { const m = Math.min(6, this.mult + add); if (m > this.mult) { this.mult = m; this._ev('mult', why, 0); } }
    update(m, dt) {
        this.t += dt;
        const ang = Math.abs(m.beta), kmh = m.kmh;
        const drifting = ang >= 10 && kmh >= 20 && ang < 110;
        this.drifting = drifting;
        if (this.active && (ang >= 110 || (kmh < 8 && this.grace > 0.3))) {
            this._ev('lost', ang >= 110 ? 'SPUN OUT' : 'CHAIN LOST', -this.chain);
            this.active = false; this.chain = 0; this.mult = 1; this.chainTime = 0; this.rate = 0;
            return this;
        }
        if (drifting) {
            if (!this.active) { this.active = true; this.chain = 0; this.mult = 1; this.chainTime = 0; this.multClock = 0; this.longClock = 0; this.chainMax = 0; this.chains++; }
            this.grace = 0;
            this.driftTime += dt; this.chainTime += dt; this.multClock += dt; this.longClock += dt;
            this.maxAngle = Math.max(this.maxAngle, ang); this.chainMax = Math.max(this.chainMax || 0, ang); this.angleSum += ang * dt; this.angleTime += dt;
            // points per second: angle x speed, held steady pays more
            const steady = 0.7 + 0.3 * m.stability;
            this.rate = Math.min(ang, 75) * Math.max(kmh, 20) * 0.032 * steady;
            this.chain += this.rate * dt;
            if (this.multClock >= 2.5) { this.multClock = 0; this._mult(0.5, 'CHAIN x' + Math.min(6, this.mult + 0.5).toFixed(1)); }
            if (this.longClock >= 6) { this.longClock = 0; this.chain += 150; this._ev('skill', 'LONG DRIFT', 150); }
            if (ang > 50) { this.bigClock += dt; if (this.bigClock >= 1 && this.bigClock - dt < 1) { this.chain += 200; this._ev('skill', 'BIG ANGLE', 200); } } else this.bigClock = 0;
            if (kmh > 80) { this.speedClock = (this.speedClock || 0) + dt; if (this.speedClock >= 1 && this.speedClock - dt < 1) { this.chain += 250; this._ev('skill', 'SPEED DRIFT', 250); } } else this.speedClock = 0;
            if (m.stability > 0.85 && ang > 25) { this.smoothClock += dt; if (this.smoothClock >= 3) { this.smoothClock = 0; this.chain += 100; this._ev('skill', 'SMOOTH', 100); } } else this.smoothClock = 0;
            if (m.cs > 25) { this.csClock += dt; if (this.csClock >= 1.5 && this.csClock - dt < 1.5) { this.chain += 120; this._ev('skill', 'FULL LOCK', 120); } } else this.csClock = 0;
        } else {
            this.rate = 0;
            if (this.active) {
                this.grace += dt;
                if (this.grace > 1.4) this.bank();
            }
        }
        if (m.transition && this.active) {
            const p = Math.round(40 + Math.min(m.flick, 300) * 0.6);
            this.chain += p; this._ev('skill', m.flick > 160 ? 'FLICK!' : 'TRANSITION', p);
            this._mult(0.5, 'CHAIN x' + Math.min(6, this.mult + 0.5).toFixed(1));
        }
        return this;
    }
    bank() {
        const pts = Math.round(this.chain * this.mult);
        this.total += pts; this.best = Math.max(this.best, pts); this.longest = Math.max(this.longest, this.chainTime);
        this._ev('bank', ratingOf(pts) + ' DRIFT', pts, { tier: tierOf(pts), mult: this.mult, time: this.chainTime, maxAngle: this.chainMax || 0 });
        this.last = { pts, rating: ratingOf(pts), tier: tierOf(pts), t: this.t };
        this.active = false; this.chain = 0; this.mult = 1; this.chainTime = 0; this.grace = 0;
    }
    /** chain points shown live (before the multiplier) */
    get avgAngle() { return this.angleTime ? this.angleSum / this.angleTime : 0; }
}

module.exports = { Score, ratingOf, tierOf, RATINGS };
