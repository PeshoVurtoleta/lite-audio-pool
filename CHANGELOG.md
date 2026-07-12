# Changelog

## 1.1.0

Three additive features designed to make the pool composable inside a larger
Web Audio graph — specifically, to serve as the SFX voice layer for the
upcoming `@zakkster/lite-audio` engine. No breaking changes to existing
signatures; the 4-arg `new AudioPool(ctx, buf, sprites, cap)` constructor and
the single-play-then-stop opaque-handle usage keep working identically.

### Added

- **`output` node option** (constructor 5th arg). Pass any `AudioNode`
  (typically a `GainNode` bus) to route the pool's voices there instead of
  `ctx.destination`. Defaults to `ctx.destination` when omitted.
- **Per-play buffer override** (`play()` 5th arg). Pass an alternate
  `AudioBuffer` to play through the pool's channels without changing the
  default `this.buffer`. Useful when multiple sprite atlases share one pool's
  voice budget.
- **Generation-stamped return handles**. `play()` now returns a packed handle
  `((gen << 8) | channel) >>> 0` instead of a raw channel index. `stop(handle)`
  decodes and checks the generation; a stale handle whose channel has been
  stolen or naturally ended is a silent no-op instead of a wrong-voice hit.
  For the first play on a virgin channel `gen === 0`, so the returned handle
  equals the channel index — legacy code that treats the return value opaquely
  (get X from play, pass X to stop) keeps working with no changes.
- **`isPlaying(handle)`**. Answers the exact question `stop()` answers
  internally: does this handle still name a sounding voice? Returns `false` for
  a channel that was stolen, stopped, or has played out. Without it, callers
  that want to know whether their shot survived have to read `generations[]`
  and `expireTimes[]` and reimplement the guard — which means the guard now
  lives in two places and can drift.
- **`activeCount()`**. Live voice count, allocation-free, safe to call per
  frame. The number every HUD, mixer, and ducking rule wants.

### Changed

- **`capacity` is validated, not clamped.** It was silently `Math.min(cap, 256)`,
  which turned "I asked for 512 voices" into "you have 256 and no idea why".
  Out-of-range or non-integer capacity now throws a `RangeError` naming the
  reason: the handle packs the channel index into 8 bits, so 256 is the last
  index the mask can address. The bound is no longer a loose number either —
  `CHANNEL_BITS` is the single source of truth and `MAX_CAPACITY` derives from
  it, so widening the channel field cannot desync the limit from the mask that
  decodes it.
- **Sprite tables are validated at construction.** A sprite missing `duration`,
  or carrying a negative `start`, used to survive wiring and surface later as a
  silent `-1` from `play()` mid-playtest. It now throws a `TypeError` naming
  the offending sprite, once, at the point where the mistake was made.

### Fixed

- **Voice expiry lost precision as the context aged.** `expireTimes` was an
  `Float32Array` holding *absolute* `AudioContext.currentTime`, which only ever
  grows. At 24 hours of uptime (~86400s) f32 spacing is roughly 8ms — wider
  than a footstep, a UI click, or any short sprite. Expiry comparisons would
  start rounding voices alive or dead, and the "pick the channel that expires
  soonest" scan would pick badly. Promoted to `Float64Array`: 8 bytes x 256
  channels is 2KB, and the precision is not optional for anything that runs for
  hours (a stream overlay, a long session, a kiosk). Covered by a regression
  test that fails against f32.
- **Late-firing `onended` clobber.** Prior versions unconditionally nulled
  `sources[ch]` inside the source's `onended` callback. When a source was
  stolen and its stop was scheduled, its `onended` would fire after the
  replacement source had already been installed, silently dropping the new
  source's reference. The callback is now guarded by an identity check, so
  only the still-current occupant of a channel can null its own slot; a stolen
  source that fires late finds itself absent from `sources` and retires
  nothing.
- **Pan snapped mid-fade on a steal.** `play()` assigned `panner.pan.value`
  immediately, at `currentTime`. The voice being stolen is still audible for
  another 20ms while its gain ramps out, so the incoming pan jumped the
  outgoing voice across the stereo field, producing a click on every steal.
  Pan is now scheduled with `setValueAtTime(pan, startTime)`, matching how
  gain is already handled: the outgoing voice keeps its pan for the whole
  fade, and the new pan lands exactly when the new source starts.
- **`destroy()` left its nodes in the audio graph.** The method nulled its
  references but never called `disconnect()`, so every `GainNode` and
  `StereoPannerNode` the pool had built stayed wired to the `output` bus.
  Harmless for a pool that lives as long as the page, a leak for anything that
  rebuilds pools (a capacity change, a scene teardown). `destroy()` now
  disconnects any live source, then the panners and gains it created, before
  releasing references.
- **`destroy()` twice threw.** The second call reached `stopAll()` with a
  nulled `ctx` and died on `this.ctx.currentTime`. Teardown is now idempotent.

### Internal

- New private `_stopChannel(channel)` method contains the actual gain-ramp +
  `source.stop` scheduling. `stop(handle)` decodes and generation-checks
  before delegating; `stopAll()` iterates raw indices and bypasses the check
  (so every live channel is stopped regardless of generation).
- New private `_onEnded(event)` handler, bound once per pool in the
  constructor and assigned to every source by reference. The previous arrow
  function allocated one closure per `play()`; the only remaining per-play
  allocation is the `AudioBufferSourceNode` itself, which is one-shot by spec.
  The handler locates its channel by identity scan over `sources` rather than
  by a captured index — O(capacity) on a cold path (once per voice, off the
  frame loop), and the scan *is* the ABA guard.

### Tooling

- New `bench/torture.js` Node harness: measures sustained throughput,
  retained allocation per play, and full-saturation steal-loop cost.
  Run with `npm run bench` (requires `--expose-gc`, wired into the script).
- New `bench/torture.html` browser bench: same workload against both
  Howler.js and lite-audio-pool on a real Web Audio backend with an
  identical synthesized sprite atlas.
- New `demo/index.html`: single-file oscilloscope demo, four scenes.
  **scope** — rising-edge-triggered `AnalyserNode` trace, log spectrum, and an
  atlas map strip drawn from the decoded buffer's own envelope with the sprite
  regions overlaid (click a region to play it). **steal** — a small pool fed a
  2s sprite, with a live handle table showing each handle's channel,
  generation, and status; pressing `stop` on a stolen handle demonstrates the
  guarded no-op while the channel keeps sounding. **field** — an XY pad
  driving pan and pitch, and bus rewiring (direct / lowpass / convolver) that
  moves all voices at once without the pool knowing. **stress** — a 0-600
  plays/s firehose against a 256-frame frame-time ring. Voice matrices are
  canvas-drawn, so nothing in the frame loop touches the DOM.
- Test runner migrated from `vitest` to `node:test` (zero devDeps).
  Tests moved to `test/`. Existing 10-test coverage preserved verbatim, plus
  new cases for pan scheduling, shared-handler identity, `destroy()` teardown
  and idempotency, `onended` firing after `destroy()`, capacity and sprite-map
  validation, `isPlaying()` across the stolen/ended/stopped transitions,
  generation wraparound not bleeding into the channel field, and f64 expiry
  precision at 24h of context uptime.

## 1.0.2

Initial published version.
