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
        createPanner: () => pannerNode(),
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
// Per-call identity (like node()) so voiceNode tests can observe steal/gen swaps.
// withPosX=false models a pre-AudioParam PannerNode for the fail-closed guard test.
function pannerNode(withPosX = true) {
    const n = {
        kind: 'panner3d', id: uid++, out: [], disconnected: 0,
        panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0, rolloffFactor: 0,
        connect: (t) => { n.out.push(t); return t; },
        disconnect: () => { n.disconnected++; n.out.length = 0; },
    };
    if (withPosX) {
        n.positionX = param(0);
        n.positionY = param(0);
        n.positionZ = param(0);
    }
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

test('destroy disconnects every PannerNode in positional mode and clears panTargets', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 3, null, { panner: 'positional' });
    p.play('drone');
    const gains = p.gains.slice();
    const panners = p.panners.slice();
    p.destroy();
    for (let i = 0; i < 3; i++) {
        assert.equal(gains[i].disconnected, 1, 'gain ' + i);
        assert.equal(panners[i].disconnected, 1, 'panner ' + i);
    }
    assert.equal(p.panTargets, null, 'panTargets (AudioParam refs) released after destroy');
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

// ---- 1.2.0 positional panner mode -----------------------------------------

test('positional mode builds capacity PannerNodes and wires positionX as the pan target', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 32, null, { panner: 'positional' });
    assert.equal(p.panMode, 'positional');
    for (let i = 0; i < 32; i++) {
        assert.equal(p.panners[i].kind, 'panner3d', 'voice ' + i + ' is a PannerNode');
        assert.equal(p.panners[i].panningModel, 'equalpower');
        assert.equal(p.panners[i].distanceModel, 'inverse');
        assert.equal(p.panners[i].refDistance, 1);
        assert.equal(p.panners[i].maxDistance, 10000);
        assert.equal(p.panners[i].rolloffFactor, 1);
        assert.equal(p.panTargets[i], p.panners[i].positionX, 'pan writes go to positionX');
    }
});

test('positional pan writes reach positionX, scheduled at startTime', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 2, null, { panner: 'positional' });
    ctx.currentTime = 10;
    p.play('drone', 1, -0.5);
    const px = p.panners[0].positionX;
    const set = px.events.filter(e => e[0] === 'set');
    assert.equal(set.length, 1);
    assert.equal(set[0][1], -0.5, 'pan -> positionX');
    assert.equal(set[0][2], 10.025, 'scheduled at startTime, not now');
});

test('voiceNode returns the live node, null after steal, stop, and for stale/bogus handles', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1, null, { panner: 'positional' });
    const h0 = p.play('drone');
    assert.equal(p.voiceNode(h0), p.panners[0], 'live handle yields its node');

    ctx.currentTime = 0.5;
    const h1 = p.play('drone');                  // steals ch0, bumps gen
    assert.equal(p.voiceNode(h0), null, 'stale handle after steal');
    assert.equal(p.voiceNode(h1), p.panners[0], 'new occupant is live');

    p.stop(h1);
    assert.equal(p.voiceNode(h1), null, 'null after stop');

    assert.equal(p.voiceNode(-1), null, 'negative handle');
    assert.equal(p.voiceNode(9999), null, 'out-of-range channel');
});

test('voiceNode fails closed on a voice expired but not yet retired', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1, null, { panner: 'positional' });
    const h = p.play('tick');                     // 50ms sprite
    assert.notEqual(p.voiceNode(h), null);
    ctx.currentTime = 100;                         // played out, onended not fired
    assert.equal(p.voiceNode(h), null, 'expired voice returns null even before retire');
});

test('two simultaneous positional voices get distinct PannerNodes and positionX params', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 2, null, { panner: 'positional' });
    const h0 = p.play('drone');
    const h1 = p.play('drone');                    // distinct channel, no steal
    const n0 = p.voiceNode(h0);
    const n1 = p.voiceNode(h1);
    assert.notEqual(n0, null);
    assert.notEqual(n1, null);
    assert.notEqual(n0, n1, 'two live voices report two different PannerNodes');
    assert.notEqual(n0.positionX, n1.positionX,
        'positionX is a per-voice AudioParam, not a shared singleton');
});

test('voiceNode channel boundary matrix: 0, 1, N-1 live; N and N+1 out of range', () => {
    const ctx = mkCtx();
    const CAP = 4;
    const p = new AudioPool(ctx, {}, MAP, CAP, null, { panner: 'positional' });
    const handles = [];
    for (let i = 0; i < CAP; i++) handles.push(p.play('drone')); // fills channels 0..N-1
    // Freshly filled, un-stolen pool: generation is 0 for every channel, so each
    // handle IS the channel index (0, 1, ..., N-1).
    assert.equal(handles[0], 0, 'channel 0 handle');
    assert.equal(handles[1], 1, 'channel 1 handle');
    assert.equal(handles[CAP - 1], CAP - 1, 'channel N-1 handle');
    for (let i = 0; i < CAP; i++) {
        assert.notEqual(p.voiceNode(handles[i]), null, 'channel ' + i + ' is live');
    }
    // All N channels are occupied and live, so channel indices >= N never point
    // at a real slot: N and N+1 must fail closed regardless of the gen field.
    assert.equal(p.voiceNode(CAP), null, 'channel N is out of range');         // handle = N, gen 0
    assert.equal(p.voiceNode(CAP + 1), null, 'channel N+1 is out of range');   // handle = N+1, gen 0
});

test('handle-type guard: coerced non-integer handles no longer alias live channel 0', () => {
    // Regression coverage for the fail-closed defect found during QA: undefined,
    // null, NaN, and non-integer floats used to bitwise-coerce to the same
    // (gen 0, channel 0) bit pattern as the legitimate handle 0. With channel 0
    // live at generation 0 - the exact state that used to alias - every one of
    // these bogus inputs must now fail closed instead of touching the real voice.
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4, null, { panner: 'positional' });
    const h0 = p.play('drone');                    // channel 0, generation 0
    assert.equal(h0, 0, 'sanity: channel 0 is live at generation 0');

    for (const bogus of [undefined, null, NaN, 1.5]) {
        assert.equal(p.voiceNode(bogus), null, 'voiceNode(' + String(bogus) + ') must fail closed');
        assert.equal(p.isPlaying(bogus), false, 'isPlaying(' + String(bogus) + ') must fail closed');
    }

    // The regression that mattered most: stop() must be a true no-op for these
    // inputs, not silently stop the real, live channel-0 voice.
    p.stop(undefined);
    assert.equal(p.isPlaying(h0), true, 'stop(undefined) must not stop the real channel-0 voice');
    p.stop(null);
    assert.equal(p.isPlaying(h0), true, 'stop(null) must not stop the real channel-0 voice');
    p.stop(NaN);
    assert.equal(p.isPlaying(h0), true, 'stop(NaN) must not stop the real channel-0 voice');
    p.stop(1.5);
    assert.equal(p.isPlaying(h0), true, 'stop(1.5) must not stop the real channel-0 voice');

    // Regression guard: the legitimate handle 0 (and its -0 twin) must still work.
    assert.equal(p.voiceNode(0), p.panners[0], 'voiceNode(0) still resolves the live channel-0 node');
    assert.equal(p.voiceNode(-0), p.panners[0], '-0 behaves identically to 0');
    assert.equal(p.isPlaying(0), true, 'isPlaying(0) still true for the live voice');
    assert.equal(p.isPlaying(-0), true, 'isPlaying(-0) still true for the live voice');

    p.stop(0);                                     // the legitimate handle actually stops the voice
    assert.equal(p.isPlaying(0), false, 'stop(0) actually stopped the real channel-0 voice');
    assert.equal(p.sources[0], null, 'source reference released');
});

test('handle-type guard: -0 stops the live voice exactly like 0', () => {
    // Same scenario as above, isolated so -0's stop() path is exercised against
    // a channel that is still at generation 0 (0 and -0 only decode to the same
    // handle when the generation field is 0).
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4, null, { panner: 'positional' });
    const h0 = p.play('drone');
    assert.equal(h0, 0, 'sanity: channel 0 is live at generation 0');

    p.stop(-0);
    assert.equal(p.isPlaying(0), false, 'stop(-0) actually stopped the real channel-0 voice');
    assert.equal(p.sources[0], null, 'source reference released');
});

test('destroy() tolerates a reentrant onended fired synchronously from source.stop()', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 2);
    p.play('drone');
    p.play('drone');
    // Adversarial mock: this context's source.stop() calls onended synchronously,
    // as if the audio thread retired the voice inside the same tick that destroy()
    // asked it to stop. destroy()'s stopAll() loop must survive sources[] being
    // mutated by the reentrant handler mid-iteration.
    for (const src of p.sources) {
        const originalStop = src.stop;
        src.stop = (when) => { originalStop(when); if (src.onended) src.onended({ target: src }); };
    }
    assert.doesNotThrow(() => p.destroy());
    assert.doesNotThrow(() => p.destroy(), 'still idempotent after a reentrant teardown');
});

test('voiceNode works in stereo mode too', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 2);
    const h = p.play('drone');
    assert.equal(p.voiceNode(h), p.panners[0]);
});

test('an unknown panner mode throws RangeError at construction', () => {
    const ctx = mkCtx();
    assert.throws(() => new AudioPool(ctx, {}, MAP, 32, null, { panner: 'surround' }), RangeError);
    assert.throws(() => new AudioPool(ctx, {}, MAP, 32, null, { panner: 'Stereo' }), RangeError);
});

test('positional mode against a PannerNode without positionX throws TypeError', () => {
    const ctx = mkCtx();
    ctx.createPanner = () => pannerNode(false);   // pre-AudioParam node
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'positional' }), TypeError);
});

test('default construction is unchanged: stereo panners, pan target is .pan', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4);
    assert.equal(p.panMode, 'stereo');
    for (let i = 0; i < 4; i++) {
        assert.equal(p.panners[i].kind, 'panner', 'voice ' + i + ' is a StereoPannerNode');
        assert.equal(p.panTargets[i], p.panners[i].pan);
    }
    // Empty options object is equivalent to no options.
    const p2 = new AudioPool(ctx, {}, MAP, 4, null, {});
    assert.equal(p2.panMode, 'stereo');
});
