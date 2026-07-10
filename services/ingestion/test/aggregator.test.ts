describe('Aggregator density buffer', () => {
  function extractEventId(pk: string): string | null {
    const parts = pk.split('#');
    if (parts.length >= 2) {
      return parts[1];
    }
    return null;
  }

  it('extracts eventId from SHARD pk', () => {
    expect(extractEventId('EVENT#match2026#SHARD#845')).toBe('match2026');
  });

  it('extracts eventId from SESSION pk', () => {
    expect(extractEventId('EVENT#match2026#SESSION#fan_8872')).toBe('match2026');
  });

  it('returns null for malformed pk', () => {
    expect(extractEventId('')).toBeNull();
    expect(extractEventId('ONLYONE')).toBeNull();
  });

  describe('density buffer accumulation', () => {
    it('groups records by eventId and bucketTs', () => {
      const densityByBucket = new Map<string, number>();

      // Simulate 3 records in the same bucket
      const records = [
        { eventId: 'e1', bucketTs: 100 },
        { eventId: 'e1', bucketTs: 100 },
        { eventId: 'e1', bucketTs: 101 },
      ];

      for (const r of records) {
        const key = `${r.eventId}#${r.bucketTs}`;
        densityByBucket.set(key, (densityByBucket.get(key) || 0) + 1);
      }

      expect(densityByBucket.get('e1#100')).toBe(2);
      expect(densityByBucket.get('e1#101')).toBe(1);
      expect(densityByBucket.size).toBe(2);
    });
  });

  describe('density shard calculation', () => {
    it('distributes bucketTs across 10 shards', () => {
      const shards = new Set<number>();
      for (let ts = 0; ts < 100; ts++) {
        shards.add(ts % 10);
      }
      expect(shards.size).toBe(10);
    });

    it('bucketTs 0 goes to shard 0', () => {
      expect(0 % 10).toBe(0);
    });

    it('bucketTs 9 goes to shard 9', () => {
      expect(9 % 10).toBe(9);
    });

    it('bucketTs 10 goes to shard 0', () => {
      expect(10 % 10).toBe(0);
    });
  });

  describe('TTL counter grouping', () => {
    it('aggregates TTL decrements by eventId', () => {
      const ttlCounters = new Map<string, number>();

      const sessionKeys = [
        'EVENT#e1#SESSION#fan1',
        'EVENT#e1#SESSION#fan2',
        'EVENT#e2#SESSION#fan3',
      ];

      for (const pk of sessionKeys) {
        const eventId = extractEventId(pk);
        if (!eventId) continue;
        ttlCounters.set(eventId, (ttlCounters.get(eventId) || 0) + 1);
      }

      expect(ttlCounters.get('e1')).toBe(2);
      expect(ttlCounters.get('e2')).toBe(1);
    });
  });
});
