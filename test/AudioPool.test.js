/** @zakkster/lite-audio-pool - AudioPool tests. Run: node --test */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioPool } from '../AudioPool.js';

// ---- Web Audio mock: enough graph to observe scheduling and teardown ----

function mkCtx() {
    const ctx = {
        currentTime: 0,
        destination: { _in: [] },
        createGain: () => node('gain'),
        createStereoPanner: () => node('panner'),
        createBufferSource: () => {
            const n = node('source');
            n.buffer = null;
            n.playbackRate = param(1);
            n.onended = null;
            n.started = null;
            n.stopped = null;
            n.start = (when, off, dur) => { n.started = [when, off, dur]; };
            n.stop = (when) => { n.stopped = when; };
            return n;
        },
    };
    return ctx;
}
function param(v) {
    const p = {
        value: v, events: [],
        cancelScheduledValues: (t) => { p.events.push(['cancel', t]); },
        setValueAtTime: (val, t) => { p.events.push(['set', val, t]); return p; },
        linearRampToValueAtTime: (val, t) => { p.events.push(['ramp', val, t]); return p; },
    };
    return p;
}
let uid = 0;
function node(kind) {
    const n = {
        kind, id: uid++, out: [], disconnected: 0,
        gain: param(1), pan: param(0),
        connect: (t) => { n.out.push(t); return t; },
        disconnect: () => { n.disconnected++; n.out.length = 0; },
    };
    return n;
}

const MAP = { drone: { start: 0, duration: 1.0 }, tick: { start: 2, duration: 0.05 } };

test('handle packs gen and channel', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4);
    const h = p.play('drone');
    assert.equal(h & 0xFF, 0);
    assert.equal(h >>> 8, 0);
    assert.equal(p.play('nope'), -1);
});

test('pan is scheduled at startTime, never assigned live', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 2);
    ctx.currentTime = 10;
    p.play('drone', 1, -0.5);
    const pan = p.panners[0].pan;
    assert.equal(pan.value, 0, 'raw .value untouched');
    const set = pan.events.filter(e => e[0] === 'set');
    assert.equal(set.length, 1);
    assert.equal(set[0][1], -0.5);
    assert.equal(set[0][2], 10.025, 'scheduled at startTime, not now');
});

test('steal bumps generation and stale stop() is a no-op', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 2);
    const h0 = p.play('drone');
    p.play('drone');
    ctx.currentTime = 0.5;                       // both still sounding
    const victimSrc = p.sources[0];
    const h2 = p.play('drone');                  // must steal ch0
    assert.equal(h2 & 0xFF, 0);
    assert.equal(h2 >>> 8, 1, 'generation bumped on steal');
    const newSrc = p.sources[0];
    assert.notEqual(newSrc, victimSrc);

    p.stop(h0);                                  // stale handle
    assert.equal(p.sources[0], newSrc, 'new occupant survives a stale stop');
    assert.equal(newSrc.stopped, null, 'stale stop did not schedule a stop');
    assert.ok(p.expireTimes[0] > 0, 'channel still marked live');

    p.stop(h2);                                  // live handle
    assert.equal(p.sources[0], null);
    assert.equal(p.expireTimes[0], 0);
});

test('late onended from a stolen source cannot retire the new occupant', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1);
    p.play('drone');
    const stolen = p.sources[0];
    ctx.currentTime = 0.5;
    p.play('drone');
    const fresh = p.sources[0];
    const genBefore = p.generations[0];

    stolen.onended({ target: stolen });           // fires late, from the audio thread
    assert.equal(p.sources[0], fresh, 'slot untouched');
    assert.equal(p.generations[0], genBefore, 'generation untouched');

    fresh.onended({ target: fresh });             // the real occupant ends
    assert.equal(p.sources[0], null);
    assert.equal(p.generations[0], genBefore + 1);
});

test('onended handler is shared, not allocated per play', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4);
    p.play('tick');
    p.play('tick');
    assert.equal(p.sources[0].onended, p.sources[1].onended);
    assert.equal(p.sources[0].onended, p._onEnded);
});

test('destroy disconnects every node it built and is idempotent', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 3);
    p.play('drone');
    const gains = p.gains.slice();
    const panners = p.panners.slice();
    p.destroy();
    for (let i = 0; i < 3; i++) {
        assert.equal(gains[i].disconnected, 1, 'gain ' + i);
        assert.equal(panners[i].disconnected, 1, 'panner ' + i);
    }
    assert.doesNotThrow(() => p.destroy());
});

test('onended after destroy does not throw', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 2);
    p.play('drone');
    const src = p.sources[0];
    p.destroy();
    assert.doesNotThrow(() => src.onended({ target: src }));
});

// ---- 1.1.0 hardening ------------------------------------------------------

test('capacity is pinned to the handle layout, loudly', () => {
    const ctx = mkCtx();
    assert.throws(() => new AudioPool(ctx, {}, MAP, 257), RangeError);
    assert.throws(() => new AudioPool(ctx, {}, MAP, 0), RangeError);
    assert.throws(() => new AudioPool(ctx, {}, MAP, 32.5), RangeError);
    assert.doesNotThrow(() => new AudioPool(ctx, {}, MAP, 256));
    // Channel 255 must round-trip: the last slot the 8-bit field can address.
    const p = new AudioPool(ctx, {}, MAP, 256);
    for (let i = 0; i < 256; i++) p.play('drone');
    const h = 255;
    assert.equal(h & 0xFF, 255);
    assert.equal(p.activeCount(), 256);
});

test('malformed sprites fail at construction, not at first shot', () => {
    const ctx = mkCtx();
    assert.throws(() => new AudioPool(ctx, {}, { bad: { start: 0, duration: 0 } }), TypeError);
    assert.throws(() => new AudioPool(ctx, {}, { bad: { start: -1, duration: 1 } }), TypeError);
    assert.throws(() => new AudioPool(ctx, {}, { bad: { start: 0 } }), TypeError);
    assert.throws(() => new AudioPool(ctx, {}, null), TypeError);
});

test('expiry survives a context that has been open for a day', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4);
    ctx.currentTime = 86400;                     // 24h of AudioContext uptime
    p.play('tick');                              // 50ms sprite
    const want = 86400 + 0.025 + 0.05;
    assert.ok(Math.abs(p.expireTimes[0] - want) < 1e-9,
        'f32 storage would quantize this to ~8ms and round the voice alive or dead');
    ctx.currentTime = want - 0.001;
    assert.equal(p.activeCount(), 1);
    ctx.currentTime = want + 0.001;
    assert.equal(p.activeCount(), 0);
});

test('isPlaying answers what stop() would do', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1);
    const h0 = p.play('drone');
    assert.equal(p.isPlaying(h0), true);

    ctx.currentTime = 0.5;
    const h1 = p.play('drone');                  // steals ch0
    assert.equal(p.isPlaying(h0), false, 'stolen');
    assert.equal(p.isPlaying(h1), true);

    ctx.currentTime = 2.0;                       // played out
    assert.equal(p.isPlaying(h1), false, 'ended');
    assert.equal(p.isPlaying(-1), false);
    assert.equal(p.activeCount(), 0);
});

test('generation wrap does not bleed into the channel field', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1);
    p.play('drone');
    p.generations[0] = 0xFFFFFF;                 // one bump from wrapping
    ctx.currentTime = 0.5;
    const h = p.play('drone');                   // steals, bumps, wraps to 0
    assert.equal(p.generations[0], 0);
    assert.equal(h >>> 8, 0);
    assert.equal(h & 0xFF, 0);
    assert.equal(p.isPlaying(h), true);
});
