import { getShardId } from '../src/shard.js';

describe('shard', () => {
  it('returns a number between 1 and 2000', () => {
    for (let i = 0; i < 100; i++) {
      const id = getShardId();
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(2000);
    }
  });

  it('produces a range of values across many calls', () => {
    const values = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      values.add(getShardId());
    }
    // With 1000 random draws from 2000 shards,
    // we expect at least some variety
    expect(values.size).toBeGreaterThan(100);
  });
});
