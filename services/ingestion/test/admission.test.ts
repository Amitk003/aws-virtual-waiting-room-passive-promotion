function hashCodeFanId(fanId: string): number {
  let hash = 0;
  for (let i = 0; i < fanId.length; i++) {
    const char = fanId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function isAdmitted(
  entryTimestamp: number,
  admittedUntilTimestamp: number,
  fanId: string,
  tieBreakerThreshold: number
): boolean {
  const entrySec = Math.floor(entryTimestamp / 1000);
  const admittedSec = Math.floor(admittedUntilTimestamp / 1000);
  if (entrySec < admittedSec) return true;
  if (entrySec === admittedSec) {
    return hashCodeFanId(fanId) % 100 < tieBreakerThreshold;
  }
  return false;
}

function calculateQueuePosition(
  densityBuckets: Array<{ bucketTs: number; count: number }>,
  entryTimestamp: number
): number {
  let position = 0;
  const entrySec = Math.floor(entryTimestamp / 1000);
  for (const bucket of densityBuckets) {
    if (bucket.bucketTs < entrySec) {
      position += bucket.count;
    } else {
      break;
    }
  }
  return position;
}

function estimateWaitSeconds(
  queuePosition: number,
  activePurchaserCount: number,
  completionRateFactor: number = 0.01
): number | null {
  if (queuePosition <= 0) return 0;
  const completionRatePerSec = Math.max(activePurchaserCount * completionRateFactor, 1);
  return Math.ceil(queuePosition / completionRatePerSec);
}

function validateFanId(fanId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(fanId);
}

describe('hashCodeFanId', () => {
  it('returns a consistent hash for the same fanId', () => {
    const hash1 = hashCodeFanId('fan_12345');
    const hash2 = hashCodeFanId('fan_12345');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different fanIds', () => {
    const hash1 = hashCodeFanId('fan_12345');
    const hash2 = hashCodeFanId('fan_99999');
    expect(hash1).not.toBe(hash2);
  });

  it('returns a non-negative number', () => {
    const hash = hashCodeFanId('fan_12345');
    expect(hash).toBeGreaterThanOrEqual(0);
  });
});

describe('isAdmitted', () => {
  const fanId = 'fan_12345';

  it('admits when entryTimestamp is before watermark (different seconds)', () => {
    expect(isAdmitted(1000, 2000, fanId, 100)).toBe(true);
  });

  it('rejects when entryTimestamp is after watermark', () => {
    expect(isAdmitted(5000, 2000, fanId, 100)).toBe(false);
  });

  it('admits when both timestamps are in the same second and hash passes threshold', () => {
    // entry 1500ms and watermark 1800ms are both in second 1
    const hash = hashCodeFanId(fanId) % 100;
    expect(isAdmitted(1500, 1800, fanId, hash + 1)).toBe(true);
  });

  it('rejects when both timestamps are in the same second and hash fails threshold', () => {
    const hash = hashCodeFanId(fanId) % 100;
    expect(isAdmitted(1500, 1800, fanId, hash)).toBe(false);
  });

  it('admits everyone when threshold is 100', () => {
    expect(isAdmitted(1500, 1800, fanId, 100)).toBe(true);
  });

  it('rejects everyone when threshold is 0', () => {
    expect(isAdmitted(1500, 1800, fanId, 0)).toBe(false);
  });

  it('compares at second granularity (entry 1999ms, watermark 1000ms — same second)', () => {
    expect(isAdmitted(1999, 1000, fanId, 100)).toBe(true);
  });

  it('compares at second granularity (entry 0ms, watermark 999ms — different seconds)', () => {
    expect(isAdmitted(0, 999, fanId, 100)).toBe(true);
  });

  it('compares at second granularity (entry 1000ms, watermark 999ms — different seconds)', () => {
    expect(isAdmitted(1000, 999, fanId, 100)).toBe(false);
  });
});

describe('calculateQueuePosition', () => {
  const buckets = [
    { bucketTs: 100, count: 500 },
    { bucketTs: 101, count: 300 },
    { bucketTs: 102, count: 200 },
  ];

  it('returns 0 when entry is before all buckets', () => {
    expect(calculateQueuePosition(buckets, 50 * 1000)).toBe(0);
  });

  it('sums all buckets before entry timestamp', () => {
    // entrySec=101, only bucketTs < 101 qualifies (bucket 100)
    expect(calculateQueuePosition(buckets, 101500)).toBe(500);
  });

  it('returns 0 when entry is in the same second as the first bucket', () => {
    // entrySec=100, no bucketTs < 100
    expect(calculateQueuePosition(buckets, 100500)).toBe(0);
  });

  it('returns all when entry is after all buckets', () => {
    expect(calculateQueuePosition(buckets, 200 * 1000)).toBe(1000);
  });

  it('returns 0 for empty buckets', () => {
    expect(calculateQueuePosition([], 100 * 1000)).toBe(0);
  });
});

describe('estimateWaitSeconds', () => {
  it('returns 0 when queue position is 0', () => {
    expect(estimateWaitSeconds(0, 500, 0.01)).toBe(0);
  });

  it('returns 0 when queue position is negative', () => {
    expect(estimateWaitSeconds(-5, 500, 0.01)).toBe(0);
  });

  it('calculates correctly with default completion rate', () => {
    // completionRatePerSec = max(500 * 0.01, 1) = 5 → ceil(1000/5) = 200
    expect(estimateWaitSeconds(1000, 500, 0.01)).toBe(200);
  });

  it('calculates correctly with custom completion rate', () => {
    // 100 positions / (100 * 0.05) = 5 per sec → ceil(100/5) = 20s
    expect(estimateWaitSeconds(100, 100, 0.05)).toBe(20);
  });

  it('falls back to 1 completion per second when product is 0', () => {
    expect(estimateWaitSeconds(10, 0, 0.01)).toBe(10);
    expect(estimateWaitSeconds(10, 0, 0)).toBe(10);
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
