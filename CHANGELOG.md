# Changelog

## 1.3.0

Discrete surround, opt-in and cold-path only. This is Session S2 of the spatial
roadmap: the pool gains a `panner: 'discrete'` voice mode that fans each voice
through pre-allocated per-channel GainNode lanes into a shared `ChannelMerger`.
No breaking changes; the default (and every prior mode) is byte-identical to 1.2.0.

### Added

- **`panner: 'discrete'` construction mode** with a required `channels` in `{4, 6, 8}`
  (4 = L,R,C,LFE; 6 = +SL,SR; 8 = +SBL,SBR). Each voice routes
  `source -> gain -> N lane GainNodes -> ChannelMerger(N) -> output`. Lane index 3
  (LFE) is band-limited through ONE shared lowpass per pool, summed pool-wide, then
  fed into merger input 3. All other lanes connect straight to their merger input k.
- **Lane default gains.** L and R (lanes 0,1) default to `0.7071`; every other lane,
  including LFE, defaults to `0.0`. An unpositioned discrete voice therefore plays
  front-stereo and is never silent.
- **`voiceNode()` returns the per-voice lane array in discrete mode** - a pre-allocated
  `Array(N)` of the lane GainNodes (write `.gain.value` on lane k to place the voice).
  The array is built once at construction, so the call allocates nothing. Stereo and
  positional modes still return their single node. The existing generation +
  `Number.isInteger` fail-closed guards are unchanged.

### Design note - inert pan and shared LFE

In discrete mode the `pan` arg is INERT: it lands on a single detached per-pool
`GainNode` (`_panSink`) that is never connected to anything, so the hot `play()` path
keeps the exact one-event-per-play shape it has in stereo/positional - no new branch,
no new bytes. Placement is done through the lane array from `voiceNode()`, not `pan`.
LFE is one lowpass for the whole pool, fed per-voice through lane 3, so surround
voices share a single band-limited sub bus rather than one filter per voice.

### Fail-closed validation

- `panner` now accepts `'stereo'|'positional'|'discrete'`; anything else throws `RangeError`.
- `'discrete'` without a `channels` value in `{4,6,8}` (absent, non-integer, or out of set)
  throws `RangeError`.
- `channels` passed with a non-discrete `panner` throws `RangeError`.
- `'discrete'` against a context lacking `createChannelMerger` or `createBiquadFilter`
  throws `TypeError` - the surround graph cannot be silently half-built.
- `destroy()` is now null-safe for discrete voices (which carry no `PannerNode`): it
  disconnects every lane gain, the shared merger, the shared lowpass, the pan sink, the
  voice gains, and any live sources, and only calls `panners[i].disconnect()` when the
  panner is non-null. Still idempotent.

### Guarantee

Default (`'stereo'`) construction - and `'positional'` - remains byte-identical to 1.2.0.
The only hot-body edit is the source-connect target, pre-resolved once per mode into a
`voiceInputs[]` array (panner for stereo/positional, gain for discrete); `play()` gained
no branch. All three modes measure zero-alloc per play, and 4096 discrete build+destroy
cycles leave a node census tracker at 0 (proven with an asserted red control).

## 1.2.0

Positional audio, opt-in and cold-path only. This is Session S1 of the spatial
roadmap: the pool gains a `PannerNode` voice mode and a seam for `@zakkster/lite-audio`
to write 3D position without reaching into pool internals. No breaking changes;
the default is byte-identical to 1.1.0.

### Added

- **`panner` construction mode** (constructor 6th arg `options.panner`). Defaults
  to `'stereo'` (unchanged: each voice is a `StereoPannerNode`, `pan` writes `.pan`).
  Pass `{ panner: 'positional' }` and each voice becomes a `PannerNode` where the
  `pan` arg writes `.positionX` instead. An unknown value throws a `RangeError` at
  construction; a context whose `PannerNode` lacks the `positionX` AudioParam throws
  a `TypeError` (fail closed, not a silently dropped write).
- **`voiceNode(handle)`**. Returns the per-voice spatial node for a live handle,
  else `null`. Generation-checked and fail-closed exactly like `stop()`/`isPlaying()`:
  a stolen, stopped, expired, or bogus handle returns `null`, never a stale node.
  This is the seam `@zakkster/lite-audio` uses to set full 3D position (`.positionX/Y/Z`)
  in a later session.

### Hardened

- **`voiceNode`/`stop`/`isPlaying` reject non-integer handles** (fail-closed;
  `undefined`/`null`/`NaN` no longer alias to channel 0). The bitwise decode
  coerced those to the bit pattern of handle `0` - a valid handle for the first
  voice on channel 0 - so `stop(undefined)` on a fresh pool could kill a live
  voice. The guard now runs `Number.isInteger(handle) && handle >= 0` first,
  which accepts every real uint32 handle (including `0` and `-0`). The
  `stop`/`isPlaying` hardening predates S1 but ships here.

### Design note - why `pan -> positionX` in positional mode

The listener defaults to the origin facing `-Z`, so `+X` is right; mapping
`pan -1..+1 -> positionX -1..+1` is directionally identical to `StereoPanner`.
With `distanceModel='inverse'` and `refDistance=1`, every source across the whole
pan range (distance `<= 1`, `y=z=0`) has gain exactly `1` - zero distance
attenuation and no distance-0 blowup (inverse clamps to gain 1 at/inside
`refDistance`). Loudness therefore stays owned entirely by the gain node, and
`play()` stays branch-free: the mode only swaps which AudioParam the hot path
writes, decided once at construction.

### Guarantee

Default (`'stereo'`) construction is byte-identical to 1.1.0. The hot `play()`
path gained no branch - it caches a `panTargets[]` param source that was chosen
once, cold. Positional `play()` measures zero-alloc, same as stereo.

## 1.1.0

Three additive features designed to make the pool composable inside a larger
Web Audio graph -- specifically, to serve as the SFX voice layer for the
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
  equals the channel index -- legacy code that treats the return value opaquely
  (get X from play, pass X to stop) keeps working with no changes.
- **`isPlaying(handle)`**. Answers the exact question `stop()` answers
  internally: does this handle still name a sounding voice? Returns `false` for
  a channel that was stolen, stopped, or has played out. Without it, callers
  that want to know whether their shot survived have to read `generations[]`
  and `expireTimes[]` and reimplement the guard -- which means the guard now
  lives in two places and can drift.
- **`activeCount()`**. Live voice count, allocation-free, safe to call per
  frame. The number every HUD, mixer, and ducking rule wants.

### Changed

- **`capacity` is validated, not clamped.** It was silently `Math.min(cap, 256)`,
  which turned "I asked for 512 voices" into "you have 256 and no idea why".
  Out-of-range or non-integer capacity now throws a `RangeError` naming the
  reason: the handle packs the channel index into 8 bits, so 256 is the last
  index the mask can address. The bound is no longer a loose number either --
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
  grows. At 24 hours of uptime (~86400s) f32 spacing is roughly 8ms -- wider
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
  by a captured index -- O(capacity) on a cold path (once per voice, off the
  frame loop), and the scan *is* the ABA guard.

### Tooling

- New `bench/torture.js` Node harness: measures sustained throughput,
  retained allocation per play, and full-saturation steal-loop cost.
  Run with `npm run bench` (requires `--expose-gc`, wired into the script).
- New `bench/torture.html` browser bench: same workload against both
  Howler.js and lite-audio-pool on a real Web Audio backend with an
  identical synthesized sprite atlas.
- New `demo/index.html`: single-file oscilloscope demo, four scenes.
  **scope** -- rising-edge-triggered `AnalyserNode` trace, log spectrum, and an
  atlas map strip drawn from the decoded buffer's own envelope with the sprite
  regions overlaid (click a region to play it). **steal** -- a small pool fed a
  2s sprite, with a live handle table showing each handle's channel,
  generation, and status; pressing `stop` on a stolen handle demonstrates the
  guarded no-op while the channel keeps sounding. **field** -- an XY pad
  driving pan and pitch, and bus rewiring (direct / lowpass / convolver) that
  moves all voices at once without the pool knowing. **stress** -- a 0-600
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
