import { describe, expect, it } from 'vitest';
import { MAX_PHOTO_BYTES } from '@/lib/photos/image';
import { uploadDeadlineMs } from '@/lib/field/photo-queue';

describe('how long one photo upload may take', () => {
  const secondsAt = (megabitsPerSecond: number, bytes: number) => (bytes * 8) / (megabitsPerSecond * 1_000_000);

  it('lets a full-size original finish on a 1 Mbit/s connection, with time left for the answer', () => {
    const bytes = 8 * 1024 * 1024;
    expect(uploadDeadlineMs(bytes) / 1_000).toBeGreaterThan(secondsAt(1, bytes) + 30);
    expect(uploadDeadlineMs(MAX_PHOTO_BYTES) / 1_000).toBeGreaterThan(secondsAt(1, MAX_PHOTO_BYTES));
  });

  it('keeps a short wait for a small photo and grows with the size', () => {
    expect(uploadDeadlineMs(0)).toBe(30_000);
    expect(uploadDeadlineMs(200 * 1024)).toBeLessThan(uploadDeadlineMs(8 * 1024 * 1024));
  });
});
