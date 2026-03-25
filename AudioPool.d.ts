export class AudioPool {
    readonly capacity: number;
    constructor(audioContext: AudioContext, audioBuffer: AudioBuffer, spriteMap: Record<string, { start: number; duration: number }>, capacity?: number);
    play(spriteId: string, volume?: number, pan?: number, pitch?: number): number;
    stop(channelId: number): void;
    stopAll(): void;
    destroy(): void;
}
export default AudioPool;
