export class AudioPool {
    readonly capacity: number;

    /**
     * @throws {TypeError} if audioContext or spriteMap is missing, or any sprite
     *   entry lacks a finite `start >= 0` and `duration > 0`.
     * @throws {RangeError} if capacity is not an integer in [1, 256]. The
     *   channel index is packed into 8 bits of the returned handle, so 256 is
     *   the last slot the mask can address.
     */
    constructor(
        audioContext: AudioContext,
        audioBuffer: AudioBuffer,
        spriteMap: Record<string, { start: number; duration: number }>,
        capacity?: number,
        output?: AudioNode | null
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
