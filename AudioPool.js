/** @zakkster/lite-audio-pool — Zero-GC Web Audio Sound Sprite Pool */

export class AudioPool {
    /**
     * @param {AudioContext} audioContext
     * @param {AudioBuffer} audioBuffer - The single decoded sprite file
     * @param {Object} spriteMap - e.g., { "laser": { start: 0, duration: 0.5 } }
     * @param {number} capacity - Max concurrent voices (clamped to 256)
     */
    constructor(audioContext, audioBuffer, spriteMap, capacity = 32) {
        this.ctx = audioContext;
        this.buffer = audioBuffer;
        this.spriteMap = spriteMap;
        this.capacity = Math.min(capacity, 256);

        this.expireTimes = new Float32Array(this.capacity).fill(0);

        this.gains = new Array(this.capacity);
        this.panners = new Array(this.capacity);
        this.sources = new Array(this.capacity).fill(null);

        for (let i = 0; i < this.capacity; i++) {
            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();
            panner.connect(gain);
            gain.connect(this.ctx.destination);
            this.gains[i] = gain;
            this.panners[i] = panner;
        }
    }

    play(spriteId, volume = 1.0, pan = 0.0, pitch = 1.0) {
        const sprite = this.spriteMap[spriteId];
        if (!sprite) return -1;
        if (pan < -1) pan = -1;
        if (pan > 1) pan = 1;

        // Cache property lookups (avoids repeated `this.` dereferences in hot path)
        const gains = this.gains;
        const panners = this.panners;
        const sources = this.sources;
        const expireTimes = this.expireTimes;
        const cap = this.capacity;

        const now = this.ctx.currentTime;
        let bestChannel = -1;
        let oldestTime = Infinity;

        for (let i = 0; i < cap; i++) {
            if (expireTimes[i] <= now) { bestChannel = i; break; }
            if (expireTimes[i] < oldestTime) { oldestTime = expireTimes[i]; bestChannel = i; }
        }

        const gainNode = gains[bestChannel];

        if (expireTimes[bestChannel] > now) {
            const currentVol = gainNode.gain.value;
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(currentVol, now);
            gainNode.gain.linearRampToValueAtTime(0.0001, now + 0.02);
            const oldSource = sources[bestChannel];
            if (oldSource) { try { oldSource.stop(now + 0.025); } catch (e) {} }
        }

        const source = this.ctx.createBufferSource();
        source.buffer = this.buffer;
        source.playbackRate.value = pitch;
        source.connect(panners[bestChannel]);

        const ch = bestChannel;
        source.onended = () => { sources[ch] = null; };

        sources[bestChannel] = source;

        const startTime = now + 0.025;
        gainNode.gain.cancelScheduledValues(startTime);
        gainNode.gain.setValueAtTime(volume, startTime);
        panners[bestChannel].pan.value = pan;

        const actualDuration = sprite.duration / pitch;
        expireTimes[bestChannel] = startTime + actualDuration;
        source.start(startTime, sprite.start, sprite.duration);

        return bestChannel;
    }

    stop(channelId) {
        if (channelId < 0 || channelId >= this.capacity) return;
        const now = this.ctx.currentTime;
        if (this.expireTimes[channelId] > now) {
            const gainNode = this.gains[channelId];
            const source = this.sources[channelId];
            const currentVol = gainNode.gain.value;
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(currentVol, now);
            gainNode.gain.linearRampToValueAtTime(0.0001, now + 0.02);
            if (source) { try { source.stop(now + 0.025); } catch (e) {} }
            this.expireTimes[channelId] = 0;
        }
    }

    stopAll() { for (let i = 0; i < this.capacity; i++) this.stop(i); }
}

export default AudioPool;