import { getShardId } from '../src/shard';

function validateFanId(fanId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(fanId);
}

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

describe('validateFanId', () => {
  it('accepts alphanumeric fanId', () => {
    expect(validateFanId('fan_12345')).toBe(true);
  });

  it('accepts hyphens', () => {
    expect(validateFanId('test-user-123')).toBe(true);
  });

  it('rejects fanId with #', () => {
    expect(validateFanId('fan#123')).toBe(false);
  });

  it('rejects fanId with spaces', () => {
    expect(validateFanId('test user')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateFanId('')).toBe(false);
  });

  it('rejects fanId over 64 chars', () => {
    expect(validateFanId('a'.repeat(65))).toBe(false);
  });

  it('accepts fanId at 64 char limit', () => {
    expect(validateFanId('a'.repeat(64))).toBe(true);
  });
});
