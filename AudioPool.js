/** @zakkster/lite-audio-pool - Zero-GC Web Audio Sound Sprite Pool */

// Package version, in lockstep with package.json + llms.txt (three-place sync).
export const VERSION = '1.3.0';

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
     * @param {'stereo'|'positional'|'discrete'} [options.panner='stereo'] - Per-voice pan
     *   node. 'stereo' uses StereoPannerNode (pan -> .pan). 'positional' uses PannerNode
     *   (pan -> .positionX): listener at origin facing -Z, so +X is right; distanceModel
     *   'inverse' with refDistance 1 keeps every source at distance <= 1 (the whole pan
     *   range, y=z=0) at gain exactly 1 - zero distance attenuation, loudness stays owned
     *   by the gain node. Full 3D is set later via voiceNode(). 'discrete' routes each
     *   voice through N pre-allocated GainNode lanes into a shared ChannelMerger(N); the
     *   `pan` arg is INERT in discrete mode (it lands on a detached per-pool sink). Set
     *   per-lane gains via voiceNode() (returns the lane array). Default is byte-identical
     *   to prior releases.
     * @param {4|6|8} [options.channels] - REQUIRED and only valid when panner is 'discrete':
     *   the discrete channel count. 4 = L,R,C,LFE; 6 = L,R,C,LFE,SL,SR; 8 adds SBL,SBR.
     * @throws {RangeError} if capacity does not fit the handle's channel field; panner mode
     *   is not 'stereo'|'positional'|'discrete'; discrete mode lacks a channels value in
     *   {4,6,8}; or channels is passed with a non-discrete panner mode
     * @throws {TypeError} if a sprite entry is malformed; positional mode is requested
     *   against a context whose PannerNode lacks the positionX AudioParam interface; or
     *   discrete mode is requested against a context lacking createChannelMerger /
     *   createBiquadFilter
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
        if (mode !== 'stereo' && mode !== 'positional' && mode !== 'discrete') {
            throw new RangeError(
                'AudioPool: options.panner must be "stereo", "positional", or "discrete", got "' +
                mode + '".'
            );
        }
        const discrete = mode === 'discrete';
        const channels = options.channels;
        if (discrete) {
            if (channels !== 4 && channels !== 6 && channels !== 8) {
                throw new RangeError(
                    'AudioPool: discrete mode requires options.channels in {4, 6, 8}, got ' +
                    channels + '.'
                );
            }
            // Fail closed: discrete topology needs a ChannelMerger and a BiquadFilter.
            // A context (or mock) lacking either would silently drop the surround graph -
            // null is not zero.
            if (typeof audioContext.createChannelMerger !== 'function' ||
                typeof audioContext.createBiquadFilter !== 'function') {
                throw new TypeError(
                    'AudioPool: discrete mode requires a context with createChannelMerger and ' +
                    'createBiquadFilter; this context does not provide them.'
                );
            }
        } else if (channels !== undefined) {
            throw new RangeError(
                'AudioPool: options.channels is only valid with panner "discrete", got it with ' +
                'panner "' + mode + '".'
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
        // The AudioParam play() writes per shot: stereo -> .pan, positional -> .positionX,
        // discrete -> a single detached per-pool sink (pan is inert in discrete mode).
        // Held separately so the hot path swaps the param SOURCE, never branches on mode.
        this.panTargets = new Array(this.capacity);
        // The node play() connects the fresh source to, pre-resolved per mode: stereo/
        // positional -> the per-voice panner (byte-identical to prior releases); discrete
        // -> the per-voice gain (the fade+volume node that fans out to the surround lanes).
        this.voiceInputs = new Array(this.capacity);
        this.sources = new Array(this.capacity).fill(null);

        // Discrete-only surround topology. Null in stereo/positional; built cold below.
        this.channels = discrete ? channels : 0;
        this.merger = null;          // shared ChannelMerger(N) -> output
        this.lowpass = null;         // shared lowpass band-limiting the LFE lane
        this._panSink = null;        // detached GainNode; the inert pan write lands here
        this.voiceLanes = null;      // per-voice Array(N) of lane GainNodes

        // Bound once, per pool - not once per play(). Assigning an arrow function
        // to source.onended inside play() would allocate a closure on every shot.
        this._onEnded = this._onEnded.bind(this);

        // Branch ONCE on mode, at cold construction, never in play().
        const positional = mode === 'positional';
        if (discrete) {
            // One merger, one lowpass, one detached pan sink per pool. The lowpass connects
            // exactly once into merger input 3 (the LFE lane); every voice's lane-3 gain
            // feeds this shared lowpass, so LFE is summed and band-limited pool-wide.
            this.merger = this.ctx.createChannelMerger(channels);
            this.lowpass = this.ctx.createBiquadFilter();
            this.lowpass.type = 'lowpass';
            this._panSink = this.ctx.createGain();
            this.voiceLanes = new Array(this.capacity);
            this.merger.connect(this.output);
            this.lowpass.connect(this.merger, 0, 3);
        }
        for (let i = 0; i < this.capacity; i++) {
            const gain = this.ctx.createGain();
            this.gains[i] = gain;
            if (discrete) {
                // source -> gain (fade+volume) -> lane[k] -> merger input k, except lane 3
                // which routes through the shared lowpass into merger input 3. L,R default
                // audible (0.7071); every other lane, including LFE, defaults silent (0.0),
                // so an unpositioned voice plays front-stereo, never dead.
                const lanes = new Array(channels);
                for (let k = 0; k < channels; k++) {
                    const lane = this.ctx.createGain();
                    lane.gain.value = (k === 0 || k === 1) ? 0.7071 : 0.0;
                    gain.connect(lane);
                    if (k === 3) lane.connect(this.lowpass);
                    else lane.connect(this.merger, 0, k);
                    lanes[k] = lane;
                }
                this.voiceLanes[i] = lanes;
                this.panners[i] = null;
                this.panTargets[i] = this._panSink.gain;
                this.voiceInputs[i] = gain;
                continue;
            }
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
            this.panners[i] = panner;
            this.panTargets[i] = panTarget;
            this.voiceInputs[i] = panner;
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
        const voiceInputs = this.voiceInputs;
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
        source.connect(voiceInputs[bestChannel]);
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
     * In 'discrete' mode this returns the per-voice Array(N) of lane GainNodes (write
     * `.gain.value` on a lane to place the voice); the array is pre-allocated at
     * construction, so the call itself allocates nothing.
     * @param {number} handle - packed handle returned by play()
     * @returns {PannerNode|StereoPannerNode|GainNode[]|null}
     */
    voiceNode(handle) {
        if (!Number.isInteger(handle) || handle < 0) return null;
        const channel = handle & CHANNEL_MASK;
        if (channel >= this.capacity) return null;
        if (this.generations[channel] !== (handle >>> CHANNEL_BITS)) return null;
        if (this.expireTimes[channel] <= this.ctx.currentTime) return null;
        return this.voiceLanes ? this.voiceLanes[channel] : this.panners[channel];
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
        // rebuilt pool leaves its old gains, panners, and surround lanes hanging off the
        // output bus. Null-safe: discrete voices have no panner (panners[i] === null).
        for (let i = 0; i < this.capacity; i++) {
            const source = this.sources[i];
            if (source) { try { source.disconnect(); } catch (e) {} }
            if (this.panners[i]) this.panners[i].disconnect();
            if (this.voiceLanes) {
                const lanes = this.voiceLanes[i];
                for (let k = 0; k < lanes.length; k++) lanes[k].disconnect();
            }
            this.gains[i].disconnect();
        }
        // Shared discrete nodes: one each per pool, disconnected once.
        if (this.merger) this.merger.disconnect();
        if (this.lowpass) this.lowpass.disconnect();
        if (this._panSink) this._panSink.disconnect();

        this.gains = this.panners = this.sources = null;
        this.panTargets = null;                     // holds AudioParam refs
        this.voiceInputs = null;
        this.voiceLanes = null;
        this.merger = null;
        this.lowpass = null;
        this._panSink = null;
        this.expireTimes = null;
        this.generations = null;
        this.ctx = this.buffer = this.spriteMap = this.output = null;
    }
}

export default AudioPool;
