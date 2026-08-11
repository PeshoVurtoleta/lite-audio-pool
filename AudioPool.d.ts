export class AudioPool {
    readonly capacity: number;

    /**
     * @throws {TypeError} if audioContext or spriteMap is missing, any sprite
     *   entry lacks a finite `start >= 0` and `duration > 0`, or positional
     *   mode is requested against a `PannerNode` without the `positionX`
     *   AudioParam interface.
     * @throws {RangeError} if capacity is not an integer in [1, 256] (the
     *   channel index is packed into 8 bits of the returned handle, so 256 is
     *   the last slot the mask can address), or `options.panner` is not
     *   `'stereo'` or `'positional'`.
     */
    constructor(
        audioContext: AudioContext,
        audioBuffer: AudioBuffer,
        spriteMap: Record<string, { start: number; duration: number }>,
        capacity?: number,
        output?: AudioNode | null,
        options?: { panner?: 'stereo' | 'positional' }
    );

    /**
     * Play a sprite. Returns a packed handle: `((generation << 8) | channel) >>> 0`.
     * Pass the handle to `stop()` for ABA-safe stopping. Returns `-1` if
     * `spriteId` is unknown.
     */
    play(
        spriteId: string,
        volume?: number,
        pan?: number,
        pitch?: number,
        buffer?: AudioBuffer | null
    ): number;

    /**
     * Stop a play by its handle. Stale handles (channel stolen or already
     * ended) are silent no-ops.
     */
    stop(handle: number): void;

    /**
     * Is this exact play still sounding? Returns `false` once the channel has
     * been stolen, stopped, or has played out. Same test `stop()` runs
     * internally.
     */
    isPlaying(handle: number): boolean;

    /**
     * The per-voice spatial node for a live handle, else `null`. In
     * `'positional'` mode this is a `PannerNode` (write `.positionX/Y/Z` on it
     * to set full 3D position); in `'stereo'` mode a `StereoPannerNode`.
     * Generation-checked and fail-closed: a stolen, stopped, expired, or bogus
     * handle returns `null`, never a stale node.
     */
    voiceNode(handle: number): PannerNode | StereoPannerNode | null;

    /**
     * Voices currently sounding. Allocation-free; safe to call every frame.
     */
    activeCount(): number;

    /** Stop all active channels. Handles issued before this call are invalidated. */
    stopAll(): void;

    /**
     * Stop all sounds, disconnect every node this pool built, and release
     * references. Idempotent.
     */
    destroy(): void;
}
export default AudioPool;
