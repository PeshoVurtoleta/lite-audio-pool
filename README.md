# @zakkster/lite-audio-pool

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-audio-pool.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-audio-pool)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-audio-pool?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-audio-pool)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-audio-pool?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-audio-pool)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-audio-pool?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-audio-pool)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

## 🎧 What is lite-audio-pool?

`@zakkster/lite-audio-pool` is a zero-allocation, pre-wired, high-performance Web Audio sound system designed for real-time games.

It gives you:

- 🔊 32+ concurrent voices
- ⚡ O(1) channel reuse
- 🔄 Voice stealing with 20ms anti-pop fade
- 🎚️ Volume, pan, and pitch per sound
- 🧩 Sprite-based audio (single buffer, many sounds)
- 🧼 Zero garbage collection during gameplay
- 🪶 ~2 KB minified, < 1 KB gzipped

It's the opposite of a big audio framework — it's a tiny, raw, predictable tool that gives you full control without overhead.

Part of the [@zakkster/lite-*](https://www.npmjs.com/org/zakkster) ecosystem — micro-libraries built for deterministic, cache-friendly game development.

## 🚀 Install

```bash
npm i @zakkster/lite-audio-pool
```

## 🕹️ Quick Start

```javascript
import { AudioPool } from '@zakkster/lite-audio-pool';

// Your Web Audio context
const ctx = new AudioContext();

// Your sprite atlas (one AudioBuffer, many slices)
const spriteMap = {
  laser:   { start: 0.00, duration: 0.15 },
  hit:     { start: 0.20, duration: 0.10 },
  explode: { start: 0.35, duration: 0.40 }
};

// Create a pool with 32 channels
const pool = new AudioPool(ctx, audioBuffer, spriteMap, 32);

// Play a sound (returns a generation-stamped handle)
const handle = pool.play('laser', 1.0, 0.0, 1.0);
//                          id    vol   pan  pitch

// Stop that specific play (20ms anti-pop fade).
// If the channel was stolen since play() returned, stop() is a silent no-op.
pool.stop(handle);

// Stop everything (scene transitions)
pool.stopAll();
```

### Routing into a bus

Pass any `AudioNode` (typically a `GainNode`) as the optional 5th argument
to route the pool's voices into that node instead of `ctx.destination`.
This is how a mixer parents the pool under a bus without altering the pool's
internal graph:

```javascript
const sfxBus = ctx.createGain();
sfxBus.connect(ctx.destination);

const pool = new AudioPool(ctx, buf, spriteMap, 32, sfxBus);
// Every voice now flows through sfxBus.gain, so muting/ducking the bus
// affects the whole pool with one AudioParam write.
```

### Per-play buffer override

`play()` accepts an optional 6th argument: an alternate `AudioBuffer` to use
for just this play, without changing the pool's default buffer. Useful when
multiple sprite atlases share one pool's voice budget:

```javascript
pool.play('laser', 1.0, 0.0, 1.0, alternateAtlas);
```

## 🧠 Why This Exists

Most JS audio libraries:

- allocate new nodes per sound
- create garbage on every play
- cause audio pops when stealing voices
- hide Web Audio behind abstractions
- weigh 10–40 KB

lite-audio-pool does the opposite:

- pre-allocates everything at construction
- reuses channels in O(1)
- applies a 20ms gain ramp to prevent pops
- exposes raw Web Audio behavior
- weighs ~2 KB minified, under 1 KB gzipped

It's built for games, not apps.

## 📊 Comparison

| Library | Size | Allocations | Voice Stealing | Pitch | Pan | Use Case |
|---------|------|-------------|----------------|-------|-----|----------|
| howler.js | ~35 KB | High | No | Yes | Yes | General audio |
| pizzicato | ~12 KB | Medium | No | Yes | Yes | Effects chains |
| **lite-audio-pool** | **~2 KB / <1 KB gz** | **Zero** | **Yes (anti-pop)** | **Yes** | **Yes** | **Games, SFX, sprites** |

## ⚙️ API

### `new AudioPool(ctx, audioBuffer, spriteMap, capacity?, output?)`

Creates a pool of pre-wired audio channels.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `ctx` | `AudioContext` | — | Your Web Audio context |
| `audioBuffer` | `AudioBuffer` | — | Default decoded sprite file |
| `spriteMap` | `Record<string, { start, duration }>` | — | Named slices into the buffer |
| `capacity` | `number` | `32` | Max concurrent voices, integer in `[1, 256]`. Throws `RangeError` if outside that range — the handle packs the channel index into 8 bits, so 256 is the last slot the mask can address. |
| `output` | `AudioNode \| null` | `ctx.destination` | Destination node. Pass a `GainNode` to route the pool through a bus. |

The constructor validates its inputs eagerly. Missing `ctx` or `spriteMap`
throws `TypeError`. A sprite entry lacking `duration`, or carrying a negative
`start`, throws `TypeError` naming the offending sprite — typos fail at wiring,
not as a silent `-1` the first time a playtester triggers them.

### `play(spriteId, volume?, pan?, pitch?, buffer?)`

Plays a sound sprite immediately. Returns a **generation-stamped handle**:
`((generation << 8) | channel) >>> 0`. Pass this handle to `stop()` for
ABA-safe stopping. Returns `-1` if the sprite ID is invalid.

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `spriteId` | `string` | — | — | Key from your sprite map |
| `volume` | `number` | `1.0` | 0–∞ | Gain multiplier |
| `pan` | `number` | `0.0` | -1 to 1 | Stereo position (clamped) |
| `pitch` | `number` | `1.0` | 0–∞ | Playback rate (2 = octave up) |
| `buffer` | `AudioBuffer \| null` | `this.buffer` | — | Optional per-play buffer override |

If all channels are busy, the oldest channel is stolen with a 20ms anti-pop
fade-out before the new sound starts. **When a channel is stolen, its old
handle immediately goes stale** — a subsequent `stop(oldHandle)` becomes a
silent no-op instead of stopping the new (wrong) voice.

For the first play on a virgin channel, `generation === 0`, so the returned
handle equals the channel index. Code that treats the return value as an
opaque token (`stop(pool.play(id))`) keeps working across the v1.0 → v1.1
upgrade with no changes.

### `stop(handle)`

Stops the play identified by `handle` with a 20ms fade.
- Stale handles (channel stolen or already ended): silent no-op.
- Negative or out-of-range handles: silent no-op.
- Safe to call multiple times on the same handle.

### `isPlaying(handle)`

Returns `true` iff the handle still names a sounding voice. `false` for a
channel that was stolen, has played out, or was stopped. Runs the same guard
`stop()` runs internally — so callers never have to read `generations[]` and
`expireTimes[]` themselves.

### `activeCount()`

Returns the number of voices currently sounding (`0..capacity`). Allocation-free
and safe to call every frame. The number every HUD, mixer, and ducking rule
wants.

### `stopAll()`

Stops all active channels immediately. Handles issued before this call are
invalidated. Useful for scene transitions or pause screens.

### `destroy()`

Stops every sound, `disconnect()`s every node the pool built from the
`output` bus, and releases references. Idempotent — calling it twice is safe.
Use this when rebuilding a pool (capacity change, scene teardown) so the old
voices don't linger on the graph.

### Sprite Map Format

```javascript
{
  laser:   { start: 0.00, duration: 0.15 },
  hit:     { start: 0.20, duration: 0.10 },
  explode: { start: 0.35, duration: 0.40 }
}
```

Each entry defines a time slice within the single `AudioBuffer`. The `start` is in seconds from the beginning of the buffer, `duration` is the length in seconds.

## 🧪 Benchmark

Numbers from `bench/torture.js` (Node 22, linux/x64, run with `--expose-gc`,
median of 5 runs, mock `AudioContext` so the harness measures the pool's own
dispatch cost rather than backend overhead):

| Workload                        | Rate                  | Notes                                    |
| ------------------------------- | --------------------- | ---------------------------------------- |
| Sustained throughput            | **~14M plays/sec**    | fresh-channel path, 5M plays / ~350 ms   |
| Full-saturation steal loop      | **~9.4M plays/sec**   | every call must steal, 1M plays / ~110ms |
| Retained heap per play          | **~0 B/play**         | delta within GC noise across 1M plays    |

Run it yourself:

```bash
npm run bench
```

### Side-by-side with Howler.js

`bench/torture.html` runs the same workload against both Howler and
lite-audio-pool on a real Web Audio backend, using an identical synthesized
sprite atlas so the comparison is content-neutral. Serve it locally:

```bash
npx serve .
# open http://localhost:3000/bench/torture.html
```

**Framing this fairly:** Howler.js is a full-service audio library — it does
decoding, HTML5 Audio fallback, format detection across MP3/OGG/WAV/M4A,
streaming, spatial audio, and much more that lite-audio-pool intentionally
does not touch. lite-audio-pool covers exactly one narrow slice:
pre-wired sprite dispatch with voice stealing for real-time games. The bench
measures both libraries on that one slice; the numbers are not a verdict on
either project, just a data point for picking the right tool for a given job.

## 🎧 Live demo

`demo/index.html` is a single-file oscilloscope-themed demo, four scenes:

- **scope** — rising-edge-triggered `AnalyserNode` trace, log spectrum, and an
  atlas map strip drawn from the decoded buffer's envelope with sprite regions
  overlaid (click a region to play it).
- **steal** — a small pool fed a 2-second sprite, with a live handle table
  showing each handle's channel, generation, and status. Pressing `stop` on a
  stolen handle demonstrates the guarded no-op while the channel keeps
  sounding.
- **field** — XY pad driving pan and pitch, plus bus rewiring (direct /
  lowpass / convolver) that moves all voices at once without the pool knowing.
- **stress** — 0–600 plays/s firehose against a 256-frame frame-time ring.

Voice matrices are canvas-drawn; nothing in the frame loop touches the DOM.

```bash
npx serve .
# open http://localhost:3000/demo/
```

## 🔧 Internal Architecture

```
                ┌─────────────────────────────────┐
                │         AudioPool               │
                │                                 │
  play('laser') │  ┌─ Channel 0 ──────────────┐  │
  ─────────────►│  │ StereoPanner → GainNode ──┤──┼──► ctx.destination
                │  │ BufferSource ─►           │  │
                │  └───────────────────────────┘  │
                │  ┌─ Channel 1 ──────────────┐  │
                │  │ StereoPanner → GainNode ──┤──┤
                │  │ BufferSource ─►           │  │
                │  └───────────────────────────┘  │
                │  ...                            │
                │  ┌─ Channel N ──────────────┐  │
                │  │ StereoPanner → GainNode ──┤──┤
                │  │ BufferSource ─►           │  │
                │  └───────────────────────────┘  │
                │                                 │
                │  expireTimes: Float64Array(N)   │
                │  generations: Uint32Array(N)    │
                │  sources:     Array(N)          │
                └─────────────────────────────────┘

GainNode and StereoPanner are pre-wired at construction.
Only BufferSource is created per play (required by Web Audio spec).
Voice stealing: oldest channel → 20ms gain ramp to 0.0001 → stop → new source.
Handles are (generation << 8) | channel, ABA-safe under stealing.
```

## 📦 TypeScript

Full TypeScript declarations included in `AudioPool.d.ts`.

## 📚 LLM-Friendly Documentation

See `llms.txt` for AI-optimized metadata and usage examples.

## License

MIT
