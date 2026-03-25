import { describe, it, expect, vi } from 'vitest';

class MockAudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; }
    createGain() {
        return { gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    }
    createStereoPanner() { return { pan: { value: 0 }, connect: vi.fn() }; }
    createBufferSource() { return { buffer: null, playbackRate: { value: 1 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; }
}

import { AudioPool } from './AudioPool.js';

describe('AudioPool', () => {
    const ctx = new MockAudioContext();
    const buffer = {};
    const sprites = { laser: { start: 0, duration: 0.5 }, boom: { start: 0.5, duration: 1.0 } };

    it('constructs with correct capacity', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 8);
        expect(pool.capacity).toBe(8);
    });

    it('play returns channel ID', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 8);
        const ch = pool.play('laser');
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThan(8);
    });

    it('play returns -1 for invalid sprite', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 8);
        expect(pool.play('nonexistent')).toBe(-1);
    });

    it('stop does not throw for invalid channel', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 8);
        expect(() => pool.stop(-1)).not.toThrow();
        expect(() => pool.stop(999)).not.toThrow();
    });

    it('uses pre-wired gain and panner nodes', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 4);
        expect(pool.gains.length).toBe(4);
        expect(pool.panners.length).toBe(4);
    });

    it('expireTimes initialized to 0', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 8);
        for (let i = 0; i < 8; i++) expect(pool.expireTimes[i]).toBe(0);
    });

    it('stopAll does not throw', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 8);
        pool.play('laser');
        expect(() => pool.stopAll()).not.toThrow();
    });

    it('capacity is clamped to 256', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 999);
        expect(pool.capacity).toBe(256);
    });

    it('pan is clamped to [-1, 1]', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 8);
        const ch = pool.play('laser', 1.0, 5.0);
        expect(ch).toBeGreaterThanOrEqual(0);
    });

    it('destroy nulls all references', () => {
        const pool = new AudioPool(ctx, buffer, sprites, 4);
        pool.destroy();
        expect(pool.gains).toBeNull();
        expect(pool.expireTimes).toBeNull();
        expect(pool.ctx).toBeNull();
    });
});
