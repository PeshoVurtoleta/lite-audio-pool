// Package version, in lockstep with package.json + llms.txt (three-place sync).
export const VERSION: string;

export class AudioPool {
    readonly capacity: number;

    /**
     * @throws {TypeError} if audioContext or spriteMap is missing, any sprite
     *   entry lacks a finite `start >= 0` and `duration > 0`, positional mode
     *   is requested against a `PannerNode` without the `positionX` AudioParam
     *   interface, or `'discrete'` mode is requested against a context lacking
     *   `createChannelMerger` / `createBiquadFilter`.
     * @throws {RangeError} if capacity is not an integer in [1, 256] (the
     *   channel index is packed into 8 bits of the returned handle, so 256 is
     *   the last slot the mask can address); `options.panner` is not
     *   `'stereo'`, `'positional'`, or `'discrete'`; `'discrete'` mode lacks a
     *   `channels` value in `{4, 6, 8}`; or `channels` is passed with a
     *   non-discrete panner mode.
     */
    constructor(
        audioContext: AudioContext,
        audioBuffer: AudioBuffer,
        spriteMap: Record<string, { start: number; duration: number }>,
        capacity?: number,
        output?: AudioNode | null,
        options?: { panner?: 'stereo' | 'positional' | 'discrete'; channels?: 4 | 6 | 8 }
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
     * to set full 3D position); in `'stereo'` mode a `StereoPannerNode`; in
     * `'discrete'` mode the per-voice array of lane `GainNode`s (write
     * `.gain.value` on lane `k` to place the voice; the array is pre-allocated,
     * so the call allocates nothing). Generation-checked and fail-closed: a
     * stolen, stopped, expired, or bogus handle returns `null`, never a stale
     * node.
     */
    voiceNode(handle: number): PannerNode | StereoPannerNode | GainNode[] | null;

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
