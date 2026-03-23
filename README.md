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
- 🪶 < 1 KB minified

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

// Play a sound (returns channel ID)
const ch = pool.play('laser', 1.0, 0.0, 1.0);
//                     id    vol   pan  pitch

// Stop a specific channel (20ms anti-pop fade)
pool.stop(ch);

// Stop everything (scene transitions)
pool.stopAll();
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
- weighs under 1 KB

It's built for games, not apps.

## 📊 Comparison

| Library | Size | Allocations | Voice Stealing | Pitch | Pan | Use Case |
|---------|------|-------------|----------------|-------|-----|----------|
| howler.js | ~35 KB | High | No | Yes | Yes | General audio |
| pizzicato | ~12 KB | Medium | No | Yes | Yes | Effects chains |
| **lite-audio-pool** | **< 1 KB** | **Zero** | **Yes (anti-pop)** | **Yes** | **Yes** | **Games, SFX, sprites** |

## ⚙️ API

### `new AudioPool(ctx, audioBuffer, spriteMap, capacity?)`

Creates a pool of pre-wired audio channels.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `ctx` | `AudioContext` | — | Your Web Audio context |
| `audioBuffer` | `AudioBuffer` | — | The decoded sprite file |
| `spriteMap` | `Record<string, { start, duration }>` | — | Named slices into the buffer |
| `capacity` | `number` | `32` | Max concurrent voices (clamped to 256) |

### `play(spriteId, volume?, pan?, pitch?)`

Plays a sound sprite immediately. Returns the channel index used, or `-1` if the sprite ID is invalid.

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `spriteId` | `string` | — | — | Key from your sprite map |
| `volume` | `number` | `1.0` | 0–∞ | Gain multiplier |
| `pan` | `number` | `0.0` | -1 to 1 | Stereo position (clamped) |
| `pitch` | `number` | `1.0` | 0–∞ | Playback rate (2 = octave up) |

If all channels are busy, the oldest channel is stolen with a 20ms anti-pop fade-out before the new sound starts.

### `stop(channelId)`

Stops a specific channel with a 20ms fade. Safe to call with invalid IDs.

### `stopAll()`

Stops all active channels. Useful for scene transitions or pause screens.

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

```
32 concurrent voices, rapid fire:

howler.js:
  - Allocates new AudioBufferSourceNode per play
  - GC spikes at 60–120ms intervals

lite-audio-pool:
  - Reuses pre-wired nodes
  - Zero allocations during gameplay
  - No GC spikes
  - Smooth 60–240 FPS gameplay
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
                │  expireTimes: Float32Array(N)    │
                │  sources:     Array(N)          │
                └─────────────────────────────────┘

GainNode and StereoPanner are pre-wired at construction.
Only BufferSource is created per play (required by Web Audio spec).
Voice stealing: oldest channel → 20ms gain ramp to 0.0001 → stop → new source.
```

## 📦 TypeScript

Full TypeScript declarations included in `AudioPool.d.ts`.

## 📚 LLM-Friendly Documentation

See `llms.txt` for AI-optimized metadata and usage examples.

## License

MIT
