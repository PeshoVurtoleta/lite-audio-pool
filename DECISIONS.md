# Decision records

Architecture decisions for @zakkster/lite-audio-pool. Newest first. Each record
is immutable once ruled; a reversal is a new record that supersedes the old one.

## DR-001 HRTF ships as a fourth `panner` enum value, not a separate option

### Context

Session S3b adds binaural HRTF panning to the pool. In the Web Audio API, HRTF
is not a distinct node type: it is the `panningModel = 'HRTF'` attribute on a
`PannerNode`, the same node `panner: 'positional'` already builds. The pool
already hardcodes `panner.panningModel = 'equalpower'` once, at cold
construction (`AudioPool.js`), and the hot path (`play()`, `voiceNode()`) never
reads the mode - it reads pre-resolved per-voice locals. The question is how a
caller opts into `'HRTF'` without adding a hot-path branch or a second concept
to co-validate.

### Options

1. **Fourth `panner` enum value: `'hrtf'`.** A positional `PannerNode` with the
   identical distance graph as `'positional'`, differing only in
   `panningModel='HRTF'`. Resolved once at construction into the same captured
   locals `'positional'` uses.
2. **Separate `options.panningModel` field**, valid only when
   `panner === 'positional'`. HRTF becomes `{ panner: 'positional',
   panningModel: 'HRTF' }`.

### Ruling

Adopt option 1: `panner: 'hrtf'`.

### Consequences

- One axis, one validation. `panner` stays a single closed enum
  (`stereo|positional|hrtf|discrete`) with a did-you-mean `RangeError`; there is
  no cross-field rule like "panningModel is only valid when panner is
  positional" to write, test, or explain.
- The seam matches `@zakkster/lite-audio`'s `spatial: 'hrtf'`, which is a peer
  of `'positional'`, so the two libraries name the same concept the same way.
- `panningModel` is resolved once at construction into a captured local; the hot
  path gains no branch and no bytes. The only behavioral source line that
  changes is the per-voice `panner.panningModel = panningModel` assignment.
- Rejected option 2 was declined because it adds a second option to co-validate
  against `panner` and a second axis for one concept, with no expressive gain -
  `'HRTF'` and `'equalpower'` are the only two `panningModel` values, and
  `'equalpower'` is exactly what `'positional'` already means.
- Default construction (`'stereo'`) and `'positional'` stay byte-identical to
  prior releases; `'hrtf'` differs from `'positional'` by exactly the
  `panningModel` value.
