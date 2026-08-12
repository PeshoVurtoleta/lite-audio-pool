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
