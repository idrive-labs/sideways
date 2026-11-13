'use strict';
/**
 * hud.js - the screen over the 3D view: drift angle dial, chain and skills, the numbers,
 * the angle trace, and the touch menu. All touch targets of a frame are collected in
 * this.targets ({ x, y, w, h, run }) for the app to hit-test.
 */
const { rgba, pk, fade, hex } = require('../engine/rec');
const poly = require('../engine/poly');
const T = require('../engine/text');
const { angleColour } = require('../fx/world');
const TM = require('./theme');

const WHITE = 0xffffffff;
let DIM = rgba(0.62, 0.68, 0.80, 1), FAINT = rgba(0.45, 0.52, 0.66, 1);
// the M colours, from the M logo: light blue #00A1D6, dark blue #353189, red #E6242E
const MB = hex('#00a1d6'), MV = hex('#353189'), RED = hex('#e6242e');   // the M colours (the stripe, warnings)
let LBLUE = MB, BLUE = MV, VIOLET = MV, TH = TM.theme();
/** the theme's colours into the HUD's names (ui/theme.js) */
function applyTheme(name) {
    TH = TM.setTheme(name);
    DIM = TM.c(TH.dim); FAINT = TM.c(TH.faint); BLUE = TM.c(TH.accent); VIOLET = BLUE; LBLUE = TM.c(TH.accent2);
}
const VG = (a) => TM.c(TH.vig, a / 255);
const TIERS = [hex('#c9ccd2'), hex('#00a1d6'), hex('#ffffff'), hex('#e6242e'), hex('#ffb020'), hex('#ffffff')];
const P = new Float32Array(64), C = new Uint32Array(32);

function fmt(n) { const s = String(Math.round(Math.abs(n))); let o = ''; for (let i = 0; i < s.length; i++) { if (i && (s.length - i) % 3 === 0) o += ','; o += s[i]; } return (n < 0 ? '-' : '') + o; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/** a panel: a tile with the theme's corner radius, its two tones blended, a fine light top edge (sk: unused, the old slant) */
function slant(rec, x, y, w, h, sk, cTop, cBot) {
    const r = Math.min(TH.radius, h / 2, w / 2);
    const m = ((((cTop >>> 24) + (cBot >>> 24)) >> 1) << 24 | ((((cTop >>> 16) & 255) + ((cBot >>> 16) & 255)) >> 1) << 16 | ((((cTop >>> 8) & 255) + ((cBot >>> 8) & 255)) >> 1) << 8 | (((cTop & 255) + (cBot & 255)) >> 1)) >>> 0;
    rec.rrect(x, y, w, h, r, m);
    const a = (cTop & 255) / 255;
    if (h >= 24 && a > 0.5) rec.line(x + r, y + 0.75, x + w - r, y + 0.75, 1, pk(1, 1, 1, TH.edge * a));
}
/** a panel's outline with rounded corners */
function slantLine(rec, x, y, w, h, sk, c, lw) {
    lw = lw || 1.2;
    const r = Math.min(TH.radius, h / 2, w / 2), r0 = Math.max(0, r - lw / 2), r1 = r + lw / 2;
    rec.line(x + r, y, x + w - r, y, lw, c); rec.line(x + w, y + r, x + w, y + h - r, lw, c);
    rec.line(x + w - r, y + h, x + r, y + h, lw, c); rec.line(x, y + h - r, x, y + r, lw, c);
    if (r > 1) { rec.arc(x + r, y + r, r0, r1, -90, 0, c); rec.arc(x + w - r, y + r, r0, r1, 0, 90, c); rec.arc(x + w - r, y + h - r, r0, r1, 90, 180, c); rec.arc(x + r, y + h - r, r0, r1, 180, 270, c); }
}
const dt0 = (h) => Math.min(0.1, h.lastDt || 1 / 60);
/** a heading: the label on the shared baseline, a hairline under the whole width */
const HY = 58;
function header(rec, x, w, label) {
    T.text(rec, 'lab', label, x, HY, DIM, 0, 3);
    rec.rect(x, HY + 12, w, 1, TM.tn(1, 1, 1, 0.14));
}
/** the M tricolour stripe */
function stripe(rec, x, y, w, h, sk) {
    const k = w / 3;
    rec.rect(x, y, k - 3, h, MB);
    rec.rect(x + k, y, k - 3, h, MV);
    rec.rect(x + 2 * k, y, k - 3, h, RED);
}

applyTheme('id7');

class Hud {
    constructor() {
        this.targets = []; this.t = 0; this.menu = false; this.pressed = null; this.pressT = 0; this.scroll = {}; this.scrollArea = null;
        this.trace = new Float32Array(160); this.traceN = 0; this.traceAcc = 0;   // 20 s at 8 Hz
        this.shownAngle = 0; this.shownChain = 0; this.popups = []; this.seen = 0;
    }
    reset() { this.traceN = 0; this.popups = []; this.seen = 0; this.replaySeen = -1; this.dialAngle = 0; this.peakL = 0; this.peakR = 0; this.peakLs = 0; this.peakRs = 0; this.peakAlpha = 0; }
    /** 'id7' or 'id8' (ui/theme.js) */
    setTheme(name) { if (name !== this.themeName) { applyTheme(name); this.themeName = name; } }
    update(dt, M) {
        this.t += dt; this.lastDt = dt;
        const ab = Math.abs(M.m.beta);
        this.shownAngle += (ab - this.shownAngle) * Math.min(1, dt * 14);
        // the dial's needle: the SIGNED angle on the dial (left of centre = the nose to the left), eased,
        // so a change of side sweeps through zero instead of jumping across
        const dialTarget = -clamp(M.m.beta, -100, 100);
        this.dialAngle = (this.dialAngle || 0) + (dialTarget - (this.dialAngle || 0)) * Math.min(1, dt * 12);
        // two peak marks, one per side: the biggest angle reached to the left and to the right in this drift.
        // Each glides out to a new peak; both stay through the combo and fade out together after it
        const cur = this.dialAngle, drifting = Math.abs(M.m.beta) > 8;
        if ((this.peakAlpha || 0) <= 0.001) { this.peakL = 0; this.peakR = 0; this.peakLs = 0; this.peakRs = 0; }
        if (cur < -5) this.peakL = Math.max(this.peakL || 0, -cur);
        if (cur > 5) this.peakR = Math.max(this.peakR || 0, cur);
        const kp = Math.min(1, dt * 6);
        this.peakLs = (this.peakLs || 0) + ((this.peakL || 0) - (this.peakLs || 0)) * kp;
        this.peakRs = (this.peakRs || 0) + ((this.peakR || 0) - (this.peakRs || 0)) * kp;
        this.peakAlpha = clamp((this.peakAlpha || 0) + (drifting ? dt * 4 : -dt * 0.35), 0, 1);
        const chain = M.score.chain * M.score.mult;
        this.shownChain = chain < this.shownChain ? chain : this.shownChain + (chain - this.shownChain) * Math.min(1, dt * 9);
        this.traceAcc += dt;
        while (this.traceAcc >= 1 / 8) {
            this.traceAcc -= 1 / 8;
            if (this.traceN < this.trace.length) this.trace[this.traceN++] = M.m.beta;
            else { this.trace.copyWithin(0, 1); this.trace[this.trace.length - 1] = M.m.beta; }
        }
        // new score events become popups
        const ev = M.score.events;
        for (const e of ev) if (e.t > this.seen) { this.popups.push({ e, t: this.t }); this.seen = e.t; }
        this.popups = this.popups.filter((p) => this.t - p.t < (p.e.kind === 'bank' || p.e.kind === 'lost' ? 3.2 : 2.4));
    }
    tap(id) { this.pressed = id; this.pressT = this.t; }
    target(x, y, w, h, id, run, drag) { this.targets.push({ x, y, w, h, id, run, drag }); }
    /** the topmost target under (x, y) */
    hit(x, y) { for (let i = this.targets.length - 1; i >= 0; i--) { const t = this.targets[i]; if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return t; } return null; }

    draw(rec, M, W, H) {
        this.targets.length = 0; this.scrollArea = null;
        this.W = W; this.H = H;
        if (this.screen === 'edit' || this.screen === 'share') { this._screens(rec, M, W, H); return; }
        if (M.replay) { this._replay(rec, M, W, H); this._screens(rec, M, W, H); return; }
        this._drive(rec, M, W, H);
        this._screens(rec, M, W, H);
    }
    _screens(rec, M, W, H) {
        if (this.screen === 'menu') this._menu(rec, M, W, H);
        else if (this.screen === 'board') this._board(rec, M, W, H);
        else if (this.screen === 'name') this._name(rec, M, W, H);
        else if (this.screen === 'edit') this._edit(rec, M, W, H);
        else if (this.screen === 'share') this._share(rec, M, W, H);
        this._toast(rec, W, H);
        this._popup(rec, W, H);
    }
    _drive(rec, M, W, H) {
        const ab = Math.abs(M.m.beta), shown = this.shownAngle, units = M.units === 'mph';
        // vignette: the HUD reads over the ground
        rec.grad(0, 0, W, 150, [0, VG(0xe0), 1, VG(0)]);
        rec.grad(0, H - 170, W, 170, [0, VG(0), 1, VG(0xf0)]);

        /* ---------- left: drift angle dial ---------- */
        const cx = 262, cy = 330, R = 168;
        // the three headings share one baseline (HY) and one style: the label, a hairline under it, a tag on the right
        header(rec, 34, 420, 'DRIFT ANGLE');
        stripe(rec, 34 + 420 - 72, HY - 11, 72, 10, 5);
        // scale: -100..+100 deg, 12 o'clock = straight
        // the redline: past 60 deg on either side (where a drift turns into a spin), part of the scale itself:
        // the outer track turns red there and so do its ticks; it lights up while the needle is in it
        const RL = 60, inRed = Math.abs(this.dialAngle || 0) >= RL;
        this.redGlow = clamp((this.redGlow || 0) + (inRed ? dt0(this) * 5 : -dt0(this) * 1.5), 0, 1);
        rec.arc(cx, cy, R - 6, R, -RL, RL, TM.tn(0.6, 0.72, 1.0, 0.16));
        for (const sd of [-1, 1]) {
            const a0 = sd < 0 ? -100 : RL, a1 = sd < 0 ? -RL : 100;
            rec.arc(cx, cy, R - 6, R, a0, a1, fade(RED, 0.55 + 0.35 * this.redGlow));
            if (this.redGlow > 0.01) rec.arc(cx, cy, R - 12, R + 6, a0, a1, fade(RED, 0.18 * this.redGlow));
        }
        rec.arc(cx, cy, R - 40, R - 37, -100, 100, TM.tn(0.6, 0.72, 1.0, 0.10));
        for (let d = -90; d <= 90; d += 10) {
            const a = d * Math.PI / 180, s = Math.sin(a), c = -Math.cos(a), big = d % 30 === 0, red = Math.abs(d) >= RL;
            const r0 = R - (big ? 26 : 16), r1 = R - 8;
            const col = red ? fade(RED, big ? 0.9 : 0.6) : big ? TM.tn(0.85, 0.9, 1, 0.75) : TM.tn(0.6, 0.7, 0.9, 0.4);
            rec.line(cx + s * r0, cy + c * r0, cx + s * r1, cy + c * r1, big ? 2.4 : 1.4, col);
            if (big && d !== 0) T.text(rec, 'xs', String(Math.abs(d)), cx + s * (R + 18), cy + c * (R + 18) + 6, red ? fade(RED, 0.85) : FAINT, 0.5);
        }
        // value: from 0 towards the side the nose points (left = negative on the dial)
        const va = clamp(this.dialAngle || 0, -100, 100), av = Math.abs(va);
        if (av > 0.5) {
            const a0 = Math.min(0, va), a1 = Math.max(0, va), col = angleColour(av, 1);
            rec.arc(cx, cy, R - 34, R + 6, a0, a1, fade(col, 0.16));
            rec.arc(cx, cy, R - 30, R - 10, a0, a1, fade(col, 0.95), false);   // square ends: the fill stops exactly at zero and at the needle
        }
        // the needle: always there, straight up at zero too
        { const a = va * Math.PI / 180;
          rec.line(cx + Math.sin(a) * (R - 48), cy - Math.cos(a) * (R - 48), cx + Math.sin(a) * (R + 10), cy - Math.cos(a) * (R + 10), 4, WHITE); }
        // peak marker
        for (const pv of [-(this.peakLs || 0), this.peakRs || 0]) {
            if (Math.abs(pv) <= 2 || this.peakAlpha <= 0.01) continue;
            const pk2 = clamp(pv, -100, 100) * Math.PI / 180;
            rec.line(cx + Math.sin(pk2) * (R + 2), cy - Math.cos(pk2) * (R + 2), cx + Math.sin(pk2) * (R + 16), cy - Math.cos(pk2) * (R + 16), 3, fade(RED, this.peakAlpha));
        }
        // the number
        const big = String(Math.round(shown));
        T.text(rec, 'huge', big, cx - 4, cy + 36, ab > 45 ? hex('#ffe2e8') : WHITE, 0.5, 2);
        T.text(rec, 'mid', '°', cx - 4 + T.width('huge', big, 2) / 2 + 6, cy - 30, DIM, 0);
        T.text(rec, 'labs', ab < 1 ? 'STRAIGHT' : M.m.beta > 0 ? 'LEFT  ‹' : '›  RIGHT', cx, cy + 76, FAINT, 0.5, 4);
        // three numbers under the dial, in the dial's own language: no boxes, hairline separators
        const stat = (x, label, val, unit) => {
            T.text(rec, 'labs', label, x, 470, FAINT, 0, 3);
            const w = T.text(rec, 'mid', val, x, 512, WHITE, 0);
            T.text(rec, 'labs', unit, x + 6 + w, 512, DIM, 0, 1);
        };
        stat(62, 'COUNTER', String(Math.round(M.m.cs)), '°');
        rec.rect(186, 456, 1, 62, TM.tn(1, 1, 1, 0.12));
        stat(204, 'YAW', String(Math.round(Math.abs(M.m.yawRate))), '°/S');
        rec.rect(336, 456, 1, 62, TM.tn(1, 1, 1, 0.12));
        stat(354, 'LAT', Math.abs(M.m.latG).toFixed(2), 'G');

        /* ---------- right: speed, axle slip, transition ---------- */
        const rx = W - 454;
        header(rec, rx, 420, 'SPEED');
        if (!this.hideMode) T.text(rec, 'labs', M.mode === 'LIVE' ? 'LIVE - CAR' : 'DEMO DRIVE', rx + 420, HY, M.mode === 'LIVE' ? hex('#59e39a') : hex('#ffb020'), 1, 2);
        const spd = units ? M.m.kmh / 1.609344 : M.m.kmh;
        const sw = T.text(rec, 'big', String(Math.round(spd)), rx + 30, 186, WHITE, 0, 2);
        T.text(rec, 'sm', units ? 'MPH' : 'KM/H', rx + 44 + sw, 186, DIM, 0, 2);
        // speed bar
        const sp = clamp(M.m.kmh / 160, 0, 1);
        slant(rec, rx + 30, 204, 360, 10, 6, TM.tn(1, 1, 1, 0.08), TM.tn(1, 1, 1, 0.08));
        if (sp > 0.01) { P[0] = 0; slant(rec, rx + 30, 204, Math.max(14, 360 * sp), 10, 6, LBLUE, BLUE); }
        // axle slip angles
        const bar = (y, label, v) => {
            T.text(rec, 'labs', label, rx + 30, y, FAINT, 0, 2);
            const cxb = rx + 250, half = 140, a = clamp(Math.abs(v) / 60, 0, 1) * half * (v >= 0 ? -1 : 1);
            rec.rect(cxb - half, y - 9, half * 2, 6, TM.tn(1, 1, 1, 0.07));
            rec.rect(cxb - 1, y - 14, 2, 16, TM.tn(1, 1, 1, 0.35));
            if (Math.abs(a) > 1) rec.rect(Math.min(cxb, cxb + a), y - 10, Math.abs(a), 8, angleColour(Math.abs(v), 0.95));
            T.text(rec, 'sm', Math.round(Math.abs(v)) + '°', rx + 418, y, WHITE, 1);
        };
        T.text(rec, 'lab', 'TYRE SLIP', rx + 26, 262, DIM, 0, 3);
        bar(300, 'FRONT', M.m.af);
        bar(338, 'REAR', M.m.ar);
        T.text(rec, 'lab', 'TRANSITION', rx + 26, 398, DIM, 0, 3);
        const fl = String(Math.round(Math.max(M.m.flick, M.m.flickAt < 6 ? M.m.flickPeak : 0)));
        T.text(rec, 'mid', fl, rx + 30, 448, WHITE, 0);
        T.text(rec, 'labs', '°/S SWING', rx + 30 + T.width('mid', fl) + 10, 448, DIM, 0, 2);
        T.text(rec, 'lab', 'STEADINESS', rx + 236, 398, DIM, 0, 3);
        const st = clamp(M.m.stability, 0, 1);
        for (let i = 0; i < 10; i++) slant(rec, rx + 236 + i * 18, 424, 14, 24, 4, i < st * 10 ? angleColour(15 + i * 4, 0.95) : TM.tn(1, 1, 1, 0.08), i < st * 10 ? angleColour(15 + i * 4, 0.7) : TM.tn(1, 1, 1, 0.05));
        // estimate quality (live) or the session's numbers: the same label / value pairs, no box
        if (M.mode === 'LIVE') {
            T.text(rec, 'lab', 'ACCURACY  ±', rx + 26, 500, DIM, 0, 3);
            if (M.status) T.text(rec, 'mid', '-', rx + 30, 548, DIM, 0);
            else { const v = (M.sigma || 0).toFixed(1) + '°'; T.text(rec, 'mid', v, rx + 30, 548, M.sigma < 2 ? hex('#59e39a') : M.sigma < 4 ? hex('#ffb020') : RED, 0); }
            T.text(rec, 'lab', 'GPS', rx + 236, 500, DIM, 0, 3);
            T.text(rec, 'sm', M.gps ? 'FUSED' : 'NO FIX', rx + 236, 546, M.gps ? hex('#59e39a') : DIM, 0, 1);
        } else {
            T.text(rec, 'lab', 'MAX ANGLE', rx + 26, 500, DIM, 0, 3);
            T.text(rec, 'mid', Math.round(M.score.maxAngle) + '°', rx + 30, 548, WHITE, 0);
            T.text(rec, 'lab', 'LONGEST', rx + 236, 500, DIM, 0, 3);
            T.text(rec, 'mid', Math.max(M.score.longest, M.score.chainTime).toFixed(1) + 'S', rx + 236, 548, WHITE, 0);
        }

        /* ---------- top centre: the chain (or what live mode waits for) ---------- */
        if (M.status) {
            const tw = T.width('sm', M.status, 2) + 80;
            slant(rec, W / 2 - tw / 2, 40, tw, 54, 12, hex('#ffb020'), hex('#c47e00'));
            T.text(rec, 'sm', M.status, W / 2, 76, 0x101010ff, 0.5, 2);
        } else this._chain(rec, M, W);

        /* ---------- bottom: score, angle trace, best ---------- */
        T.text(rec, 'labs', 'SCORE', W / 2 - 430, H - 34, FAINT, 0, 3);
        T.text(rec, 'sm', fmt(M.score.total), W / 2 - 430 + T.width('labs', 'SCORE', 3) + 12, H - 34, WHITE, 0, 1);
        const bt = fmt(M.score.best);
        T.text(rec, 'sm', bt, W / 2 + 430, H - 34, WHITE, 1, 1);
        T.text(rec, 'labs', 'BEST CHAIN', W / 2 + 430 - T.width('sm', bt, 1) - 12, H - 34, FAINT, 1, 3);

        this._buttons(rec, M, W);
        if (!M.status) this._rank(rec, W);
    }

    /** replay, leaderboard and menu: big touch targets, top right */
    _buttons(rec, M, W) {
        // in the headings' own language: no boxes, a line icon and a label on the bottom row's baseline,
        // a hairline above; the touch area is far bigger than what is drawn
        const A = this.actions || {}, H = this.H, base = H - 34;
        const items = [['menu', 'SETTINGS', () => A.menu && A.menu()], ['board', 'LEADERBOARD', () => A.board && A.board()]];
        let x = W - 34;
        for (const [id, label, run] of items) {
            const down = this.pressed === id && this.t - this.pressT < 0.25, col = down ? WHITE : DIM;
            const lw = T.width('lab', label, 3), w = lw + 50;
            T.text(rec, 'lab', label, x, base, col, 1, 3);
            icon(rec, id, x - lw - 28, base - 7, col);
            rec.rect(x - w, base - 40, w, 1, down ? fade(LBLUE, 0.9) : TM.tn(1, 1, 1, 0.14));
            this.target(x - w - 16, H - 96, w + 32, 96, id, run);
            x -= w + 48;
        }
    }

    _chain(rec, M, W) {
        const S = M.score, cx = W / 2, t = this.t;
        const banner = this.popups.find((p) => (p.e.kind === 'bank' || p.e.kind === 'lost') && t - p.t < 2.6);
        if (S.active && !banner) {
            const chain = this.shownChain;
            header(rec, cx - 300, 600, 'DRIFT CHAIN');
            T.text(rec, 'labs', S.chainTime.toFixed(1) + ' S', cx + 300, HY, DIM, 1, 2);
            const pulse = S.drifting ? 1 + 0.03 * Math.max(0, Math.sin(t * 10)) : 1;
            T.text(rec, 'big', fmt(chain), cx, 152, WHITE, 0.5, 2, pulse);
            // multiplier chip
            const mx = cx + 230;
            slant(rec, mx, 78, 96, 50, 12, RED, RED);
            T.text(rec, 'sm', 'X' + S.mult.toFixed(1), mx + 48, 112, WHITE, 0.5, 1);
            // grace bar: shrinks while not drifting
            const g = S.drifting ? 1 : clamp(1 - S.grace / 1.4, 0, 1);
            rec.rect(cx - 260, 168, 520, 4, TM.tn(1, 1, 1, 0.08));
            rec.rect(cx - 260, 168, 520 * g, 4, S.drifting ? angleColour(Math.abs(M.m.beta), 0.95) : RED);
        }
        // popups
        let row = 0;
        for (const p of this.popups) {
            const e = p.e, age = t - p.t;
            if (e.kind === 'bank' || e.kind === 'lost') {
                const k = ease(age / 0.35), out = clamp((age - 2.6) / 0.6, 0, 1), a = (1 - out);
                const col = e.kind === 'lost' ? RED : TIERS[e.tier || 0];
                if (p !== banner && age < 2.6) continue;
                const y = 112;
                const sc = 0.6 + 0.4 * k;
                slant(rec, cx - 330 * sc, y - 62 * sc, 660 * sc, 136 * sc, 18 * sc, fade(TM.tn(0.04, 0.06, 0.12, 0.92), a), fade(TM.tn(0.02, 0.03, 0.07, 0.92), a));
                rec.rect(cx - 320 * sc, y - 62 * sc, 640 * sc * k, 3, fade(col, a));
                T.text(rec, 'mid', e.text, cx, y - 10 * sc, fade(col, a), 0.5, 4, sc);
                if (e.kind === 'bank') T.text(rec, 'big', '+' + fmt(e.pts), cx, y + 64 * sc, fade(WHITE, a), 0.5, 2, sc * 0.8);
                else T.text(rec, 'sm', fmt(e.pts) + ' LOST', cx, y + 44 * sc, fade(DIM, a), 0.5, 2, sc);
            } else if (S.active && !banner && row < 3) {
                const k = ease(age / 0.25), a = clamp(1 - (age - 1.8) / 0.6, 0, 1);
                const y = 214 + row * 34, x = cx + (1 - k) * 60;
                const col = e.kind === 'mult' ? RED : LBLUE;
                const ptxt = e.pts ? '+' + fmt(e.pts) : '', bw = Math.max(380, T.width('sm', e.text, 1) + T.width('sm', ptxt, 1) + 80);
                slant(rec, x - bw / 2, y - 22, bw, 30, 8, fade(TM.tn(0.05, 0.08, 0.16, 0.85), a), fade(TM.tn(0.03, 0.05, 0.11, 0.85), a));
                rec.rect(x - bw / 2 + 4, y - 22, 4, 30, fade(col, a));
                T.text(rec, 'sm', e.text, x - bw / 2 + 22, y + 1, fade(WHITE, a), 0, 1);
                if (ptxt) T.text(rec, 'sm', ptxt, x + bw / 2 - 14, y + 1, fade(col, a), 1, 1);
                row++;
            }
        }
    }

    /** angle over the last 20 s: a filled band coloured by angle, left = past */
    _trace(rec, x, base, w, h) {
        const n = this.traceN; if (n < 2) return;
        rec.rect(x, base, w, 1, TM.tn(1, 1, 1, 0.15));
        for (const lv of [30, 60]) rec.rect(x, base - h * lv / 90, w, 1, TM.tn(1, 1, 1, 0.05));
        const N = this.trace.length, dx = w / (N - 1), off = N - n;
        let px = 0, py = 0, pc = 0;
        for (let i = 0; i < n; i++) {
            const v = Math.min(Math.abs(this.trace[i]), 90), X = x + (off + i) * dx, Y = base - h * v / 90;
            const c = angleColour(v, 0.9), c0 = angleColour(v, 0.05);
            if (i) {
                rec.tri(px, py, pc, X, Y, c, X, base, c0);
                rec.tri(px, py, pc, X, base, c0, px, base, fade(pc, 0.05));
            }
            px = X; py = Y; pc = c;
        }
        for (let i = 1; i < n; i++) {
            const v0 = Math.min(Math.abs(this.trace[i - 1]), 90), v1 = Math.min(Math.abs(this.trace[i]), 90);
            rec.line(x + (off + i - 1) * dx, base - h * v0 / 90, x + (off + i) * dx, base - h * v1 / 90, 1.6, angleColour(v1, 1));
        }
    }

    /* ---------- the settings, laid out like the car's own menus: categories on the left, rows on the right ---------- */
    _menu(rec, M, W, H) {
        const m = TH.menu, X = (h, a) => TM.hex(h, a);
        const pressed = (id) => this.pressed === id && this.t - this.pressT < 0.25;
        const P = this.panel(rec, W, H, 1500, 624, () => this.actions.close());
        // title (seven quick taps on it: the demo drive's lock)
        T.text(rec, 'mid', 'Settings', P.x + 40, P.y + 58, WHITE, 0, 0);
        rec.rect(P.x + 40, P.y + 72, T.width('mid', 'Settings', 0), 2, X(m.tab));
        this.target(P.x + 20, P.y, T.width('mid', 'Settings', 0) + 60, 84, 'set-title', () => this.actions.titleTap());
        this.panelButton(rec, P.x + 24, P.y + P.h - 24 - 70, 300, 'Done', 'close', () => this.actions.close(), true);

        const groups = [];
        for (const r of M.menuRows || []) { if (r.section) groups.push({ name: r.section, rows: [] }); else if (groups.length) groups[groups.length - 1].rows.push(r); }
        if (!groups.length) return;
        if (!groups.some((g) => g.name === this.menuCat)) this.menuCat = groups[0].name;
        const top = P.y + 100, rh = 80, lx = P.x + 24, lw = 300;
        const sel = (x, y, w, h) => { rec.grad(x, y, w, h, [0, X(m.selEdge), 1, X(m.selMid)]); rec.rect(x, y + h - 3, w, 3, X(m.selLine)); };
        // left: the groups
        groups.forEach((g, k) => {
            const y = top + k * (rh - 8), on = g.name === this.menuCat, id = 'cat' + k, hgt = rh - 10;
            if (on) sel(lx, y, lw, hgt); else rec.rect(lx, y, lw, hgt, pressed(id) ? X(m.surf2) : X(m.surf));
            const name = g.name.charAt(0) + g.name.slice(1).toLowerCase();
            T.text(rec, 'sm', name, lx + 26, y + hgt / 2 + 10, WHITE, 0, 0);
            this.target(lx, y, lw, hgt, id, () => { this.menuCat = g.name; });
        });
        // right: the chosen group's rows
        const g = groups.find((q) => q.name === this.menuCat), px = lx + lw + 20, pw = P.x + P.w - 24 - px;
        rec.rrect(px, top, pw, P.y + P.h - 24 - top, 10, X(m.surf2));
        const cx = px + 360, cw = pw - 360 - 24;
        g.rows.forEach((r, k) => {
            const y = top + k * rh, off = !!r.disabled, A = off ? 0.38 : 1, rid = 'r' + this.menuCat + k;
            if (k < g.rows.length - 1) rec.rect(px + 20, y + rh - 1, pw - 40, 1, X(m.hair, 0.7));
            T.text(rec, 'sm', r.label, px + 28, r.note ? y + 36 : y + 48, fade(WHITE, A), 0, 0);
            if (r.note) T.text(rec, 'xs', r.note, px + 28, y + 62, X(m.text3, off ? 0.8 : 1), 0, 0);
            const by = y + 14, bh = rh - 28;
            const box = (bx, bw, on, id) => {
                if (on && off) { rec.rect(bx, by, bw, bh, X(m.surf, 0.6)); rec.rect(bx, by + bh - 2, bw, 2, X(m.selLine, 0.35)); }
                else if (on) sel(bx, by, bw, bh);
                else rec.rect(bx, by, bw, bh, !off && pressed(id) ? X(m.surf2) : X(m.surf, off ? 0.6 : 1));
            };
            if (r.kind === 'seg') {
                const n = r.options.length, sw = (cw - (n - 1) * 4) / n;
                r.options.forEach((o, q) => {
                    const ox = cx + q * (sw + 4), on = o.id === r.value, id = rid + ':' + q;
                    box(ox, sw, on, id);
                    T.text(rec, 'lab', o.label, ox + sw / 2, by + bh / 2 + 7, fade(on ? WHITE : X(m.text2), A), 0.5, 0);
                    if (!off) this.target(ox, y, sw + 4, rh, id, () => r.set(o.id));
                });
            } else if (r.kind === 'step') {
                const bw = 76;
                [[-1, cx], [1, cx + cw - bw]].forEach(([d, bx]) => {
                    const id = rid + (d < 0 ? ':l' : ':r');
                    box(bx, bw, false, id);
                    const mx = bx + bw / 2, my = by + bh / 2, c = fade(WHITE, A);
                    rec.line(mx - 5 * d, my - 10, mx + 5 * d, my, 2.4, c); rec.line(mx + 5 * d, my, mx - 5 * d, my + 10, 2.4, c);
                    if (!off) this.target(bx, y, bw, rh, id, () => r.set(d));
                });
                T.text(rec, 'sm', String(r.value), cx + cw / 2, by + bh / 2 + 9, fade(WHITE, A), 0.5, 0);
            } else if (r.kind === 'info') {
                T.text(rec, 'sm', String(r.value), cx + cw, by + bh / 2 + 9, X(m.text2), 1, 0);
            } else if (r.kind === 'button') {
                const bw = 200, id = rid;
                T.text(rec, 'sm', String(r.value), cx, by + bh / 2 + 9, X(m.text2), 0, 0);
                const dn2 = pressed(id);
                rec.rect(cx + cw - bw, by, bw, bh, dn2 ? X(m.selMid) : X(m.surf));
                rec.rect(cx + cw - bw, by + bh - 3, bw, 3, r.danger ? RED : X(m.selLine));
                T.text(rec, 'lab', r.action, cx + cw - bw / 2, by + bh / 2 + 7, WHITE, 0.5, 0);
                this.target(cx + cw - bw, y, bw, rh, id, r.run);
            }
        });
    }
}

/* ---------- the editor: the edit plays on the left, its choices on the right, the actions at the bottom ---------- */
Hud.prototype.editBox = function (W, H) { return { x: 24, y: 24, w: 1172, h: H - 24 - 104 }; };
Hud.prototype._edit = function (rec, M, W, H) {
    const A = this.actions, E = M.edit, m = TH.menu, X = (h, a) => TM.hex(h, a);
    if (!E) return;
    const pressed = (id) => this.pressed === id && this.t - this.pressT < 0.25;
    const sel = (x, y, w, h) => { rec.grad(x, y, w, h, [0, X(m.selEdge), 1, X(m.selMid)]); rec.rect(x, y + h - 3, w, 3, X(m.selLine)); };
    // around the preview: the screen's own ground; the preview itself was drawn before this
    const box = this.editBox(W, H), r2 = this.editRect || box;
    rec.rect(0, 0, W, box.y, X(m.bg)); rec.rect(0, box.y + box.h, W, H - box.y - box.h, X(m.bg));
    rec.rect(0, box.y, r2.x, box.h, X(m.bg)); rec.rect(r2.x + r2.w, box.y, W - r2.x - r2.w, box.h, X(m.bg));
    rec.rstroke(8, 6, W - 16, H - 12, 18, 1.5, X(m.hair));            // the editor reads as a panel too
    this.target(0, 0, W, H, 'sheet', () => {});
    // under the preview: play / pause and the timeline
    const py = box.y + box.h + 16, ph = 72;
    const pid = 'ed-play', dn = pressed(pid);
    rec.rect(box.x, py, 96, ph, dn ? X(m.selMid) : X(m.surf));
    { const cx = box.x + 48, cy = py + ph / 2;
      if (E.playing) { rec.rect(cx - 11, cy - 15, 8, 30, WHITE); rec.rect(cx + 3, cy - 15, 8, 30, WHITE); }
      else { P[0] = cx - 10; P[1] = cy - 16; P[2] = cx + 15; P[3] = cy; P[4] = cx - 10; P[5] = cy + 16; poly.fill(rec, P, 3, WHITE, null, 1); } }
    this.target(box.x, py - 8, 96, ph + 16, pid, () => A.editToggle());
    const tx = box.x + 120, tw = box.x + box.w - tx, ty = py + ph / 2, fr = E.d > 0 ? Math.min(1, E.v / E.d) : 0;
    rec.rect(tx, ty - 3, tw, 6, X(m.surf));
    rec.rect(tx, ty - 3, tw * fr, 6, X(m.selLine));
    rec.arc(tx + tw * fr, ty, 0, 12, 0, 360, WHITE);
    T.text(rec, 'labs', E.v.toFixed(1) + ' / ' + E.d.toFixed(1) + ' S', tx + tw, py + 10, X(m.text2), 1, 2);
    this.target(tx - 12, py - 8, tw + 24, ph + 16, 'ed-time', () => {}, (x) => A.editSeek((x - tx) / tw));

    // the right: the choices
    const px = box.x + box.w + 24, pw = W - 24 - px, rh = 80;
    rec.rect(px, box.y, pw, box.h, X(m.surf2));
    T.text(rec, 'mid', 'Edit', px + 24, box.y + 52, WHITE, 0, 0);
    rec.rect(px + 24, box.y + 64, T.width('mid', 'Edit', 0), 2, X(m.tab));
    T.text(rec, 'xs', E.video.toFixed(1) + ' s  /  one camera, fixed', px + pw - 24, box.y + 50, X(m.text3), 1, 0);
    const rows = [
        ['Format', 'format', [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']]],
        ['Camera', 'camera', [['chase', 'Chase'], ['top', 'Top'], ['topwide', 'Top wide']]],
        ['Slow motion', 'slowmo', [['auto', 'At the peak'], ['off', 'Off']]],
        ['Length', 'trim', [['auto', 'The drift'], ['full', 'Whole clip']]],
        ['Overlay', 'overlay', [[true, 'On'], [false, 'Off']]],
    ];
    rows.forEach(([label, key, opts], k) => {
        const y = box.y + 84 + k * rh;
        rec.rect(px, y + rh - 1, pw, 1, X(m.hair, 0.7));
        T.text(rec, 'sm', label, px + 24, y + 30, WHITE, 0, 0);
        const cx = px + 24, cw = pw - 48, by = y + 40, bh = 38;
        const n = opts.length, sw = (cw - (n - 1) * 4) / n;
        opts.forEach(([val, name], q) => {
            const ox = cx + q * (sw + 4), on = E.edit[key] === val, id = 'ed-' + key + q;
            if (on) sel(ox, by, sw, bh); else rec.rect(ox, by, sw, bh, pressed(id) ? X(m.surf2) : X(m.surf));
            T.text(rec, 'lab', name, ox + sw / 2, by + bh / 2 + 7, on ? WHITE : X(m.text2), 0.5, 0);
            this.target(ox, y + 34, sw + 4, rh - 34, id, () => A.editSet(key, val));
        });
    });
    // the bottom: back, and the one thing this screen is for
    const bw = 200, bid = 'ed-back', eid = 'ed-export';
    rec.rect(px, py, bw, ph, pressed(bid) ? X(m.selMid) : X(m.surf));
    rec.rect(px, py + ph - 3, bw, 3, X(m.hair));
    T.text(rec, 'sm', 'Back', px + bw / 2, py + 45, WHITE, 0.5, 0);
    this.target(px, py - 8, bw, ph + 16, bid, () => A.editClose());
    const ex = px + bw + 12, ew = pw - bw - 12, edn = pressed(eid);
    sel(ex, py, ew, ph); if (edn) rec.rect(ex, py, ew, ph, fade(WHITE, 0.2));
    T.text(rec, 'sm', 'Export video', ex + ew / 2, py + 45, WHITE, 0.5, 0);
    this.target(ex, py - 8, ew, ph + 16, eid, () => A.exportStart());
};

/* the export: a QR code for the phone; the phone makes the video and the link deletes itself */
Hud.prototype._share = function (rec, M, W, H) {
    const A = this.actions, S = M.share || { state: 'sending' }, m = TH.menu, X = (h, a) => TM.hex(h, a);
    // a small popup, the size of the code: the title, the code, a line, the buttons
    const P = this.panel(rec, W, H, 540, 664, null);
    const qs = 400, qx = P.x + (P.w - qs) / 2, qy = P.y + 92;
    const left = S.expires ? Math.max(0, Math.round((S.expires - Date.now()) / 1000)) : 0, mmss = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    const fmtName = M.edit ? M.edit.edit.format : '16:9';
    const say = {
        sending: ['Preparing your video', ['One moment.']],
        local: ['Making the video', ['It is saved by itself', 'when it is ready.']],
        'local-done': ['Saved', ['The video is in your downloads.']],
        'local-failed': ['Could not make it', [String(S.error || '').slice(0, 40)]],
        ready: ['Scan with your phone', null],
        downloaded: ['On your phone', ['The video is saved.', 'The link is deleted.']],
        expired: ['The link expired', ['It was not opened in time.', 'Make a new one.']],
        offline: ['No internet', ['The video is made on your phone,', 'through the internet.', 'Connect the car and try again.']],
        'no-server': ['No server set', ['Videos need the leaderboard server.']],
        unregistered: ['Join first', ['Videos go through your account:', 'choose your name on the leaderboard.']],
        'too-long': ['Too long', ['Choose Length: The drift,', 'then try again.']],
        refused: ['Not allowed', ['Your account is used', 'from another install.']],
    }[S.state] || ['Something went wrong', [String(S.error || '').slice(0, 40)]];
    T.text(rec, 'mid', say[0], P.x + P.w / 2, P.y + 62, WHITE, 0.5, 0);
    rec.rrect(qx, qy, qs, qs, 14, S.state === 'ready' ? WHITE : X(m.surf));
    if (S.state === 'ready' && S.qr) {
        const q = S.qr, n = q.size + 6, mod = Math.floor(qs / n), off = (qs - mod * q.size) / 2;
        for (let y = 0; y < q.size; y++) {
            let x = 0;
            while (x < q.size) {
                if (!q.dark(x, y)) { x++; continue; }
                let e = x; while (e < q.size && q.dark(e, y)) e++;
                rec.rect(qx + off + x * mod, qy + off + y * mod, (e - x) * mod, mod, 0x000000ff);
                x = e;
            }
        }
        T.text(rec, 'labs', fmtName + ' VIDEO  /  THE LINK DELETES ITSELF IN ' + mmss, P.x + P.w / 2, qy + qs + 36, X(m.text3), 0.5, 1);
    } else {
        const cx = qx + qs / 2, cy = qy + 130;
        if (S.state === 'sending' || S.state === 'local') { const a = (this.t * 300) % 360; rec.arc(cx, cy, 40, 47, a, a + 260, X(m.selLine)); }
        else if (S.state === 'downloaded' || S.state === 'local-done') { rec.line(cx - 48, cy, cx - 12, cy + 36, 9, hex('#59e39a')); rec.line(cx - 12, cy + 36, cx + 56, cy - 36, 9, hex('#59e39a')); }
        else { rec.arc(cx, cy, 40, 47, 0, 360, hex('#ffb020')); rec.line(cx - 29, cy - 29, cx + 29, cy + 29, 7, hex('#ffb020')); }
        (say[1] || []).forEach((l, i) => T.text(rec, 'sm', l, cx, cy + 110 + i * 40, X(m.text2), 0.5, 0));
    }
    // the buttons, side by side at the bottom
    const by = P.y + P.h - 24 - 70, bw = (P.w - 48 - 12) / 2;
    const done = S.state === 'downloaded' || S.state === 'local-done';
    this.panelButton(rec, P.x + 24, by, bw, done ? 'Done' : 'Close', 'sh-done', () => A.shareClose(), done);
    if (S.state === 'offline' || S.state === 'unregistered' || S.state === 'expired') {
        this.panelButton(rec, P.x + 36 + bw, by, bw, S.state === 'unregistered' ? 'Join' : 'Try again', 'sh-retry', () => (S.state === 'unregistered' ? A.join() : A.exportStart()), true);
    } else if (!done) this.panelButton(rec, P.x + 36 + bw, by, bw, 'Edit again', 'sh-edit', () => A.shareEdit());
};

/** line icons: menu, board (trophy), replay (circular arrow) */
function icon(rec, id, cx, cy, col) {
    const c = col === undefined ? WHITE : col;
    if (id === 'menu') { for (let i = -1; i <= 1; i++) rec.rect(cx - 13, cy - 2 + i * 9, 26, 3, c); return; }
    if (id === 'board') {
        rec.arc(cx, cy - 6, 0, 11, 90, 270, c);                         // cup
        rec.rect(cx - 11, cy - 13, 22, 7, c);
        rec.rect(cx - 2, cy + 3, 4, 7, c); rec.rect(cx - 8, cy + 10, 16, 3, c);
        rec.arc(cx - 11, cy - 7, 3, 5.5, 180, 360, c); rec.arc(cx + 11, cy - 7, 3, 5.5, 0, 180, c);
        return;
    }
    if (id === 'replay') {
        rec.arc(cx, cy, 9, 12, 40, 330, c, true);
        P[0] = cx + 1; P[1] = cy - 17; P[2] = cx + 10; P[3] = cy - 10; P[4] = cx + 0; P[5] = cy - 5;
        poly.fill(rec, P, 3, c, null, 1);
    }
}

Hud.prototype._replay = function (rec, M, W, H) {
    const R = M.replay, st = R.st, A = this.actions, t = this.t;
    this.target(0, 0, W, H, 'rp-scene', () => {});                 // the scene itself: the freestyle camera's (core.js)
    rec.grad(0, 0, W, 130, [0, VG(0xd8), 1, VG(0)]);
    rec.grad(0, H - 190, W, 190, [0, VG(0), 1, VG(0xf2)]);
    // title: what is being replayed
    slant(rec, 34, 34, 320, 44, 12, RED, RED);
    T.text(rec, 'sm', 'REPLAY', 64, 64, WHITE, 0, 4);
    const blink = Math.sin(t * 6) > 0 ? 1 : 0.35;
    rec.arc(330, 56, 0, 7, 0, 360, fade(WHITE, blink));
    const meta = R.meta || {};
    if (meta.text) T.text(rec, 'lab', String(meta.text).toUpperCase() + (meta.pts ? '  +' + fmt(meta.pts) : ''), 380, 64, DIM, 0, 3);
    if (meta.name) T.text(rec, 'labs', 'DRIVER  ' + meta.name, 380, 86, FAINT, 0, 3);
    // the numbers of that moment
    const ab = Math.abs(st.beta || 0);
    T.text(rec, 'labs', 'DRIFT ANGLE', 60, H - 214, FAINT, 0, 3);
    T.text(rec, 'big', String(Math.round(ab)) + '°', 56, H - 128, ab > 45 ? hex('#ffe2e8') : WHITE, 0, 2);
    T.text(rec, 'labs', 'SPEED', W - 60, H - 214, FAINT, 1, 3);
    T.text(rec, 'big', String(Math.round(M.units === 'mph' ? st.kmh / 1.609344 : st.kmh)), W - 60, H - 128, WHITE, 1, 2);
    if (st.chain > 0) {
        T.text(rec, 'big', fmt(st.chain), W / 2, 150, WHITE, 0.5, 2);
        slant(rec, W / 2 + 250, 78, 96, 50, 12, RED, RED);
        T.text(rec, 'sm', 'X' + (st.mult || 1).toFixed(1), W / 2 + 298, 112, WHITE, 0.5, 1);
    }
    // the clip's score events, at their moment
    let row = 0;
    for (const e of R.events || []) {
        const age = R.t - e.at;
        if (age < 0 || age > 2.2 || row > 2) continue;
        const a = clamp(1 - (age - 1.6) / 0.6, 0, 1), col = e.kind === 'bank' ? TIERS[e.tier || 0] : e.kind === 'lost' ? RED : e.kind === 'mult' ? RED : LBLUE;
        const y = 214 + row * 36, ptxt = e.pts > 0 ? '+' + fmt(e.pts) : '';
        const bw = Math.max(400, T.width('sm', e.text, 1) + T.width('sm', ptxt, 1) + 90), bx = W / 2 - bw / 2;
        slant(rec, bx, y - 24, bw, 32, 8, fade(TM.tn(0.05, 0.08, 0.16, 0.85), a), fade(TM.tn(0.03, 0.05, 0.11, 0.85), a));
        rec.rect(bx + 4, y - 24, 4, 32, fade(col, a));
        T.text(rec, 'sm', e.text, bx + 22, y, fade(WHITE, a), 0, 1);
        if (ptxt) T.text(rec, 'sm', ptxt, bx + bw - 14, y, fade(col, a), 1, 1);
        row++;
    }
    // controls: play / pause, speed, camera, timeline, exit
    const by = H - 92, bh = 60;
    const btn = (x, w, id, label, run, on) => {
        const down = this.pressed === id && this.t - this.pressT < 0.25;
        slant(rec, x, by, w, bh, 12, down || on ? BLUE : TM.tn(0.10, 0.16, 0.30, 0.92), down || on ? BLUE : TM.tn(0.06, 0.10, 0.20, 0.92));
        if (label === 'PLAY' || label === 'PAUSE') {
            const cx = x + w / 2, cy = by + bh / 2;
            if (label === 'PAUSE') { rec.rect(cx - 10, cy - 13, 7, 26, WHITE); rec.rect(cx + 3, cy - 13, 7, 26, WHITE); }
            else { P[0] = cx - 9; P[1] = cy - 14; P[2] = cx + 13; P[3] = cy; P[4] = cx - 9; P[5] = cy + 14; poly.fill(rec, P, 3, WHITE, null, 1); }
        } else T.text(rec, 'sm', label, x + w / 2, by + 39, WHITE, 0.5, 1);
        this.target(x - 6, by - 12, w + 12, bh + 24, id, run);
    };
    const x0 = W / 2 - 520;
    btn(x0, 96, 'rp-play', R.playing ? 'PAUSE' : 'PLAY', () => A.replayToggle());
    btn(x0 + 110, 120, 'rp-speed', R.speed === 1 ? '1X' : R.speed === 0.5 ? '0.5X' : '0.25X', () => A.replaySpeed(), R.speed !== 1);
    btn(x0 + 244, 170, 'rp-cam', R.cam === 'topwide' ? 'TOP WIDE' : String(R.cam).toUpperCase(), () => A.replayCam(), R.cam === 'free');
    // freestyle: zoom buttons at the right edge (a pinch does the same where the screen sends two fingers)
    if (R.cam === 'free') {
        const zx = W - 104, zb = (yy, id, plus, k) => {
            const dn = this.pressed === id && this.t - this.pressT < 0.25;
            slant(rec, zx, yy, 70, 64, 10, dn ? BLUE : TM.tn(0.10, 0.16, 0.30, 0.92), dn ? BLUE : TM.tn(0.06, 0.10, 0.20, 0.92));
            rec.rect(zx + 22, yy + 30, 26, 4, WHITE); if (plus) rec.rect(zx + 33, yy + 19, 4, 26, WHITE);
            this.target(zx - 8, yy - 6, 86, 76, id, () => A.replayZoom(k));
        };
        zb(H / 2 - 90, 'rp-zin', true, 0.8); zb(H / 2 - 10, 'rp-zout', false, 1.25);
    }
    T.text(rec, 'labs', R.cam === 'free' ? 'DRAG TO ORBIT  /  PINCH OR + - TO ZOOM' : 'DRAG THE CAR TO LOOK AROUND', x0, by - 14, FAINT, 0, 3);
    btn(W / 2 + 400, 120, 'rp-exit', 'EXIT', () => A.replayExit());
    // your own drift: edit it into a video (someone else's can only be watched)
    const own = !!(R.meta && R.meta.own);
    if (own) btn(W / 2 + 214, 172, 'rp-edit', 'EDIT VIDEO', () => A.editOpen(), true);
    // timeline: drag to scrub
    const tx = x0 + 434, tw = (own ? W / 2 + 196 : W / 2 + 380) - tx, ty = by + bh / 2;
    rec.rect(tx, ty - 3, tw, 6, TM.tn(1, 1, 1, 0.12));
    const fr = R.d > 0 ? R.t / R.d : 0;
    rec.rect(tx, ty - 3, tw * fr, 6, LBLUE);
    for (const e of R.events || []) if (e.kind === 'bank' || e.kind === 'skill') rec.rect(tx + tw * (e.at / R.d) - 1, ty - 11, 2, 22, e.kind === 'bank' ? RED : fade(WHITE, 0.4));
    rec.arc(tx + tw * fr, ty, 0, 12, 0, 360, WHITE);
    T.text(rec, 'labs', R.t.toFixed(1) + ' / ' + R.d.toFixed(1) + ' S', tx + tw, by - 6, DIM, 1, 2);
    const seek = (x) => A.replaySeek((x - tx) / tw);
    this.target(tx - 10, by - 10, tw + 20, bh + 20, 'rp-time', () => {}, seek);
};

/* the leaderboard: all time, this week, and this car's own drifts; a tap plays that drift */
function ago(ts) {
    const s2 = Math.max(0, (Date.now() - ts) / 1000);
    return s2 < 90 ? 'JUST NOW' : s2 < 3600 ? Math.round(s2 / 60) + ' MIN AGO' : s2 < 86400 ? Math.round(s2 / 3600) + ' H AGO' : Math.round(s2 / 86400) + ' DAYS AGO';
}
function playIcon(rec, x, y, c) { P[0] = x - 7; P[1] = y - 9; P[2] = x + 9; P[3] = y; P[4] = x - 7; P[5] = y + 9; poly.fill(rec, P, 3, c, null, 1); }
Hud.prototype._board = function (rec, M, W, H) {
    const A = this.actions, L = M.lb, tab = this.boardTab || 'all';
    rec.rect(0, 0, W, H, TM.tn(0.01, 0.015, 0.03, 0.88));
    this.target(0, 0, W, H, 'scrim', () => A.close());
    const px = W / 2 - 660, py = 34, pw = 1320, ph = 652;
    slant(rec, px, py, pw, ph, 24, TM.tn(0.06, 0.09, 0.18, 0.97), TM.tn(0.03, 0.05, 0.10, 0.97));
    slantLine(rec, px, py, pw, ph, 24, TM.tn(0.4, 0.6, 1.0, 0.25), 1.2);
    this.target(px, py, pw, ph, 'sheet', () => {});
    stripe(rec, px + 60, py + 24, 96, 12, 4);
    T.text(rec, 'mid', 'LEADERBOARD', px + 60, py + 84, WHITE, 0, 6);
    const online = L.status === 'online' || (L.status === 'syncing' && L.at && Date.now() - L.at < 120000);
    const st = !M.lbUrl ? ['NO LEADERBOARD SERVER SET', DIM] : online ? ['ONLINE', hex('#59e39a')] : L.status === 'syncing' ? ['CONNECTING...', LBLUE]
        : L.status === 'name-taken' ? ['THAT NAME IS TAKEN: CHOOSE ANOTHER IN SETTINGS', RED] : ['OFFLINE', hex('#ffb020')];
    T.text(rec, 'labs', st[0] + (L.queued ? '  /  ' + L.queued + ' DRIFT' + (L.queued > 1 ? 'S' : '') + ' WAITING TO UPLOAD' : ''), px + 64, py + 112, st[1], 0, 2);
    // close
    const cx = px + 40, cy = py + ph - 76;
    slant(rec, cx, cy, 150, 56, 12, RED, RED);
    T.text(rec, 'sm', 'CLOSE', cx + 75, cy + 37, WHITE, 0.5, 2);
    this.target(cx - 10, cy - 10, 170, 76, 'close', () => A.close());
    // tabs
    const tabs = [['all', 'ALL TIME'], ['week', 'THIS WEEK'], ['mine', 'MY DRIFTS']];
    tabs.forEach(([id, label], i) => {
        const tx = px + 520 + i * 190, on = tab === id;
        slant(rec, tx, py + 30, 176, 52, 12, on ? BLUE : TM.tn(0.10, 0.16, 0.30, 0.9), on ? BLUE : TM.tn(0.06, 0.10, 0.20, 0.9));
        T.text(rec, 'sm', label, tx + 88, py + 64, on ? WHITE : DIM, 0.5, 1);
        this.target(tx - 4, py + 20, 184, 70, 'tab-' + id, () => A.boardTab(id));
    });
    const lx = px + 64, lw = pw - 128, top = py + 138, rh = 46;
    // the list: it scrolls inside its window (a drag), the driver's own place stays fixed below it
    const listH = tab === 'mine' ? ph - 138 - 96 : ph - 138 - 186, VIS = Math.floor(listH / rh);
    const key = 'board-' + tab, scroll = (n) => {
        const max = Math.max(0, n * rh - VIS * rh);
        this.scroll[key] = clamp(this.scroll[key] || 0, 0, max);
        this.scrollArea = { x: lx - 12, y: top, w: lw + 24, h: VIS * rh, key, max };
        return this.scroll[key];
    };
    const list = (items, draw) => {
        const off = scroll(items.length), first = Math.floor(off / rh);
        rec.clip(lx - 14, top, lw + 28, VIS * rh);
        for (let i = first; i < Math.min(items.length, first + VIS + 1); i++) draw(items[i], i, top + i * rh - off);
        rec.noclip();
        // where the list is: a thin bar at the right when it is longer than its window
        if (items.length > VIS) {
            const bh = VIS * rh * VIS / items.length, by = top + (VIS * rh - bh) * off / Math.max(1, items.length * rh - VIS * rh);
            rec.rect(lx + lw + 18, top, 3, VIS * rh, TM.tn(1, 1, 1, 0.08)); rec.rect(lx + lw + 18, by, 3, bh, TM.tn(0.4, 0.6, 1.0, 0.6));
        }
    };
    const inList = (y, h) => y + h > top && y < top + VIS * rh;
    const row = (y, i, id, cells, playable, mine, delId) => {
        if (mine) slant(rec, lx - 12, y, lw + 24, rh - 6, 8, TM.tn(0.11, 0.41, 0.83, 0.45), TM.tn(0.11, 0.41, 0.83, 0.28));
        else if (i % 2 === 0) rec.rect(lx - 12, y, lw + 24, rh - 6, TM.tn(1, 1, 1, 0.025));
        cells(y + 29);
        const right = delId ? lx + lw - 70 - 60 : lx + lw - 70;
        if (playable) {
            const down = this.pressed === id && this.t - this.pressT < 0.25;
            slant(rec, right, y + 3, 76, rh - 12, 8, down ? BLUE : TM.tn(0.12, 0.2, 0.38, 0.95), down ? BLUE : TM.tn(0.08, 0.13, 0.26, 0.95));
            playIcon(rec, right + 40, y + (rh - 6) / 2, WHITE);
            if (inList(y, rh)) this.target(lx - 12, Math.max(y, top), lw + 24, Math.min(rh - 6, top + VIS * rh - y), id, playable);
        }
        if (delId) {                                                         // X: delete this drift
            const xid = 'x' + delId, down = this.pressed === xid && this.t - this.pressT < 0.25, bx = lx + lw - 46, cy = y + (rh - 6) / 2;
            slant(rec, bx, y + 3, 56, rh - 12, 8, down ? RED : TM.tn(0.20, 0.07, 0.09, 0.9), down ? RED : TM.tn(0.14, 0.05, 0.07, 0.9));
            rec.line(bx + 20, cy - 8, bx + 36, cy + 8, 2.6, WHITE); rec.line(bx + 36, cy - 8, bx + 20, cy + 8, 2.6, WHITE);
            if (inList(y, rh)) this.target(bx - 6, Math.max(y, top), 68, Math.min(rh - 6, top + VIS * rh - y), xid, () => A.historyDelete(delId));
        }
    };
    if (tab === 'mine') {
        const hs = M.history || [];
        if (!hs.length) T.text(rec, 'sm', 'NO DRIFTS SAVED YET: BANK A CHAIN ON LIVE CAR DATA AND IT APPEARS HERE', lx, top + 40, FAINT, 0, 1);
        list(hs, (h, i, y) => row(y, i, 'h' + h.id, (yy) => {
            T.text(rec, 'sm', String(h.text || '').replace(' DRIFT', ''), lx + 10, yy, TIERS[h.tier || 0], 0, 1);
            T.text(rec, 'labs', ago(h.ts), lx + 250, yy - 1, FAINT, 0, 2);
            T.text(rec, 'labs', Math.round(h.maxAngle || 0) + '° MAX  /  ' + (h.time || 0).toFixed(1) + ' S', lx + 410, yy - 1, DIM, 0, 2);
            T.text(rec, 'labs', h.review ? 'UNDER REVIEW' : h.waiting ? 'WAITING TO UPLOAD' : 'UPLOADED', lx + 640, yy - 1, h.review || h.waiting ? hex('#ffb020') : hex('#59e39a'), 0, 2);
            T.text(rec, 'sm', fmt(h.pts), lx + lw - 160, yy, WHITE, 1, 1);
        }, () => A.playRun(h.id, true), false, h.id));
    } else if (L.status === 'banned' || L.status === 'moved') {
        this.scrollArea = null;
        const banned = L.status === 'banned';
        T.text(rec, 'mid', banned ? 'ACCOUNT BLOCKED' : 'YOUR ACCOUNT MOVED', W / 2, top + 150, WHITE, 0.5, 3);
        T.text(rec, 'labs', banned ? 'THIS CAR IS BLOCKED ON THE LEADERBOARD  /  YOUR DRIFTS STAY ON THIS CAR' : 'IT IS NOW USED FROM ANOTHER INSTALL OF THE APP  /  YOUR DRIFTS HERE ARE KEPT', W / 2, top + 192, DIM, 0.5, 2);
        if (!banned) {
            const bw = 320, bx = W / 2 - bw / 2, by = top + 240, dn = this.pressed === 'join' && this.t - this.pressT < 0.25;
            slant(rec, bx, by, bw, 70, 14, dn ? BLUE : TM.tn(0.11, 0.41, 0.83, 0.9), TM.tn(0.07, 0.25, 0.55, 0.9));
            T.text(rec, 'sm', 'TAKE IT BACK', W / 2, by + 45, WHITE, 0.5, 2);
            this.target(bx - 8, by - 8, bw + 16, 86, 'join', () => A.join());
        }
    } else if (M.lbUrl && !(M.player && M.player.registered && M.player.key)) {
        // no name yet: the boards are locked until the driver joins (a name, checked online)
        this.scrollArea = null;
        T.text(rec, 'mid', 'JOIN THE LEADERBOARD', W / 2, top + 150, WHITE, 0.5, 3);
        T.text(rec, 'labs', 'CHOOSE A DRIVER NAME: IT IS YOURS ALONE, NOBODY ELSE CAN TAKE IT', W / 2, top + 192, DIM, 0.5, 2);
        T.text(rec, 'labs', 'NEEDS AN INTERNET CONNECTION  /  YOUR LIVE DRIFTS SO FAR ARE SENT WHEN YOU JOIN', W / 2, top + 222, FAINT, 0.5, 2);
        const bw = 320, bx = W / 2 - bw / 2, by = top + 260, dn = this.pressed === 'join' && this.t - this.pressT < 0.25;
        slant(rec, bx, by, bw, 70, 14, dn ? BLUE : TM.tn(0.11, 0.41, 0.83, 0.9), TM.tn(0.07, 0.25, 0.55, 0.9));
        T.text(rec, 'sm', 'CHOOSE MY NAME', W / 2, by + 45, WHITE, 0.5, 2);
        this.target(bx - 8, by - 8, bw + 16, 86, 'join', () => A.join());
    } else if (!M.lbUrl || !online) {
        this.scrollArea = null;
        // offline: nothing old is shown, only what to do
        const msg = !M.lbUrl ? 'THE LEADERBOARD SERVER IS NOT SET' : L.status === 'syncing' ? 'CONNECTING TO THE LEADERBOARD...' : 'NO INTERNET CONNECTION';
        const sub = !M.lbUrl ? 'SET leaderboardUrl IN app.json (SEE THE README)' : L.status === 'syncing' ? '' : 'CONNECT THE CAR TO THE INTERNET TO SEE THE LEADERBOARD. YOUR DRIFTS ARE KEPT AND UPLOADED THEN.';
        rec.arc(W / 2, top + 150, 50, 56, 0, 360, TM.tn(1, 0.69, 0.13, 0.85));
        rec.line(W / 2 - 36, top + 114, W / 2 + 36, top + 186, 6, TM.tn(1, 0.69, 0.13, 0.85));
        T.text(rec, 'mid', msg, W / 2, top + 270, WHITE, 0.5, 3);
        if (sub) T.text(rec, 'labs', sub, W / 2, top + 310, DIM, 0.5, 2);
    } else {
        const rows = ((tab === 'week' ? L.boards.week : L.boards.all) || []).slice(0, 20), me = tab === 'week' ? L.me.week : L.me.all;
        const players = (L.players || {})[tab] || 0;
        if (!rows.length) T.text(rec, 'sm', 'NO RANKED DRIFTS YET', lx, top + 40, FAINT, 0, 1);
        list(rows, (r, i, y) => row(y, i, 'r' + (r.run || i), (yy) => {
            T.text(rec, 'sm', String(r.rank), lx + 34, yy, r.rank <= 3 ? TIERS[5 - r.rank] : DIM, 1, 1);
            T.text(rec, 'sm', String(r.name), lx + 60, yy, WHITE, 0, 1);
            if (r.body) T.text(rec, 'labs', String(r.body).toUpperCase(), lx + 520, yy - 1, FAINT, 0, 2);
            if (r.angle) T.text(rec, 'labs', Math.round(r.angle) + '° MAX', lx + 700, yy - 1, DIM, 0, 2);
            T.text(rec, 'sm', fmt(r.score), lx + lw - 100, yy, r.me ? WHITE : LBLUE, 1, 1);
        }, r.replay ? () => A.playRun(r.run, r.me) : null, r.me));
        // your place: its own section, fixed under the list (it does not scroll)
        const sx = px + 230, sw = px + pw - 40 - sx, sy = top + VIS * rh + 10, sh = 88;
        slant(rec, sx, sy, sw, sh, 14, TM.tn(0.10, 0.20, 0.42, 0.55), TM.tn(0.04, 0.08, 0.18, 0.55));
        rec.rect(sx + 14, sy, sw - 14, 2, fade(LBLUE, 0.55));
        // the stripe, slanted, at its left edge
        [MB, MV, RED].forEach((c, i) => slant(rec, sx + 22 + i * 13, sy + 18, 9, sh - 36, 6, c, c));
        const lx2 = sx + 80;
        T.text(rec, 'labs', 'YOUR PLACE', lx2, sy + 30, DIM, 0, 3);
        if (me) {
            const rank = '#' + fmt(me.rank), all = Math.max(players, me.rank);
            const rw = T.text(rec, 'mid', rank, lx2, sy + 72, WHITE, 0, 1);
            // the share of drivers behind you, as a badge
            if (all >= 10) {
                const pct = me.rank / all * 100, tag = me.rank === 1 ? 'FIRST' : 'TOP ' + (pct < 1 ? pct.toFixed(1) : pct < 10 ? pct.toFixed(1) : Math.ceil(pct)) + '%';
                const bw = T.width('labs', tag, 2) + 28, bx = lx2 + rw + 22;
                slant(rec, bx, sy + 44, bw, 32, 8, BLUE, BLUE);
                T.text(rec, 'labs', tag, bx + bw / 2, sy + 66, WHITE, 0.5, 2);
                T.text(rec, 'labs', 'OF ' + fmt(all) + ' DRIVERS', bx + bw + 18, sy + 66, FAINT, 0, 2);
            }
            T.text(rec, 'labs', 'DRIVER', sx + sw * 0.56, sy + 30, DIM, 0, 3);
            T.text(rec, 'sm', String((M.player && M.player.name) || ''), sx + sw * 0.56, sy + 66, WHITE, 0, 1);
            T.text(rec, 'labs', 'BEST', sx + sw - 30, sy + 30, DIM, 1, 3);
            T.text(rec, 'mid', fmt(me.score), sx + sw - 30, sy + 72, WHITE, 1, 1);
        } else T.text(rec, 'sm', M.player ? 'NO RANKED DRIFT YET  /  LIVE CAR DATA ONLY' : 'CHOOSE YOUR NAME TO JOIN', lx2, sy + 66, WHITE, 0, 1);
    }
};

/**
 * a popup's panel over what is behind it (the drive, a replay): the rest of the screen dimmed, a
 * rounded panel in the middle. outside: what a tap beside the panel does (null: nothing).
 */
Hud.prototype.panel = function (rec, W, H, w, h, outside) {
    const m = TH.menu, X = (c, a) => TM.hex(c, a);
    const x = Math.round((W - w) / 2), y = Math.round((H - h) / 2);
    rec.rect(0, 0, W, H, TM.tn(0, 0, 0, 0.62));
    this.target(0, 0, W, H, 'scrim', outside || (() => {}));
    rec.rrect(x - 1, y - 1, w + 2, h + 2, 19, X(m.hair, 0.9));
    rec.rrect(x, y, w, h, 18, X(m.bg));
    this.target(x, y, w, h, 'sheet', () => {});
    return { x, y, w, h };
};
/* the closing button of a popup: bottom left, where the hand rests */
Hud.prototype.panelButton = function (rec, x, y, w, label, id, run, primary) {
    const m = TH.menu, X = (c, a) => TM.hex(c, a), dn = this.pressed === id && this.t - this.pressT < 0.25, h = 70;
    if (primary) { rec.grad(x, y, w, h, [0, X(m.selEdge), 1, X(m.selMid)]); rec.rect(x, y + h - 3, w, 3, X(m.selLine)); if (dn) rec.rect(x, y, w, h, fade(WHITE, 0.15)); }
    else { rec.rect(x, y, w, h, dn ? X(m.selMid) : X(m.surf)); rec.rect(x, y + h - 3, w, 3, X(m.hair)); }
    T.text(rec, 'sm', label, x + w / 2, y + 45, WHITE, 0.5, 0);
    this.target(x, y - 6, w, h + 12, id, run);
};

/* a short message over everything */
/* the rank card: under the chain, after a bank (what it means against everyone) */
Hud.prototype.rank = function (lines) { this.rankLines = lines && lines.length ? lines : null; this.rankAt = this.t; };
Hud.prototype._rank = function (rec, W) {
    if (!this.rankLines) return;
    const age = this.t - this.rankAt - 0.6;                  // after the banner has landed
    if (age < 0 || age > 5) return;
    const a = clamp(Math.min(age / 0.25, (5 - age) / 0.5), 0, 1), y0 = 196;
    this.rankLines.forEach((l, i) => {
        const col = l.tone === 'gold' ? hex('#ffb020') : l.tone === 'blue' ? LBLUE : DIM, w = T.width('sm', l.text, 2) + 60, y = y0 + i * 44;
        slant(rec, W / 2 - w / 2, y, w, 38, 8, fade(TM.tn(0.05, 0.08, 0.16, 0.9), a), fade(TM.tn(0.03, 0.05, 0.11, 0.9), a));
        rec.rect(W / 2 - w / 2, y, 4, 38, fade(col, a));
        T.text(rec, 'sm', l.text, W / 2, y + 27, fade(col, a), 0.5, 2);
    });
};
/*
 * a popup: what went wrong (or what is happening), in words, over everything, with its buttons -
 * { title, text, tone: 'error' | 'info' | 'busy', buttons: [{ label, run, primary }] }. While it is
 * open nothing under it takes a tap. A 'busy' popup has a spinner and may have no buttons.
 */
Hud.prototype.popupShow = function (p) { this.popup = p || null; this.popupAt = this.t; };
Hud.prototype._popup = function (rec, W, H) {
    const p = this.popup;
    if (!p) return;
    const m = TH.menu, X = (h, a) => TM.hex(h, a), tone = p.tone === 'error' ? hex('#ffb020') : p.tone === 'busy' ? X(m.selLine) : LBLUE;
    rec.rect(0, 0, W, H, TM.tn(0, 0, 0, 0.62));
    this.target(0, 0, W, H, 'popup-sheet', () => {});
    const w = 860, h = 330, x = (W - w) / 2, y = (H - h) / 2 - 10;
    rec.rect(x, y, w, h, X(m.panel));
    rec.rect(x, y, 6, h, tone);
    T.text(rec, 'mid', String(p.title || ''), x + 48, y + 72, WHITE, 0, 2);
    // the text, wrapped to the box
    const words = String(p.text || '').split(' '), lines = [];
    let cur = '';
    for (const wd of words) { const t = cur ? cur + ' ' + wd : wd; if (T.width('sm', t, 1) > w - 96 && cur) { lines.push(cur); cur = wd; } else cur = t; }
    if (cur) lines.push(cur);
    lines.slice(0, 4).forEach((l, i) => T.text(rec, 'sm', l, x + 48, y + 124 + i * 36, X(m.text2), 0, 1));
    if (p.tone === 'busy') { const a = (this.t * 300) % 360; rec.arc(x + w - 70, y + 62, 18, 23, a, a + 260, tone); }
    // the buttons: along the bottom, the main one on the right
    const bs = p.buttons || [], bw = 230, bh = 66, by = y + h - bh - 26;
    bs.forEach((b, i) => {
        const bx = x + w - 48 - (bs.length - i) * (bw + 14) + 14, id = 'pp' + i, dn = this.pressed === id && this.t - this.pressT < 0.25;
        if (b.primary) { rec.grad(bx, by, bw, bh, [0, X(m.selEdge), 1, X(m.selMid)]); rec.rect(bx, by + bh - 3, bw, 3, X(m.selLine)); }
        else { rec.rect(bx, by, bw, bh, dn ? X(m.surf2) : X(m.surf)); rec.rect(bx, by + bh - 3, bw, 3, X(m.hair)); }
        T.text(rec, 'sm', String(b.label), bx + bw / 2, by + 42, WHITE, 0.5, 1);
        this.target(bx, by - 8, bw, bh + 16, id, () => { this.popup = null; if (b.run) b.run(); });
    });
};
Hud.prototype.toast = function (text, sec) { this.toastText = text; this.toastUntil = text ? this.t + (sec || 3) : 0; };
Hud.prototype._toast = function (rec, W, H) {
    if (!this.toastText || this.t > this.toastUntil) return;
    const w = T.width('sm', this.toastText, 2) + 80, x = W / 2 - w / 2, y = H / 2 - 30;
    slant(rec, x, y, w, 60, 14, TM.tn(0.05, 0.08, 0.16, 0.96), TM.tn(0.03, 0.05, 0.11, 0.96));
    slantLine(rec, x, y, w, 60, 14, hex('#ffb020'), 1.4);
    T.text(rec, 'sm', this.toastText, W / 2, y + 39, WHITE, 0.5, 2);
};

/* your name: an on-screen keyboard with big keys */
const KEYS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL-', 'ZXCVBNM._'];
Hud.prototype._name = function (rec, M, W, H) {
    const A = this.actions;
    this.panel(rec, W, H, 1600, 690, null);
    const cx = W / 2;
    stripe(rec, cx - 48, 40, 96, 12, 4);
    T.text(rec, 'mid', M.player && M.player.registered ? 'CHANGE YOUR NAME' : 'YOUR DRIVER NAME', cx, 104, WHITE, 0.5, 5);
    T.text(rec, 'labs', 'SHOWN ON THE LEADERBOARD  /  UNIQUE: NOBODY ELSE CAN HAVE IT  /  3 TO 16 CHARACTERS', cx, 134, FAINT, 0.5, 2);
    // the name so far, with a caret
    const d = this.nameDraft || '';
    slant(rec, cx - 380, 156, 760, 74, 14, TM.tn(0.08, 0.13, 0.25, 0.95), TM.tn(0.05, 0.08, 0.16, 0.95));
    const tw = T.text(rec, 'mid', d, cx, 208, WHITE, 0.5, 3);
    if (Math.sin(this.t * 7) > 0) rec.rect(cx + tw / 2 + 6, 176, 4, 40, LBLUE);
    if (this.nameError) T.text(rec, 'labs', this.nameError, cx, 252, RED, 0.5, 2);
    // keys
    const kw = 96, kh = 76, gap = 10;
    KEYS.forEach((row, ri) => {
        const n = row.length, x0 = cx - (n * kw + (n - 1) * gap) / 2 + (ri === 3 ? -60 : 0), y = 270 + ri * (kh + gap);
        for (let i = 0; i < n; i++) {
            const k = row[i], x = x0 + i * (kw + gap), id = 'k' + k, down = this.pressed === id && this.t - this.pressT < 0.18;
            slant(rec, x, y, kw, kh, 10, down ? BLUE : TM.tn(0.11, 0.17, 0.32, 0.95), down ? BLUE : TM.tn(0.07, 0.11, 0.22, 0.95));
            T.text(rec, 'mid', k, x + kw / 2, y + 52, WHITE, 0.5);
            this.target(x, y, kw, kh, id, () => A.nameKey(k));
        }
        if (ri === 3) {
            const xs = x0 + n * (kw + gap);
            const special = [['SPACE', 180, 'SPACE'], ['DEL', 130, 'DEL']];
            let x = xs;
            for (const [label, w, k] of special) {
                const id = 'k' + k, down = this.pressed === id && this.t - this.pressT < 0.18;
                slant(rec, x, y, w, kh, 10, down ? BLUE : TM.tn(0.14, 0.20, 0.36, 0.95), down ? BLUE : TM.tn(0.09, 0.13, 0.25, 0.95));
                T.text(rec, 'sm', label, x + w / 2, y + 48, WHITE, 0.5, 2);
                this.target(x, y, w, kh, id, () => A.nameKey(k));
                x += w + gap;
            }
        }
    });
    const okx = cx + 250, oky = 270 + 4 * (kh + gap) + 6, okw = 260;
    slant(rec, okx, oky, okw, 70, 14, hex('#1c9d5c'), hex('#126b3e'));
    T.text(rec, 'sm', 'SAVE', okx + okw / 2, oky + 45, WHITE, 0.5, 3);
    this.target(okx - 8, oky - 8, okw + 16, 86, 'kOK', () => A.nameKey('OK'));
    {
        const bx = cx - 510;
        slant(rec, bx, oky, 220, 70, 14, TM.tn(0.14, 0.20, 0.36, 0.95), TM.tn(0.09, 0.13, 0.25, 0.95));
        T.text(rec, 'sm', 'CANCEL', bx + 110, oky + 45, WHITE, 0.5, 2);
        this.target(bx - 8, oky - 8, 236, 86, 'kCANCEL', () => A.nameKey('CANCEL'));
    }
};

module.exports = { Hud, fmt, slant };
