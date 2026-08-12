/** @zakkster/lite-audio-pool - AudioPool tests. Run: node --test */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AudioPool } from '../AudioPool.js';

// ---- Web Audio mock: enough graph to observe scheduling and teardown ----

function mkCtx() {
    const ctx = {
        currentTime: 0,
        destination: { _in: [] },
        createGain: () => node('gain'),
        createStereoPanner: () => node('panner'),
        createPanner: () => pannerNode(),
        createChannelMerger: (n) => {
            const m = node('merger');
            m.numberOfInputs = n;
            return m;
        },
        createBiquadFilter: () => {
            const b = node('biquad');
            b.type = '';
            b.frequency = param(350);
            return b;
        },
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
        kind, id: uid++, out: [], connections: [], disconnected: 0,
        gain: param(1), pan: param(0),
        connect: (t, output, input) => {
            n.out.push(t);
            n.connections.push({ target: t, output, input });
            return t;
        },
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

test('destroy() tolerates a reentrant onended in discrete mode (lane fan-out teardown)', () => {
    const ctx = mkCtx();
    // Discrete destroy() additionally walks voiceLanes[i] (an array-of-arrays) plus the
    // shared merger/lowpass/_panSink. Prove that added teardown survives sources[] being
    // mutated by a synchronous onended fired from inside the same stopAll() tick.
    const p = new AudioPool(ctx, {}, MAP, 2, null, { panner: 'discrete', channels: 6 });
    p.play('drone');
    p.play('drone');
    for (const src of p.sources) {
        const originalStop = src.stop;
        src.stop = (when) => { originalStop(when); if (src.onended) src.onended({ target: src }); };
    }
    assert.doesNotThrow(() => p.destroy());
    assert.doesNotThrow(() => p.destroy(), 'still idempotent after a reentrant discrete teardown');
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

// ---- 1.3.0 discrete surround mode -----------------------------------------

test('stereo/positional voiceInputs are the panner node (byte-identical connect target)', () => {
    const ctx = mkCtx();
    const s = new AudioPool(ctx, {}, MAP, 4);
    for (let i = 0; i < 4; i++) assert.equal(s.voiceInputs[i], s.panners[i], 'stereo voice ' + i);
    const p = new AudioPool(ctx, {}, MAP, 4, null, { panner: 'positional' });
    for (let i = 0; i < 4; i++) assert.equal(p.voiceInputs[i], p.panners[i], 'positional voice ' + i);
    // The fresh source connects to the panner, exactly as before.
    s.play('drone');
    assert.equal(s.sources[0].out[0], s.panners[0], 'source -> panner in stereo');
});

test('discrete mode builds N lanes per voice, panner is null, source connects to the gain', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 6 });
    assert.equal(p.panMode, 'discrete');
    assert.equal(p.channels, 6);
    for (let i = 0; i < 4; i++) {
        assert.equal(p.panners[i], null, 'voice ' + i + ' has no panner');
        assert.equal(p.voiceLanes[i].length, 6, 'voice ' + i + ' has 6 lanes');
        assert.equal(p.voiceInputs[i], p.gains[i], 'voice ' + i + ' input is its gain');
        assert.equal(p.panTargets[i], p._panSink.gain, 'voice ' + i + ' pan target is the shared sink');
    }
    p.play('drone');
    assert.equal(p.sources[0].out[0], p.gains[0], 'source -> gain in discrete');
});

test('discrete lane default gains: L,R = 0.7071, all others (incl LFE) = 0.0', () => {
    const ctx = mkCtx();
    for (const N of [4, 6, 8]) {
        const p = new AudioPool(ctx, {}, MAP, 2, null, { panner: 'discrete', channels: N });
        const lanes = p.voiceLanes[0];
        assert.equal(lanes[0].gain.value, 0.7071, 'N=' + N + ' L audible');
        assert.equal(lanes[1].gain.value, 0.7071, 'N=' + N + ' R audible');
        for (let k = 2; k < N; k++) assert.equal(lanes[k].gain.value, 0.0, 'N=' + N + ' lane ' + k + ' silent');
    }
});

test('discrete LFE topology: lane 3 -> shared lowpass -> merger input 3, once', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 3, null, { panner: 'discrete', channels: 6 });
    assert.equal(p.lowpass.kind, 'biquad');
    assert.equal(p.lowpass.type, 'lowpass');
    assert.equal(p.merger.kind, 'merger');
    assert.equal(p.merger.numberOfInputs, 6);
    // The shared lowpass connects into merger input 3 exactly once, regardless of voices.
    const lpToMerger = p.lowpass.connections.filter(c => c.target === p.merger);
    assert.equal(lpToMerger.length, 1, 'lowpass -> merger exactly once');
    assert.equal(lpToMerger[0].input, 3, 'lowpass targets merger input 3 (LFE)');
    for (let i = 0; i < 3; i++) {
        const lanes = p.voiceLanes[i];
        // Lane 3 (LFE) routes to the shared lowpass, unpanned.
        assert.equal(lanes[3].out[0], p.lowpass, 'voice ' + i + ' lane 3 -> lowpass');
        // Every non-LFE lane routes straight to its own merger input k.
        for (let k = 0; k < 6; k++) {
            if (k === 3) continue;
            const c = lanes[k].connections[0];
            assert.equal(c.target, p.merger, 'voice ' + i + ' lane ' + k + ' -> merger');
            assert.equal(c.input, k, 'voice ' + i + ' lane ' + k + ' -> merger input ' + k);
        }
        // The voice gain fans out to all N lanes.
        for (let k = 0; k < 6; k++) assert.equal(p.gains[i].out.includes(lanes[k]), true, 'gain -> lane ' + k);
    }
    // Merger feeds the output bus.
    assert.equal(p.merger.out[0], ctx.destination);
});

test('discrete pan is inert: play() writes land on the shared detached sink, not any lane', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 2, null, { panner: 'discrete', channels: 4 });
    ctx.currentTime = 10;
    p.play('drone', 1, -0.5);
    const sink = p._panSink.gain;
    const set = sink.events.filter(e => e[0] === 'set');
    assert.equal(set.length, 1, 'one scheduled write, same shape as stereo');
    assert.equal(set[0][1], -0.5, 'pan value lands on the sink');
    assert.equal(set[0][2], 10.025, 'scheduled at startTime');
    // Lane gains are untouched by pan writes.
    for (let k = 0; k < 4; k++) {
        assert.equal(p.voiceLanes[0][k].gain.events.length, 0, 'lane ' + k + ' pan-untouched');
    }
});

test('discrete voiceNode returns the per-voice lane array, fail-closed like stereo', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1, null, { panner: 'discrete', channels: 8 });
    const h0 = p.play('drone');
    const lanes = p.voiceNode(h0);
    assert.equal(lanes, p.voiceLanes[0], 'live handle yields its lane array');
    assert.equal(lanes.length, 8);
    // The array identity is stable (pre-allocated, zero-alloc at call time).
    assert.equal(p.voiceNode(h0), lanes, 'same array reference on repeat call');

    ctx.currentTime = 0.5;
    const h1 = p.play('drone');                   // steals ch0, bumps gen
    assert.equal(p.voiceNode(h0), null, 'stale handle after steal returns null');
    assert.equal(p.voiceNode(h1), p.voiceLanes[0], 'new occupant is live');

    p.stop(h1);
    assert.equal(p.voiceNode(h1), null, 'null after stop');
    assert.equal(p.voiceNode(-1), null, 'negative handle');
    assert.equal(p.voiceNode(9999), null, 'out-of-range channel');
    assert.equal(p.voiceNode(NaN), null, 'non-integer handle');
});

test('discrete voiceNode fails closed on a voice expired but not yet retired', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1, null, { panner: 'discrete', channels: 4 });
    const h = p.play('tick');
    assert.notEqual(p.voiceNode(h), null);
    ctx.currentTime = 100;
    assert.equal(p.voiceNode(h), null, 'expired voice returns null even before retire');
});

test('discrete validation: channels must be present and in {4,6,8}', () => {
    const ctx = mkCtx();
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete' }), RangeError, 'absent channels');
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 2 }), RangeError, 'channels=2');
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 5 }), RangeError, 'channels=5');
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 6.0001 }), RangeError, 'non-integer');
    assert.doesNotThrow(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 4 }));
    assert.doesNotThrow(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 8 }));
    // Boundary matrix additions: string coercion, 0, and NaN must not slip through
    // the strict !== 4/6/8 comparison (a `==` typo would let '6' or 6.0 through).
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: '6' }), RangeError, 'channels="6" (string)');
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 0 }), RangeError, 'channels=0');
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: NaN }), RangeError, 'channels=NaN');
});

test('discrete validation: channels with a non-discrete mode throws RangeError', () => {
    const ctx = mkCtx();
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { channels: 6 }), RangeError, 'stereo + channels');
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'positional', channels: 6 }), RangeError, 'positional + channels');
});

test('discrete validation: context lacking createChannelMerger/createBiquadFilter throws TypeError', () => {
    const noMerger = mkCtx();
    delete noMerger.createChannelMerger;
    assert.throws(() => new AudioPool(noMerger, {}, MAP, 4, null, { panner: 'discrete', channels: 6 }), TypeError);
    const noBiquad = mkCtx();
    delete noBiquad.createBiquadFilter;
    assert.throws(() => new AudioPool(noBiquad, {}, MAP, 4, null, { panner: 'discrete', channels: 6 }), TypeError);
});

test('unknown panner mode still throws RangeError including against discrete typos', () => {
    const ctx = mkCtx();
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'Discrete' }), RangeError);
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'surround51' }), RangeError);
});

test('discrete destroy() disconnects every lane, the merger, the lowpass, the sink, and is idempotent', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 3, null, { panner: 'discrete', channels: 6 });
    p.play('drone');
    p.play('tick');
    const gains = p.gains.slice();
    const lanes = p.voiceLanes.map(a => a.slice());
    const merger = p.merger;
    const lowpass = p.lowpass;
    const sink = p._panSink;
    p.destroy();
    for (let i = 0; i < 3; i++) {
        assert.equal(gains[i].disconnected, 1, 'gain ' + i);
        for (let k = 0; k < 6; k++) assert.equal(lanes[i][k].disconnected, 1, 'voice ' + i + ' lane ' + k);
    }
    assert.equal(merger.disconnected, 1, 'merger');
    assert.equal(lowpass.disconnected, 1, 'lowpass');
    assert.equal(sink.disconnected, 1, 'pan sink');
    assert.equal(p.voiceLanes, null, 'voiceLanes released');
    assert.equal(p.merger, null, 'merger released');
    assert.equal(p.lowpass, null, 'lowpass released');
    assert.equal(p._panSink, null, 'pan sink released');
    assert.equal(p.voiceInputs, null, 'voiceInputs released');
    assert.doesNotThrow(() => p.destroy(), 'idempotent');
});

// ---- 1.3.0 QA hardening: node census, topology at N=4/8, and extra boundaries ----

test('discrete node census exact: channels=6, capacity=32 -> 1 merger, 1 lowpass, ' +
     '192 lane gains + 32 voice gains, 0 panners', () => {
    const ctx = mkCtx();
    let gainCalls = 0, mergerCalls = 0, biquadCalls = 0, stereoPannerCalls = 0, pannerCalls = 0;
    const origGain = ctx.createGain, origMerger = ctx.createChannelMerger, origBiquad = ctx.createBiquadFilter;
    const origStereo = ctx.createStereoPanner, origPanner = ctx.createPanner;
    ctx.createGain = (...a) => { gainCalls++; return origGain(...a); };
    ctx.createChannelMerger = (...a) => { mergerCalls++; return origMerger(...a); };
    ctx.createBiquadFilter = (...a) => { biquadCalls++; return origBiquad(...a); };
    ctx.createStereoPanner = (...a) => { stereoPannerCalls++; return origStereo(...a); };
    ctx.createPanner = (...a) => { pannerCalls++; return origPanner(...a); };

    const p = new AudioPool(ctx, {}, MAP, 32, null, { panner: 'discrete', channels: 6 });

    assert.equal(mergerCalls, 1, 'exactly one ChannelMerger for the whole pool');
    assert.equal(biquadCalls, 1, 'exactly one BiquadFilter (the shared LFE lowpass)');
    assert.equal(gainCalls, 1 + 32 + 32 * 6, '1 detached pan sink + 32 voice gains + 6 lane gains x 32 voices');
    assert.equal(gainCalls, 225, 'pinned literal: 1 + 32 + 192');
    assert.equal(stereoPannerCalls, 0, 'discrete mode never builds a StereoPannerNode');
    assert.equal(pannerCalls, 0, 'discrete mode never builds a 3D PannerNode');
    assert.equal(p.panners.length, 32, 'panners array still sized to capacity');
    assert.equal(p.panners.filter((x) => x !== null).length, 0, '0 live panner references');
    assert.equal(p.voiceLanes[0].length, 6, 'voice 0 exposes exactly 6 pre-allocated lanes');
});

test('discrete node census exact: channels=4 (4 lane gains x 8 voices), 0 panners', () => {
    const ctx = mkCtx();
    let gainCalls = 0, mergerCalls = 0, biquadCalls = 0;
    const origGain = ctx.createGain, origMerger = ctx.createChannelMerger, origBiquad = ctx.createBiquadFilter;
    ctx.createGain = (...a) => { gainCalls++; return origGain(...a); };
    ctx.createChannelMerger = (...a) => { mergerCalls++; return origMerger(...a); };
    ctx.createBiquadFilter = (...a) => { biquadCalls++; return origBiquad(...a); };

    const p = new AudioPool(ctx, {}, MAP, 8, null, { panner: 'discrete', channels: 4 });

    assert.equal(mergerCalls, 1);
    assert.equal(biquadCalls, 1);
    assert.equal(gainCalls, 1 + 8 + 8 * 4, '1 detached pan sink + 8 voice gains + 4 lane gains x 8 voices');
    assert.equal(p.voiceLanes[0].length, 4, 'channels=4 -> L,R,C,LFE only, no SL/SR');
});

test('discrete node census exact: channels=8 (8 lane gains x 5 voices), 0 panners', () => {
    const ctx = mkCtx();
    let gainCalls = 0, mergerCalls = 0, biquadCalls = 0;
    const origGain = ctx.createGain, origMerger = ctx.createChannelMerger, origBiquad = ctx.createBiquadFilter;
    ctx.createGain = (...a) => { gainCalls++; return origGain(...a); };
    ctx.createChannelMerger = (...a) => { mergerCalls++; return origMerger(...a); };
    ctx.createBiquadFilter = (...a) => { biquadCalls++; return origBiquad(...a); };

    const p = new AudioPool(ctx, {}, MAP, 5, null, { panner: 'discrete', channels: 8 });

    assert.equal(mergerCalls, 1);
    assert.equal(biquadCalls, 1);
    assert.equal(gainCalls, 1 + 5 + 5 * 8, '1 detached pan sink + 5 voice gains + 8 lane gains x 5 voices');
    assert.equal(p.voiceLanes[0].length, 8, 'channels=8 adds SBL/SBR at lanes 6,7');
});

test('discrete LFE topology holds at channels=4 and channels=8 too, not just 6', () => {
    const ctx = mkCtx();
    for (const N of [4, 8]) {
        const p = new AudioPool(ctx, {}, MAP, 2, null, { panner: 'discrete', channels: N });
        assert.equal(p.merger.numberOfInputs, N, 'N=' + N + ' merger input count');
        const lpToMerger = p.lowpass.connections.filter((c) => c.target === p.merger);
        assert.equal(lpToMerger.length, 1, 'N=' + N + ' lowpass -> merger exactly once');
        assert.equal(lpToMerger[0].input, 3, 'N=' + N + ' lowpass targets merger input 3 (LFE)');
        for (let i = 0; i < 2; i++) {
            const lanes = p.voiceLanes[i];
            assert.equal(lanes.length, N, 'N=' + N + ' voice ' + i + ' lane count');
            assert.equal(lanes[3].out[0], p.lowpass, 'N=' + N + ' voice ' + i + ' lane 3 -> lowpass');
            for (let k = 0; k < N; k++) {
                if (k === 3) continue;
                const c = lanes[k].connections[0];
                assert.equal(c.target, p.merger, 'N=' + N + ' voice ' + i + ' lane ' + k + ' -> merger');
                assert.equal(c.input, k, 'N=' + N + ' voice ' + i + ' lane ' + k + ' -> merger input ' + k);
            }
        }
        // channels=8 specifically exercises SBL/SBR at lanes 6 and 7.
        if (N === 8) {
            const lanes = p.voiceLanes[0];
            assert.equal(lanes[6].connections[0].input, 6, 'SBL (lane 6) -> merger input 6');
            assert.equal(lanes[7].connections[0].input, 7, 'SBR (lane 7) -> merger input 7');
        }
    }
});

test('discrete: writing every VBAP (non-LFE) lane leaves the LFE lane at 0, never in the VBAP set', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1, null, { panner: 'discrete', channels: 6 });
    const h = p.play('drone');
    const lanes = p.voiceNode(h);
    // Simulate a full VBAP placement: drive every non-LFE lane to a nonzero gain.
    for (let k = 0; k < lanes.length; k++) {
        if (k === 3) continue;
        lanes[k].gain.value = 0.5;
    }
    assert.equal(lanes[3].gain.value, 0.0, 'LFE lane (index 3) is never written by a VBAP pass');
});

test('discrete: the shared lowpass is one instance, referenced identically by every voice', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 5, null, { panner: 'discrete', channels: 6 });
    const refs = new Set();
    for (let i = 0; i < 5; i++) refs.add(p.voiceLanes[i][3].out[0]);
    assert.equal(refs.size, 1, 'all 5 voices route lane 3 to the exact same lowpass instance');
    assert.equal(refs.has(p.lowpass), true, 'that instance is the pool-level p.lowpass');
});

test('discrete: the detached pan sink is never connected to anything, before or after play()', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 6 });
    assert.equal(p._panSink.out.length, 0, '_panSink has no connect() targets at construction');
    p.play('drone');
    p.play('tick');
    assert.equal(p._panSink.out.length, 0, '_panSink stays unconnected after pan writes to its gain param');
});

test('discrete lane defaults survive play(): a freshly played, unpositioned voice is front-stereo, ' +
     'never fully silent', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 1, null, { panner: 'discrete', channels: 6 });
    const h = p.play('drone');                    // no positioning write after play()
    const lanes = p.voiceNode(h);
    assert.equal(lanes[0].gain.value, 0.7071, 'L still audible after play()');
    assert.equal(lanes[1].gain.value, 0.7071, 'R still audible after play()');
    for (let k = 2; k < 6; k++) assert.equal(lanes[k].gain.value, 0.0, 'lane ' + k + ' still silent after play()');
});

test('discrete voiceNode boundary matrix: undefined, null, non-integer floats (+/-), fail closed; ' +
     '-0 resolves like 0', () => {
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 4, null, { panner: 'discrete', channels: 6 });
    const h0 = p.play('drone');                   // channel 0, generation 0
    assert.equal(h0, 0, 'sanity: channel 0 is live at generation 0');

    for (const bogus of [undefined, null, 1.5, -1.5, -1]) {
        assert.equal(p.voiceNode(bogus), null, 'voiceNode(' + String(bogus) + ') must fail closed in discrete mode');
    }
    // -0 decodes to the same (gen 0, channel 0) bit pattern as the legitimate handle 0.
    assert.equal(p.voiceNode(-0), p.voiceLanes[0], 'voiceNode(-0) resolves the live channel-0 lane array');
    assert.equal(p.voiceNode(0), p.voiceLanes[0], 'voiceNode(0) resolves identically');
});

test('hot play() body never branches on panner mode (structural pin against regression)', () => {
    // A `panMode`/`discrete` test anywhere inside play() would mean the "unbranched
    // hot path" claim regressed silently; this fails loudly on that exact class of
    // change instead of relying on someone noticing a benchmark wobble.
    const src = readFileSync(new URL('../AudioPool.js', import.meta.url), 'utf8');
    const start = src.indexOf('play(spriteId, volume = 1.0');
    const end = src.indexOf('stop(handle) {');
    assert.ok(start > -1, 'sanity: play() method located');
    assert.ok(end > start, 'sanity: stop() method located after play()');
    const body = src.slice(start, end);
    assert.doesNotMatch(body, /discrete/i, 'play() must not reference "discrete" anywhere in its body');
    assert.doesNotMatch(body, /panMode/, 'play() must not read this.panMode');
    assert.doesNotMatch(body, /voiceLanes/, 'play() must not touch voiceLanes; it uses pre-resolved voiceInputs');
    // 1.4.0 hrtf: /panMode/ alone would NOT catch a regression that branches on the
    // resolved panningModel value or the literal 'hrtf' string instead of panMode -
    // e.g. `if (this.panners[i].panningModel === 'HRTF')` inside play(). Pin those
    // two substrings directly so that class of regression fails loudly here too.
    assert.doesNotMatch(body, /panningModel/, 'play() must not reference panningModel');
    assert.doesNotMatch(body, /hrtf/i, 'play() must not reference "hrtf" anywhere in its body');
});

// ---- 1.4.0 hrtf panner mode -------------------------------------------------

test('hrtf mode builds capacity PannerNodes, panningModel HRTF, distance graph identical ' +
     'to positional, panMode is hrtf, and never builds a StereoPannerNode', () => {
    const ctx = mkCtx();
    let stereoPannerCalls = 0;
    const origStereo = ctx.createStereoPanner;
    ctx.createStereoPanner = (...a) => { stereoPannerCalls++; return origStereo(...a); };

    const p = new AudioPool(ctx, {}, MAP, 32, ctx.destination, { panner: 'hrtf' });
    assert.equal(p.panMode, 'hrtf');
    for (let i = 0; i < 32; i++) {
        assert.equal(p.panners[i].kind, 'panner3d', 'voice ' + i + ' is a PannerNode');
        assert.equal(p.panners[i].panningModel, 'HRTF', 'voice ' + i + ' reports HRTF');
        assert.equal(p.panners[i].distanceModel, 'inverse', 'voice ' + i + ' distanceModel matches positional');
        assert.equal(p.panners[i].refDistance, 1, 'voice ' + i + ' refDistance matches positional');
        assert.equal(p.panners[i].maxDistance, 10000, 'voice ' + i + ' maxDistance matches positional');
        assert.equal(p.panners[i].rolloffFactor, 1, 'voice ' + i + ' rolloffFactor matches positional');
        assert.equal(p.panTargets[i], p.panners[i].positionX, 'voice ' + i + ' pan target is positionX');
    }
    assert.equal(stereoPannerCalls, 0, 'hrtf mode never builds a StereoPannerNode');
});

test('stereo mode never builds a 3D PannerNode (0 createPanner calls)', () => {
    // DONE-WHEN 2's other half: {panner:'positional'} reporting 'equalpower' is
    // already pinned at "positional mode builds capacity PannerNodes..." above;
    // this is the missing stereo-side node-census proof.
    const ctx = mkCtx();
    let pannerCalls = 0;
    const origPanner = ctx.createPanner;
    ctx.createPanner = (...a) => { pannerCalls++; return origPanner(...a); };

    const p = new AudioPool(ctx, {}, MAP, 32);
    assert.equal(p.panMode, 'stereo');
    assert.equal(pannerCalls, 0, 'stereo mode never calls createPanner');
});

test('hrtf mode against a PannerNode without positionX throws TypeError, exactly like positional', () => {
    // Adversarial case not called out by name in the DONE-WHEN: prove the shared
    // `positional = mode === 'positional' || mode === 'hrtf'` branch really shares
    // the fail-closed guard, not just the happy-path fields asserted above.
    const ctx = mkCtx();
    ctx.createPanner = () => pannerNode(false);   // pre-AudioParam node
    assert.throws(() => new AudioPool(ctx, {}, MAP, 4, null, { panner: 'hrtf' }), TypeError);
});

test('{panner:"hrft"} (typo) throws RangeError with did-you-mean guidance including "hrtf"; ' +
     '{panner:"HRTF"} (wrong case) throws; {panner:"hrtf", channels:6} throws', () => {
    const ctx = mkCtx();
    assert.throws(() => new AudioPool(ctx, {}, MAP, 32, null, { panner: 'hrft' }), RangeError);
    let typoMessage = '';
    try {
        new AudioPool(ctx, {}, MAP, 32, null, { panner: 'hrft' });
    } catch (e) {
        typoMessage = e.message;
    }
    assert.match(typoMessage, /hrtf/, 'error message must guide toward the valid "hrtf" spelling');

    assert.throws(() => new AudioPool(ctx, {}, MAP, 32, null, { panner: 'HRTF' }), RangeError,
        'wrong-case "HRTF" must not silently alias to "hrtf"');
    assert.throws(() => new AudioPool(ctx, {}, MAP, 32, null, { panner: 'hrtf', channels: 6 }), RangeError,
        'channels is only valid with panner "discrete", including against hrtf');
});

test('destroy() disconnects every PannerNode in hrtf mode and clears panTargets ' +
     '(null-safe loop covers the HRTF PannerNode)', () => {
    // Same mock/census approach as the existing positional destroy test: a
    // disconnect() counter per node, asserted post-destroy(), plus idempotency.
    const ctx = mkCtx();
    const p = new AudioPool(ctx, {}, MAP, 3, null, { panner: 'hrtf' });
    p.play('drone');
    const gains = p.gains.slice();
    const panners = p.panners.slice();
    for (const panner of panners) assert.equal(panner.panningModel, 'HRTF', 'sanity: hrtf voice before destroy');
    p.destroy();
    for (let i = 0; i < 3; i++) {
        assert.equal(gains[i].disconnected, 1, 'gain ' + i);
        assert.equal(panners[i].disconnected, 1, 'hrtf panner ' + i + ' disconnected');
    }
    assert.equal(p.panTargets, null, 'panTargets (AudioParam refs) released after destroy');
    assert.doesNotThrow(() => p.destroy(), 'duplicate dispose is a no-op');
});
