/**
 * @zakkster/lite-audio-pool - Node torture harness
 *
 * Measures three headline numbers against a minimal mock AudioContext:
 *   1. Throughput   - sustained plays/sec
 *   2. Allocation   - bytes retained per play under GC pressure
 *   3. Steal loop   - plays/sec when every call must steal an active voice
 *
 * Run with:  node --expose-gc bench/torture.js
 *
 * The mock context is intentionally lean so measurements reflect the pool's
 * own dispatch cost rather than any harness overhead. Numbers are hardware-
 * dependent; report them alongside your machine spec for context.
 */

import { AudioPool } from '../AudioPool.js';
import { PerformanceObserver, constants } from 'node:perf_hooks';

// Handle-layout constants mirrored from AudioPool.js (not exported: kept in
// lockstep by the tests that pin the packing). Used by the handle-lifecycle tier.
const CHANNEL_BITS = 8;
const CHANNEL_MASK = (1 << CHANNEL_BITS) - 1;            // 0xFF
const MAX_CAPACITY = 1 << CHANNEL_BITS;                  // 256
const GEN_MASK = ((1 << (32 - CHANNEL_BITS)) - 1) >>> 0; // 0xFFFFFF

const GC_MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;

// ---------- Mock AudioContext (allocation-lean) ---------------------------

const noop = () => {};
const staticGainParam = { value: 1, cancelScheduledValues: noop, setValueAtTime: noop, linearRampToValueAtTime: noop };
const staticPanParam = { value: 0, cancelScheduledValues: noop, setValueAtTime: noop };
const staticPosParam = { value: 0, cancelScheduledValues: noop, setValueAtTime: noop };
const staticRateParam = { value: 1 };

// One shared gain/panner shape reused per createGain/createStereoPanner call
// so mock construction cost stays flat. AudioPool never reads .gain across
// nodes, only .connect and per-node .gain.value/setters.
function makeMockCtx() {
    let currentTime = 0;
    return {
        get currentTime() { return currentTime; },
        _advance(dt) { currentTime += dt; },
        _reset() { currentTime = 0; },
        destination: {},
        createGain: () => ({ gain: staticGainParam, connect: noop, disconnect: noop }),
        createStereoPanner: () => ({ pan: staticPanParam, connect: noop, disconnect: noop }),
        createPanner: () => ({
            panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0, rolloffFactor: 0,
            positionX: staticPosParam, positionY: staticPosParam, positionZ: staticPosParam,
            connect: noop, disconnect: noop,
        }),
        createChannelMerger: (n) => ({ numberOfInputs: n, connect: noop, disconnect: noop }),
        createBiquadFilter: () => ({ type: '', frequency: staticRateParam, connect: noop, disconnect: noop }),
        createBufferSource: () => ({
            buffer: null, playbackRate: staticRateParam,
            connect: noop, start: noop, stop: noop, onended: null,
        }),
    };
}

// ---------- Static-source mock: zero allocation on the play() hot path -----
// makeMockCtx hands out a FRESH source object per createBufferSource() call,
// which is faithful to the Web Audio spec but means a play() loop against it
// always allocates (the mock's source), masking whether the POOL itself is
// zero-alloc. This variant shares one static source shape, so the only bytes a
// play() loop can allocate are the pool's own. That lets the capacity matrix
// gate BOTH bytes/op AND major-GC count at 0 without the mandatory per-play
// source allocation as background noise. onended is never fired in the alloc
// loop, so a shared source is safe here (the identity scan is never exercised).
const staticSource = {
    buffer: null, playbackRate: staticRateParam,
    connect: noop, start: noop, stop: noop, disconnect: noop, onended: null,
};
function makeStaticCtx() {
    let currentTime = 0;
    return {
        get currentTime() { return currentTime; },
        _advance(dt) { currentTime += dt; },
        _reset() { currentTime = 0; },
        destination: {},
        createGain: () => ({ gain: staticGainParam, connect: noop, disconnect: noop }),
        createStereoPanner: () => ({ pan: staticPanParam, connect: noop, disconnect: noop }),
        createPanner: () => ({
            panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0, rolloffFactor: 0,
            positionX: staticPosParam, positionY: staticPosParam, positionZ: staticPosParam,
            connect: noop, disconnect: noop,
        }),
        createChannelMerger: (n) => ({ numberOfInputs: n, connect: noop, disconnect: noop }),
        createBiquadFilter: () => ({ type: '', frequency: staticRateParam, connect: noop, disconnect: noop }),
        createBufferSource: () => staticSource,
    };
}

// ---------- Census mock: tracks every node until it is disconnected --------
// Unlike makeMockCtx (which shares static node shapes to hold allocation flat),
// this context hands out a fresh, tracked node per create* call and removes it
// from `census.live` only when disconnect() is called. A destroy() that forgets
// to disconnect any node it built leaves that node in the set - which is exactly
// the regression the discrete create/destroy tier and its red control assert.
function makeCensusCtx() {
    let currentTime = 0;
    const census = { live: new Set() };
    function track(shape) {
        census.live.add(shape);
        shape.disconnect = () => { census.live.delete(shape); };
        return shape;
    }
    function mkParam() {
        return { value: 0, cancelScheduledValues: noop, setValueAtTime: noop, linearRampToValueAtTime: noop };
    }
    return {
        census,
        get currentTime() { return currentTime; },
        _advance(dt) { currentTime += dt; },
        _reset() { currentTime = 0; },
        destination: {},
        createGain: () => track({ gain: mkParam(), connect: noop }),
        createStereoPanner: () => track({ pan: mkParam(), connect: noop }),
        createPanner: () => track({
            panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0, rolloffFactor: 0,
            positionX: mkParam(), positionY: mkParam(), positionZ: mkParam(), connect: noop,
        }),
        createChannelMerger: (n) => track({ numberOfInputs: n, connect: noop }),
        createBiquadFilter: () => track({ type: '', frequency: mkParam(), connect: noop }),
        createBufferSource: () => ({
            buffer: null, playbackRate: staticRateParam,
            connect: noop, start: noop, stop: noop, disconnect: noop, onended: null,
        }),
    };
}

const sprites = {
    laser: { start: 0.00, duration: 0.15 },
    hit:   { start: 0.20, duration: 0.10 },
    boom:  { start: 0.35, duration: 0.40 },
};

// ---------- Utilities ------------------------------------------------------

const fmt = (n) => n.toLocaleString('en-US');
const pad = (s, n) => String(s).padEnd(n);
const line = (label, value) => console.log(`  ${pad(label, 14)} ${value}`);

function heading(title) {
    console.log('');
    console.log('-'.repeat(60));
    console.log(title);
    console.log('-'.repeat(60));
}

// ---------- Bench 1: sustained throughput ---------------------------------

function benchThroughput() {
    const ctx = makeMockCtx();
    const pool = new AudioPool(ctx, {}, sprites, 32);

    // Warmup: 100k plays. Advance time between passes so we exercise both
    // the fresh-channel and steal paths in the warm code.
    for (let i = 0; i < 100_000; i++) {
        pool.play('laser');
        if ((i & 0x3F) === 0) ctx._advance(1); // let voices expire periodically
    }
    if (global.gc) global.gc();

    const N = 5_000_000;
    ctx._reset();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
        pool.play('laser');
        // Advance time regularly so most calls hit the fresh-channel fast path.
        if ((i & 0x1F) === 0) ctx._advance(1);
    }
    const dt = performance.now() - t0;
    const rate = (N / dt) * 1000;
    return { N, dt, rate };
}

// ---------- Bench 2: allocation per play (requires --expose-gc) -----------

function benchAllocation(mode, channels) {
    if (!global.gc) return null;

    const ctx = makeMockCtx();
    const opts = channels ? { panner: mode, channels } : { panner: mode };
    const pool = new AudioPool(ctx, {}, sprites, 32, null, opts);

    // Warm up and settle heap
    for (let i = 0; i < 200_000; i++) {
        pool.play('laser');
        if ((i & 0x1F) === 0) ctx._advance(1);
    }
    global.gc(); global.gc();

    const N = 1_000_000;
    const m0 = process.memoryUsage().heapUsed;
    ctx._reset();
    for (let i = 0; i < N; i++) {
        pool.play('laser');
        if ((i & 0x1F) === 0) ctx._advance(1);
    }
    // Post-loop GC: only *retained* allocation survives. In the pool's case
    // that's the 32 current source refs + the mock's returned source objects
    // held by them; everything else is collected.
    global.gc();
    const m1 = process.memoryUsage().heapUsed;

    const delta = m1 - m0;
    return { N, delta, perPlay: delta / N };
}

// ---------- Bench 2b: create/destroy census (positional) ------------------
// Build and destroy positional pools in a loop; retained heap must not grow.
// NOTE on what this actually proves: the mock's connect() is a no-op, so it
// never wires a real retaining edge from the (mock) output graph back to a
// voice's gain/panner node. That means a *missing* disconnect() call here
// would NOT show up as heap growth - the node would already be unreachable
// (and collectible) the moment the pool itself is dropped at the end of the
// loop body, disconnect() or not. This census is therefore proof of one
// thing only: no *other* JS-heap-retained state (stray closures, arrays,
// listeners, AudioParam refs left dangling on `this`) grows per build+destroy
// cycle. The authoritative proof that destroy() actually calls disconnect()
// on every PannerNode/GainNode it built - stereo and positional - lives in
// test/AudioPool.test.js ('destroy disconnects every ...' tests), which use
// a disconnect() counter mock precisely because a no-op-graph census cannot
// catch that class of regression.
function benchCensus() {
    if (!global.gc) return null;

    const WARM = 200;
    for (let i = 0; i < WARM; i++) {
        const ctx = makeMockCtx();
        const pool = new AudioPool(ctx, {}, sprites, 32, null, { panner: 'positional' });
        pool.play('laser');
        pool.destroy();
    }
    global.gc(); global.gc();

    const N = 2_000;
    const m0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) {
        const ctx = makeMockCtx();
        const pool = new AudioPool(ctx, {}, sprites, 32, null, { panner: 'positional' });
        pool.play('laser');
        pool.play('hit');
        pool.destroy();
    }
    global.gc(); global.gc();
    const m1 = process.memoryUsage().heapUsed;

    const delta = m1 - m0;
    return { N, delta, perCycle: delta / N };
}

// ---------- Bench 2c: discrete create/destroy census ----------------------
// Structural proof, not a heap proof: makeCensusCtx tracks every gain/merger/
// biquad until disconnect() is called, so a destroy() that skips any node it
// built shows up as census.live.size > 0. 4096 build+destroy cycles must leave
// the tracker at 0 on every cycle.
function benchDiscreteCensus() {
    const N = 4096;
    let maxLive = 0;
    for (let i = 0; i < N; i++) {
        const ctx = makeCensusCtx();
        const pool = new AudioPool(ctx, {}, sprites, 32, null, { panner: 'discrete', channels: 6 });
        pool.play('laser');
        pool.play('hit');
        pool.destroy();
        if (ctx.census.live.size > maxLive) maxLive = ctx.census.live.size;
    }
    return { N, maxLive };
}

// Red control (Law #6): defeat the merger's disconnect so destroy() cannot
// remove it from the census. If the census is a real gate, live.size MUST be
// > 0 here. A census that reports 0 under an injected leak is a dead gate.
function redControlDiscreteCensus() {
    const ctx = makeCensusCtx();
    const pool = new AudioPool(ctx, {}, sprites, 8, null, { panner: 'discrete', channels: 6 });
    pool.play('laser');
    pool.merger.disconnect = noop;   // regression injected: merger never leaves the census
    pool.destroy();
    return ctx.census.live.size;     // must be >= 1
}

// ---------- Bench 2d: HRTF create/destroy census + panningModel census -----
// An 'hrtf' pool is a positional PannerNode graph whose voices carry
// panningModel='HRTF' instead of 'equalpower'. Two proofs per cycle:
//   (1) makeCensusCtx tracks every gain/panner until disconnect(), so a
//       destroy() that skips any node it built shows up as census.live.size>0;
//   (2) every voice's PannerNode must report panningModel === 'HRTF'.
// 4096 build+destroy cycles must leave the tracker at 0 and zero mismatches.
function benchHrtfCensus() {
    const N = 4096;
    let maxLive = 0;
    let modelMismatch = 0;
    for (let i = 0; i < N; i++) {
        const ctx = makeCensusCtx();
        const pool = new AudioPool(ctx, {}, sprites, 32, null, { panner: 'hrtf' });
        pool.play('laser');
        pool.play('hit');
        for (let c = 0; c < pool.capacity; c++) {
            if (pool.panners[c].panningModel !== 'HRTF') modelMismatch++;
        }
        pool.destroy();
        if (ctx.census.live.size > maxLive) maxLive = ctx.census.live.size;
    }
    return { N, maxLive, modelMismatch };
}

// Red control (Law #6): mis-set the panningModel on a built voice so it no
// longer reports 'HRTF'. If the "all voices report HRTF" check is a real gate,
// the mismatch count MUST be > 0 here. A model census that still reports 0
// under an injected mis-set is a dead gate.
function redControlHrtfModel() {
    const ctx = makeCensusCtx();
    const pool = new AudioPool(ctx, {}, sprites, 8, null, { panner: 'hrtf' });
    pool.play('laser');
    pool.panners[0].panningModel = 'equalpower';   // regression: voice 0 no longer HRTF
    let mismatch = 0;
    for (let c = 0; c < pool.capacity; c++) {
        if (pool.panners[c].panningModel !== 'HRTF') mismatch++;
    }
    pool.destroy();
    return mismatch;                                // must be >= 1
}

// ---------- Bench 2e/2f: stereo + positional structural census ------------
// Same structural proof as the discrete/hrtf census (2c/2d): makeCensusCtx
// tracks every node it hands out until disconnect() is called, so a destroy()
// that skips any node it built leaves census.live.size > 0. 4096 build+play+
// destroy cycles per mode must leave the tracker at 0 on every cycle (maxLive 0).
function benchModeCensus(mode) {
    const N = 4096;
    let maxLive = 0;
    for (let i = 0; i < N; i++) {
        const ctx = makeCensusCtx();
        const pool = new AudioPool(ctx, {}, sprites, 32, null, { panner: mode });
        pool.play('laser');
        pool.play('hit');
        pool.destroy();
        if (ctx.census.live.size > maxLive) maxLive = ctx.census.live.size;
    }
    return { N, maxLive };
}

// Red control RC-STEREO-LIVE: defeat one built StereoPannerNode's disconnect so
// destroy() cannot remove it from the census. If the census is a real gate,
// live.size MUST be >= 1 here. Stereo mode actually builds per-voice
// StereoPannerNodes, so panners[0] is a node this mode really constructs.
function redControlStereoLive() {
    const ctx = makeCensusCtx();
    const pool = new AudioPool(ctx, {}, sprites, 8);   // stereo (default)
    pool.play('laser');
    pool.panners[0].disconnect = noop;   // regression: this StereoPannerNode never leaves the census
    pool.destroy();
    return ctx.census.live.size;         // must be >= 1
}

// Red control RC-POSITIONAL-LIVE: defeat one built PannerNode's disconnect.
// Positional mode builds a per-voice PannerNode (the distance graph), so
// panners[0] is a node this mode really constructs.
function redControlPositionalLive() {
    const ctx = makeCensusCtx();
    const pool = new AudioPool(ctx, {}, sprites, 8, null, { panner: 'positional' });
    pool.play('laser');
    pool.panners[0].disconnect = noop;   // regression: this PannerNode never leaves the census
    pool.destroy();
    return ctx.census.live.size;         // must be >= 1
}

// ---------- Bench 2g: zero-alloc x capacity matrix ------------------------
// Cross every panner mode with capacity {1, 32, 256} against makeStaticCtx (a
// context whose createBufferSource shares one static source), so the only bytes
// a play() loop can allocate are the pool's own. Each cell must report ~0 B/op
// AND zero MAJOR garbage collections: a major GC in a zero-alloc steady state
// means retained growth. Minor (scavenge) GCs are not gated - transient small
// values die in new space and never indict the pool.
async function benchAllocCell(mode, channels, capacity) {
    if (!global.gc) return null;
    const ctx = makeStaticCtx();
    const opts = channels ? { panner: mode, channels } : { panner: mode };
    const pool = new AudioPool(ctx, {}, sprites, capacity, null, opts);

    const WARM = 200_000;
    for (let i = 0; i < WARM; i++) {
        pool.play('laser');
        if ((i & 0x1F) === 0) ctx._advance(1);
    }
    global.gc(); global.gc();
    // Let the forced-GC perf entries drain before we start observing, so they
    // are not miscounted as loop-induced majors.
    await new Promise((r) => setTimeout(r, 15));

    let major = 0;
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            const kind = e.detail ? e.detail.kind : e.kind;
            if (kind === GC_MAJOR) major++;
        }
    });
    obs.observe({ entryTypes: ['gc'] });

    const N = 300_000;
    ctx._reset();
    const m0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) {
        pool.play('laser');
        if ((i & 0x1F) === 0) ctx._advance(1);
    }
    // Flush async gc entries from the measured window, then stop observing
    // BEFORE the retained-heap forced GC (that final major must not be counted).
    await new Promise((r) => setTimeout(r, 20));
    obs.disconnect();
    global.gc();
    const m1 = process.memoryUsage().heapUsed;

    pool.destroy();
    return { mode, channels, capacity, N, perPlay: (m1 - m0) / N, major };
}

// Red control RC-ALLOC-CLOSURE: inject a per-op allocation - capture each play
// into a growing array - and prove the zero-alloc gate reports clearly nonzero
// bytes/op. A gate that still reads ~0 under an injected leak is a dead gate.
function redControlAllocClosure() {
    if (!global.gc) return null;
    const ctx = makeStaticCtx();
    const pool = new AudioPool(ctx, {}, sprites, 32);
    const sink = [];   // grows one entry per op: unmistakable retained allocation
    for (let i = 0; i < 100_000; i++) {
        pool.play('laser');
        if ((i & 0x1F) === 0) ctx._advance(1);
    }
    global.gc(); global.gc();
    const N = 300_000;
    ctx._reset();
    const m0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) {
        const h = pool.play('laser');
        sink.push({ h });   // injected per-op allocation
        if ((i & 0x1F) === 0) ctx._advance(1);
    }
    global.gc();
    const m1 = process.memoryUsage().heapUsed;
    pool.destroy();
    return { perPlay: (m1 - m0) / N, retained: sink.length };   // perPlay must be >= 1
}

// ---------- Bench 2h: handle lifecycle tier -------------------------------
// Saturation, generation wraparound, stale-after-destroy, and double-destroy.
// Every invariant here is ABA-safety of the packed uint32 handle; a bleed in
// any of them hands a caller a live node it does not own.
function benchHandles() {
    // (1) Saturation at MAX_CAPACITY. All 256 slots live (no time advance), so
    // the 257th play cannot find a free channel - actual policy is to STEAL the
    // oldest, not fail. Match that: 257th returns a valid, live handle and the
    // active count stays pinned at capacity.
    const ctxS = makeMockCtx();
    const pS = new AudioPool(ctxS, {}, sprites, MAX_CAPACITY);
    for (let i = 0; i < MAX_CAPACITY; i++) pS.play('laser');
    const fullBefore = pS.activeCount();
    const h257 = pS.play('laser');
    const fullAfter = pS.activeCount();
    const satOk = fullBefore === MAX_CAPACITY && fullAfter === MAX_CAPACITY &&
        h257 !== -1 && pS.isPlaying(h257) === true;

    // (2) Generation wraparound at 2^24. Drive a channel's generation to
    // GEN_MASK, mint a handle at that generation, then steal to wrap it to 0.
    // The pre-wrap handle must fail closed, the wrapped field must not bleed
    // into the channel byte, and the fresh handle must be live.
    const ctxW = makeMockCtx();
    const pW = new AudioPool(ctxW, {}, sprites, 1);
    pW.play('laser');
    pW.generations[0] = GEN_MASK;          // one bump from wrapping
    ctxW._advance(10);                      // expire the channel: next play is a fresh mint
    const hHigh = pW.play('laser');         // handle stamped at gen GEN_MASK
    const hWrap = pW.play('laser');         // channel live -> steal -> gen wraps to 0
    const wrapOk = (hHigh >>> CHANNEL_BITS) === GEN_MASK &&
        pW.generations[0] === 0 &&
        (hWrap >>> CHANNEL_BITS) === 0 &&
        (hWrap & CHANNEL_MASK) === 0 &&
        pW.isPlaying(hHigh) === false &&    // stale across the wrap: fail closed
        pW.isPlaying(hWrap) === true;

    // (3) Stale-after-destroy. Once destroyed the pool holds no live voice; a
    // surviving handle must never resolve to a node. Throwing loudly is a valid
    // fail-closed outcome (null internals) - returning a truthy node is not.
    const ctxD = makeMockCtx();
    const pD = new AudioPool(ctxD, {}, sprites, 4);
    const hD = pD.play('laser');
    pD.destroy();
    let leaked = false;
    try { if (pD.voiceNode(hD)) leaked = true; } catch (e) { /* fail closed loudly */ }
    try { if (pD.isPlaying(hD)) leaked = true; } catch (e) { /* fail closed loudly */ }
    const staleOk = leaked === false;

    // (4) Double-destroy idempotency.
    let doubleOk = true;
    try { pD.destroy(); } catch (e) { doubleOk = false; }

    return { satOk, wrapOk, staleOk, doubleOk };
}

// Red control RC-GEN-BLEED: force a stale handle's generation to be re-accepted
// (an ABA bleed) and prove isPlaying() then reports it live - which is exactly
// what the tier's "stale handle fails closed" checks catch. If the injected
// bleed does NOT make isPlaying() return true, the tier is asserting nothing.
function redControlGenBleed() {
    const ctx = makeMockCtx();
    const p = new AudioPool(ctx, {}, sprites, 1);
    const h = p.play('laser');       // gen 0, live
    ctx._advance(0.001);              // still live
    p.play('laser');                 // steal -> gen bumps to 1; h is now stale
    p.generations[0] = (h >>> CHANNEL_BITS) & GEN_MASK;   // regression: stale gen re-accepted
    return p.isPlaying(h);           // must be true: the bleed is now observable
}

// ---------- Bench 2i: per-mode soak ---------------------------------------
// 4096 build/play/destroy cycles for EACH panner mode, tracking census.live.
// Retention in any mode leaves nodes in the tracker after destroy().
function benchSoak() {
    const N = 4096;
    const modes = ['stereo', 'positional', 'hrtf', 'discrete'];
    const result = {};
    for (const mode of modes) {
        const opts = mode === 'discrete' ? { panner: mode, channels: 6 } : { panner: mode };
        let maxLive = 0;
        for (let i = 0; i < N; i++) {
            const ctx = makeCensusCtx();
            const pool = new AudioPool(ctx, {}, sprites, 16, null, opts);
            pool.play('laser');
            pool.play('hit');
            pool.play('boom');
            pool.destroy();
            if (ctx.census.live.size > maxLive) maxLive = ctx.census.live.size;
        }
        result[mode] = maxLive;
    }
    return { N, result };
}

// Red control RC-SOAK-RETAIN: leak exactly one built node (defeat a voice gain's
// disconnect) and prove the soak census reports retention. A soak that returns 0
// under an injected retained node is not watching anything.
function redControlSoakRetain() {
    const ctx = makeCensusCtx();
    const pool = new AudioPool(ctx, {}, sprites, 8);   // stereo
    pool.play('laser');
    pool.gains[0].disconnect = noop;   // regression: this GainNode is retained past destroy()
    pool.destroy();
    return ctx.census.live.size;       // must be >= 1
}

// ---------- Bench 3: full-saturation steal loop ---------------------------

function benchStealLoop() {
    const ctx = makeMockCtx();
    const pool = new AudioPool(ctx, {}, sprites, 32);

    // Fill capacity first (32 plays) so subsequent plays MUST steal.
    for (let i = 0; i < 32; i++) pool.play('laser');
    if (global.gc) global.gc();

    const N = 1_000_000;
    // Note: no time advance - every play into a full pool must steal.
    const t0 = performance.now();
    for (let i = 0; i < N; i++) pool.play('laser');
    const dt = performance.now() - t0;
    const rate = (N / dt) * 1000;
    return { N, dt, rate };
}

// ---------- Report ---------------------------------------------------------

console.log('');
console.log('@zakkster/lite-audio-pool - torture harness');
console.log('');
line('node',      process.version);
line('platform',  `${process.platform}/${process.arch}`);
line('gc',        global.gc ? 'exposed' : '(re-run with --expose-gc for allocation numbers)');

heading('1. Sustained throughput');
const t = benchThroughput();
line('plays',     fmt(t.N));
line('wall time', `${t.dt.toFixed(1)} ms`);
line('rate',      `${fmt(Math.round(t.rate))} plays/sec`);

heading('2. Retained allocation per play');
const a = benchAllocation('stereo');
const ap = benchAllocation('positional');
const ah = benchAllocation('hrtf');
const ad = benchAllocation('discrete', 6);
if (a) {
    const perPlayStr = (r) => Math.abs(r.perPlay) < 1
        ? `~0 B/play (delta ${fmt(r.delta)} B across ${fmt(r.N)} plays, within GC noise)`
        : `${r.perPlay.toFixed(2)} B/play`;
    line('plays',       fmt(a.N));
    line('stereo',      perPlayStr(a));
    line('positional',  perPlayStr(ap));
    line('hrtf',        perPlayStr(ah));
    line('discrete',    perPlayStr(ad));
    line('note',        'the spec requires createBufferSource per play;');
    line('',            'the pool retains 32 source refs at any moment.');
    // Every mode's play() must be zero-alloc: all four ~0 B/play.
    if (Math.abs(a.perPlay) >= 1 || Math.abs(ap.perPlay) >= 1 || Math.abs(ah.perPlay) >= 1 ||
        Math.abs(ad.perPlay) >= 1) {
        console.error('  FAIL: play() must be zero-alloc in every panner mode');
        process.exitCode = 1;
    }
} else {
    line('skipped',     're-run with --expose-gc');
}

heading('2b. Positional create/destroy census');
const c = benchCensus();
if (c) {
    const perCycleStr = Math.abs(c.perCycle) < 64
        ? `~0 B/cycle (delta ${fmt(c.delta)} B across ${fmt(c.N)} build+destroy cycles)`
        : `${c.perCycle.toFixed(2)} B/cycle`;
    line('cycles',      fmt(c.N));
    line('retained',    perCycleStr);
    // Sustained per-cycle heap growth here would mean the pool (or its arrays,
    // closures, AudioParam refs) outlives destroy() - not that a node graph
    // edge leaked (see the note above; the mock cannot observe that). 64
    // B/cycle is GC-noise slack for 2000 short-lived allocations; real
    // retention dwarfs it.
    if (Math.abs(c.perCycle) >= 64) {
        console.error('  FAIL: positional pools retain memory after destroy()');
        process.exitCode = 1;
    }
} else {
    line('skipped',     're-run with --expose-gc');
}

heading('2c. Discrete create/destroy census');
const rc = redControlDiscreteCensus();
line('red control',  rc >= 1
    ? `census caught the injected merger leak (live=${rc})`
    : `DEAD GATE: census missed the injected leak (live=${rc})`);
if (rc < 1) {
    console.error('  FAIL: red control did not fire - the census gate is dead');
    process.exitCode = 1;
}
const dc = benchDiscreteCensus();
line('cycles',       fmt(dc.N));
line('census delta', dc.maxLive === 0
    ? `0 (tracker returns to 0 on every build+destroy cycle)`
    : `${dc.maxLive} nodes left live`);
if (dc.maxLive !== 0) {
    console.error('  FAIL: discrete destroy() leaves nodes in the census');
    process.exitCode = 1;
}

heading('2d. HRTF panningModel + create/destroy census');
const rh = redControlHrtfModel();
line('red control',  rh >= 1
    ? `model census caught the injected mis-set (mismatch=${rh})`
    : `DEAD GATE: model census missed the injected mis-set (mismatch=${rh})`);
if (rh < 1) {
    console.error('  FAIL: red control did not fire - the HRTF model gate is dead');
    process.exitCode = 1;
}
const hc = benchHrtfCensus();
line('cycles',       fmt(hc.N));
line('panningModel', hc.modelMismatch === 0
    ? `every voice reports HRTF across all ${fmt(hc.N)} cycles`
    : `${hc.modelMismatch} voices did NOT report HRTF`);
if (hc.modelMismatch !== 0) {
    console.error('  FAIL: an hrtf pool built a voice that is not panningModel HRTF');
    process.exitCode = 1;
}
line('census delta', hc.maxLive === 0
    ? `0 (tracker returns to 0 on every build+destroy cycle)`
    : `${hc.maxLive} nodes left live`);
if (hc.maxLive !== 0) {
    console.error('  FAIL: hrtf destroy() leaves nodes in the census');
    process.exitCode = 1;
}

heading('2e. Stereo structural create/destroy census');
const rcStereo = redControlStereoLive();
line('red control',  rcStereo >= 1
    ? `census caught the injected StereoPanner leak (live=${rcStereo})`
    : `DEAD GATE: census missed the injected leak (live=${rcStereo})`);
if (rcStereo < 1) {
    console.error('  FAIL: RC-STEREO-LIVE did not fire - the stereo census gate is dead');
    process.exitCode = 1;
}
const sc = benchModeCensus('stereo');
line('cycles',       fmt(sc.N));
line('census delta', sc.maxLive === 0
    ? `0 (tracker returns to 0 on every build+play+destroy cycle)`
    : `${sc.maxLive} nodes left live`);
if (sc.maxLive !== 0) {
    console.error('  FAIL: stereo destroy() leaves nodes in the census');
    process.exitCode = 1;
}

heading('2f. Positional structural create/destroy census');
const rcPos = redControlPositionalLive();
line('red control',  rcPos >= 1
    ? `census caught the injected PannerNode leak (live=${rcPos})`
    : `DEAD GATE: census missed the injected leak (live=${rcPos})`);
if (rcPos < 1) {
    console.error('  FAIL: RC-POSITIONAL-LIVE did not fire - the positional census gate is dead');
    process.exitCode = 1;
}
const pc = benchModeCensus('positional');
line('cycles',       fmt(pc.N));
line('census delta', pc.maxLive === 0
    ? `0 (tracker returns to 0 on every build+play+destroy cycle)`
    : `${pc.maxLive} nodes left live`);
if (pc.maxLive !== 0) {
    console.error('  FAIL: positional destroy() leaves nodes in the census');
    process.exitCode = 1;
}

heading('2g. Zero-alloc x capacity matrix (all modes x {1,32,256})');
const rcAlloc = redControlAllocClosure();
if (rcAlloc) {
    line('red control',  rcAlloc.perPlay >= 1
        ? `gate flags the injected per-op allocation (${rcAlloc.perPlay.toFixed(1)} B/op)`
        : `DEAD GATE: gate missed the injected allocation (${rcAlloc.perPlay.toFixed(2)} B/op)`);
    if (rcAlloc.perPlay < 1) {
        console.error('  FAIL: RC-ALLOC-CLOSURE did not fire - the zero-alloc gate is dead');
        process.exitCode = 1;
    }
    const modes = [['stereo', 0], ['positional', 0], ['hrtf', 0], ['discrete', 6]];
    const caps = [1, 32, 256];
    let worstBytes = 0, worstMajor = 0;
    for (const [mode, ch] of modes) {
        for (const cap of caps) {
            const cell = await benchAllocCell(mode, ch, cap);
            const b = Math.abs(cell.perPlay);
            if (b > worstBytes) worstBytes = b;
            if (cell.major > worstMajor) worstMajor = cell.major;
            const label = `${mode} cap=${cap}`;
            const bytesStr = b < 1 ? '0 B/op' : `${cell.perPlay.toFixed(2)} B/op`;
            line(pad(label, 18), `${bytesStr}, major=${cell.major}`);
            if (b >= 1 || cell.major !== 0) {
                console.error(`  FAIL: ${label} must be 0 B/op and 0 major GC (got ${cell.perPlay.toFixed(2)} B/op, major=${cell.major})`);
                process.exitCode = 1;
            }
        }
    }
    line('matrix',       worstBytes < 1 && worstMajor === 0
        ? `all 12 cells: 0 B/op, 0 major GC`
        : `worst cell: ${worstBytes.toFixed(2)} B/op, major=${worstMajor}`);
} else {
    line('skipped',     're-run with --expose-gc');
}

heading('2h. Handle lifecycle tier');
const rcGen = redControlGenBleed();
line('red control',  rcGen === true
    ? `stale-gen bleed is observable (isPlaying=true) - the fail-closed checks bite`
    : `DEAD GATE: injected gen bleed was not observable (isPlaying=${rcGen})`);
if (rcGen !== true) {
    console.error('  FAIL: RC-GEN-BLEED did not fire - the stale-handle gate is dead');
    process.exitCode = 1;
}
const hnd = benchHandles();
line('saturation',   hnd.satOk ? `257th play steals; active count pinned at ${MAX_CAPACITY}` : 'FAILED');
line('gen wrap',     hnd.wrapOk ? `2^24 wrap: stale handle fails closed, no channel bleed` : 'FAILED');
line('post-destroy', hnd.staleOk ? `stale handle after destroy() never resolves to a node` : 'FAILED');
line('double free',  hnd.doubleOk ? `destroy() x2 is idempotent` : 'FAILED');
if (!hnd.satOk)    { console.error('  FAIL: saturation at MAX_CAPACITY did not steal / stayed unfilled'); process.exitCode = 1; }
if (!hnd.wrapOk)   { console.error('  FAIL: generation wraparound bled into the channel field or accepted a stale handle'); process.exitCode = 1; }
if (!hnd.staleOk)  { console.error('  FAIL: a handle resolved to a live node after destroy()'); process.exitCode = 1; }
if (!hnd.doubleOk) { console.error('  FAIL: double destroy() threw'); process.exitCode = 1; }

heading('2i. Per-mode soak (4096 cycles x 4 modes)');
const rcSoak = redControlSoakRetain();
line('red control',  rcSoak >= 1
    ? `soak census caught the injected retained gain (live=${rcSoak})`
    : `DEAD GATE: soak census missed the injected retention (live=${rcSoak})`);
if (rcSoak < 1) {
    console.error('  FAIL: RC-SOAK-RETAIN did not fire - the soak census gate is dead');
    process.exitCode = 1;
}
const soak = benchSoak();
for (const mode of ['stereo', 'positional', 'hrtf', 'discrete']) {
    const live = soak.result[mode];
    line(pad(mode, 12), live === 0
        ? `0 retained across ${fmt(soak.N)} cycles`
        : `${live} nodes retained after destroy()`);
    if (live !== 0) {
        console.error(`  FAIL: ${mode} soak retained ${live} nodes after destroy()`);
        process.exitCode = 1;
    }
}

heading('3. Full-saturation steal loop');
const s = benchStealLoop();
line('plays',     fmt(s.N));
line('wall time', `${s.dt.toFixed(1)} ms`);
line('rate',      `${fmt(Math.round(s.rate))} plays/sec (every call steals)`);

console.log('');
console.log('Context: these numbers measure only the pool\'s own scheduling');
console.log('cost against a mock ctx. A real Web Audio backend adds its own');
console.log('per-node overhead which dominates in production. Run bench/');
console.log('torture.html for real-hardware side-by-side numbers.');
console.log('');
