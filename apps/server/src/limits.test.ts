import { expect, it } from 'vitest';
import { TokenBuckets } from './limits.js';
it('limits bursts, refills with time and isolates identities', () => {
  const buckets = new TokenBuckets();
  expect(buckets.take('a', 2, 2, 1, 1000)).toBe(true);
  expect(buckets.take('a', 2, 2, 1, 1000)).toBe(true);
  expect(buckets.take('a', 2, 2, 1, 1000)).toBe(false);
  expect(buckets.take('b', 2, 2, 1, 1000)).toBe(true);
  expect(buckets.take('a', 2, 2, 1, 1500)).toBe(true);
});
