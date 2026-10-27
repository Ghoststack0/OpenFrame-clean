import { describe, expect, it } from 'vitest';
import { AdaptiveUploadConcurrency } from './adaptive-upload-concurrency';

describe(AdaptiveUploadConcurrency.name, () => {
  it('starts at two and raises concurrency only after a measured sampling window', () => {
    const controller = new AdaptiveUploadConcurrency();
    expect(controller.concurrency).toBe(2);
    expect(controller.record(100, 0)).toBe(2);
    expect(controller.record(100, 1000)).toBe(2);
    expect(controller.record(100, 3000)).toBe(3);
    expect(controller.record(300, 6000)).toBe(3);
    expect(controller.record(600, 9000)).toBe(4);
    expect(controller.record(100, 12_000)).toBe(3);
  });

  it('halves on errors, stays within bounds and can recover', () => {
    const controller = new AdaptiveUploadConcurrency();
    controller.record(1, 0);
    for (let i = 1; i < 10; i++) {
      controller.record(10 ** i, i * 3000);
    }
    expect(controller.concurrency).toBe(6);
    expect(controller.error()).toBe(3);
    expect(controller.error()).toBe(1);
    expect(controller.error()).toBe(1);
    controller.record(10, 30_000);
    expect(controller.record(10, 33_000)).toBe(2);
  });
});
