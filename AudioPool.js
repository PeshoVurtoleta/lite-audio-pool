/** @zakkster/lite-audio-pool - Zero-GC Web Audio Sound Sprite Pool */

/**
 * Handle layout. A handle is one uint32: [ gen : 24 ][ channel : 8 ].
 * These are the single source of truth. MAX_CAPACITY is derived from CHANNEL_BITS,
 * so widening the channel field cannot silently desync the capacity limit from the
 * mask that decodes it.
 */
const CHANNEL_BITS = 8;
const CHANNEL_MASK = (1 << CHANNEL_BITS) - 1;            // 0xFF
const MAX_CAPACITY = 1 << CHANNEL_BITS;                  // 256
const GEN_MASK = ((1 << (32 - CHANNEL_BITS)) - 1) >>> 0; // 0xFFFFFF

/**
 * Scheduling. Every voice starts START_LEAD ahead of the wall clock so a stolen
 * occupant has room to fade out first. START_LEAD must exceed FADE_SECONDS, or the
 * outgoing voice would still be audible when the new one begins.
 */
const FADE_SECONDS = 0.02;
const START_LEAD = 0.025;
const FADE_FLOOR = 0.0001;                               // exponential ramps cannot reach 0

export class AudioPool {
    /**
     * @param {AudioContext} audioContext
     * @param {AudioBuffer} audioBuffer - Default decoded sprite file
     * @param {Object} spriteMap - e.g., { "laser": { start: 0, duration: 0.5 } }
     * @param {number} [capacity=32] - Max concurrent voices, 1..256 (see handle layout)
     * @param {AudioNode|null} [output=null] - Optional destination node (defaults to
     *   ctx.destination). Pass a GainNode to route the pool's voices into a bus.
     * @param {Object} [options={}] - Construction options.
     * @param {'stereo'|'positional'} [options.panner='stereo'] - Per-voice pan node.
     *   'stereo' uses StereoPannerNode (pan -> .pan). 'positional' uses PannerNode
     *   (pan -> .positionX): listener at origin facing -Z, so +X is right; distanceModel
     *   'inverse' with refDistance 1 keeps every source at distance <= 1 (the whole pan
     *   range, y=z=0) at gain exactly 1 - zero distance attenuation, loudness stays owned
     *   by the gain node. Full 3D is set later via voiceNode(). Default is byte-identical
     *   to prior releases.
     * @throws {RangeError} if capacity does not fit the handle's channel field, or panner
     *   mode is not 'stereo' or 'positional'
     * @throws {TypeError} if a sprite entry is malformed, or positional mode is requested
     *   against a context whose PannerNode lacks the positionX AudioParam interface
     */
    constructor(audioContext, audioBuffer, spriteMap, capacity = 32, output = null, options = {}) {
        if (!audioContext) throw new TypeError('AudioPool: audioContext is required');
        if (!spriteMap) throw new TypeError('AudioPool: spriteMap is required');
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
            throw new RangeError(
                'AudioPool: capacity must be an integer in [1, ' + MAX_CAPACITY + ']. Handles ' +
                'pack the channel index into ' + CHANNEL_BITS + ' bits, so a larger pool would ' +
                'alias channels onto each other.'
            );
        }
        const mode = options.panner || 'stereo';
        if (mode !== 'stereo' && mode !== 'positional') {
            throw new RangeError(
                'AudioPool: options.panner must be "stereo" or "positional", got "' + mode + '".'
            );
        }
        // Validated once, at construction: a typo in a sprite table should fail at the
        // wiring stage, not turn into a silent -1 on the first shot of a playtest.
        for (const id in spriteMap) {
            const sprite = spriteMap[id];
            if (!sprite || !Number.isFinite(sprite.start) || !Number.isFinite(sprite.duration) ||
                sprite.start < 0 || sprite.duration <= 0) {
                throw new TypeError(
                    'AudioPool: sprite "' + id + '" needs a finite start >= 0 and duration > 0'
                );
            }
        }

        this.ctx = audioContext;
        this.buffer = audioBuffer;
        this.spriteMap = spriteMap;
        this.capacity = capacity;
        this.output = output || audioContext.destination;
        this.panMode = mode;

        // f64, not f32. These hold absolute AudioContext time, which only grows: a context
        // left open for a day reaches ~86400s, where f32 spacing is ~8ms - wider than most
        // sprites. Expiry comparisons would start rounding voices alive or dead. 8 bytes x
        // 256 channels is 2KB, and the precision is not optional.
        this.expireTimes = new Float64Array(this.capacity);
        this.generations = new Uint32Array(this.capacity);

        this.gains = new Array(this.capacity);
        this.panners = new Array(this.capacity);
        // The AudioParam play() writes per shot: stereo -> .pan, positional -> .positionX.
        // Held separately so the hot path swaps the param SOURCE, never branches on mode.
        this.panTargets = new Array(this.capacity);
        this.sources = new Array(this.capacity).fill(null);

        // Bound once, per pool - not once per play(). Assigning an arrow function
        // to source.onended inside play() would allocate a closure on every shot.
        this._onEnded = this._onEnded.bind(this);

        // Branch ONCE on mode, at cold construction, never in play().
        const positional = mode === 'positional';
        for (let i = 0; i < this.capacity; i++) {
            const gain = this.ctx.createGain();
            let panner, panTarget;
            if (positional) {
                panner = this.ctx.createPanner();
                panner.panningModel = 'equalpower';
                panner.distanceModel = 'inverse';
                panner.refDistance = 1;
                panner.maxDistance = 10000;
                panner.rolloffFactor = 1;
                if (i === 0 && panner.positionX === undefined) {
                    // Fail closed: positional mode needs the positionX/Y/Z AudioParam
                    // interface. A pre-AudioParam PannerNode (or a mock without it) would
                    // silently drop every pan write - null is not zero.
                    throw new TypeError(
                        'AudioPool: positional mode requires a PannerNode with the ' +
                        'positionX/Y/Z AudioParam interface; this context does not provide it.'
                    );
                }
                panTarget = panner.positionX;
            } else {
                panner = this.ctx.createStereoPanner();
                panTarget = panner.pan;
            }
            panner.connect(gain);
            gain.connect(this.output);
            this.gains[i] = gain;
            this.panners[i] = panner;
            this.panTargets[i] = panTarget;
        }
    }

    /**
     * Play a sprite. Returns a generation-stamped handle: ((gen << 8) | channel) >>> 0.
     * Pass the handle to stop() for ABA-safe stopping under voice stealing.
     * @param {string} spriteId
     * @param {number} [volume=1.0]
     * @param {number} [pan=0.0] - clamped to [-1, 1]
     * @param {number} [pitch=1.0] - 2 = octave up
     * @param {AudioBuffer|null} [buffer=null] - optional per-play buffer override
     * @returns {number} packed handle, or -1 if spriteId is unknown
     */
    play(spriteId, volume = 1.0, pan = 0.0, pitch = 1.0, buffer = null) {
        const sprite = this.spriteMap[spriteId];
        if (!sprite) return -1;
        if (pan < -1) pan = -1;
        if (pan > 1) pan = 1;

        // Cache property lookups (avoids repeated `this.` dereferences in hot path)
        const gains = this.gains;
        const panners = this.panners;
        const panTargets = this.panTargets;
        const sources = this.sources;
        const expireTimes = this.expireTimes;
        const generations = this.generations;
        const cap = this.capacity;

        const now = this.ctx.currentTime;
        let bestChannel = -1;
        let oldestTime = Infinity;

        for (let i = 0; i < cap; i++) {
            if (expireTimes[i] <= now) { bestChannel = i; break; }
            if (expireTimes[i] < oldestTime) { oldestTime = expireTimes[i]; bestChannel = i; }
        }

        const gainNode = gains[bestChannel];
        const panParam = panTargets[bestChannel];
        const startTime = now + START_LEAD;

        if (expireTimes[bestChannel] > now) {
            // Steal: fade out the outgoing occupant, then bump gen so its handle goes stale.
            const currentVol = gainNode.gain.value;
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(currentVol, now);
            gainNode.gain.linearRampToValueAtTime(FADE_FLOOR, now + FADE_SECONDS);
            const oldSource = sources[bestChannel];
            if (oldSource) { try { oldSource.stop(startTime); } catch (e) {} }
            generations[bestChannel] = (generations[bestChannel] + 1) & GEN_MASK;
        }

        const source = this.ctx.createBufferSource();
        source.buffer = buffer || this.buffer;
        source.playbackRate.value = pitch;
        source.connect(panners[bestChannel]);
        source.onended = this._onEnded;

        sources[bestChannel] = source;

        gainNode.gain.cancelScheduledValues(startTime);
        gainNode.gain.setValueAtTime(volume, startTime);

        // Pan is scheduled, not assigned. An immediate write would snap the pan of
        // a voice that is still fading out on this channel, which clicks.
        panParam.cancelScheduledValues(startTime);
        panParam.setValueAtTime(pan, startTime);

        const actualDuration = sprite.duration / pitch;
        expireTimes[bestChannel] = startTime + actualDuration;
        source.start(startTime, sprite.start, sprite.duration);

        return ((generations[bestChannel] << CHANNEL_BITS) | bestChannel) >>> 0;
    }

    /**
     * Stop a play by handle. Stale handles (channel stolen or already ended) are silent no-ops.
     * @param {number} handle - packed handle returned by play()
     */
    stop(handle) {
        if (!Number.isInteger(handle) || handle < 0) return;
        const channel = handle & CHANNEL_MASK;
        if (channel >= this.capacity) return;
        if (this.generations[channel] !== (handle >>> CHANNEL_BITS)) return;
        this._stopChannel(channel);
    }

    /**
     * Is this exact play still sounding? False once the channel has been stolen,
     * stopped, or has played out. Same test stop() runs internally, exposed so callers
     * never have to read generations[] and expireTimes[] to answer it themselves.
     * @param {number} handle - packed handle returned by play()
     * @returns {boolean}
     */
    isPlaying(handle) {
        if (!Number.isInteger(handle) || handle < 0) return false;
        const channel = handle & CHANNEL_MASK;
        if (channel >= this.capacity) return false;
        if (this.generations[channel] !== (handle >>> CHANNEL_BITS)) return false;
        return this.expireTimes[channel] > this.ctx.currentTime;
    }

    /**
     * The per-voice spatial node for a live handle, else null. This is the seam
     * lite-audio uses to write 3D position (.positionX/Y/Z on a PannerNode) without
     * reaching into pool internals. Cold, generation-checked, fail-closed: a stolen,
     * stopped, expired, or bogus handle returns null, never a stale node.
     * @param {number} handle - packed handle returned by play()
     * @returns {PannerNode|StereoPannerNode|null}
     */
    voiceNode(handle) {
        if (!Number.isInteger(handle) || handle < 0) return null;
        const channel = handle & CHANNEL_MASK;
        if (channel >= this.capacity) return null;
        if (this.generations[channel] !== (handle >>> CHANNEL_BITS)) return null;
        if (this.expireTimes[channel] <= this.ctx.currentTime) return null;
        return this.panners[channel];
    }

    /**
     * Voices currently sounding. Allocation-free; safe to call every frame.
     * @returns {number} 0..capacity
     */
    activeCount() {
        const expireTimes = this.expireTimes;
        const cap = this.capacity;
        const now = this.ctx.currentTime;
        let n = 0;
        for (let i = 0; i < cap; i++) if (expireTimes[i] > now) n = (n + 1) | 0;
        return n;
    }

    /** Stop all active channels. Handles issued before this call are invalidated. */
    stopAll() { for (let i = 0; i < this.capacity; i++) this._stopChannel(i); }

    /**
     * @private Shared 'ended' handler. Identity scan, not a captured channel index:
     * a stolen source outlives its slot, and only the source still sitting in the
     * array may retire it. O(capacity) on a cold path (once per voice, off-frame).
     */
    _onEnded(event) {
        const sources = this.sources;
        if (!sources) return;                       // pool was destroyed mid-flight
        const source = event.target;
        for (let i = 0; i < this.capacity; i++) {
            if (sources[i] === source) {
                sources[i] = null;
                this.generations[i] = (this.generations[i] + 1) & GEN_MASK;
                return;
            }
        }
    }

    /** @private Bypasses generation check - internal use only. */
    _stopChannel(channel) {
        const now = this.ctx.currentTime;
        if (this.expireTimes[channel] > now) {
            const gainNode = this.gains[channel];
            const source = this.sources[channel];
            const currentVol = gainNode.gain.value;
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(currentVol, now);
            gainNode.gain.linearRampToValueAtTime(FADE_FLOOR, now + FADE_SECONDS);
            if (source) { try { source.stop(now + START_LEAD); } catch (e) {} }
            this.expireTimes[channel] = 0;
            this.sources[channel] = null;
            this.generations[channel] = (this.generations[channel] + 1) & GEN_MASK;
        }
    }

    /** Stop all sounds, tear the voices out of the graph, and release references. */
    destroy() {
        if (!this.ctx) return;                      // idempotent
        this.stopAll();

        // The pool built these nodes, so the pool disconnects them. Without this a
        // rebuilt pool leaves its old gains and panners hanging off the output bus.
        for (let i = 0; i < this.capacity; i++) {
            const source = this.sources[i];
            if (source) { try { source.disconnect(); } catch (e) {} }
            this.panners[i].disconnect();
            this.gains[i].disconnect();
        }

        this.gains = this.panners = this.sources = null;
        this.panTargets = null;                     // holds AudioParam refs
        this.expireTimes = null;
        this.generations = null;
        this.ctx = this.buffer = this.spriteMap = this.output = null;
    }
}

export default AudioPool;
