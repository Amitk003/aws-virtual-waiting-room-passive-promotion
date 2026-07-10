import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.CLOUDFRONT_URL || 'http://localhost:3000';
const EVENT_ID = __ENV.EVENT_ID || 'test-event';
const VUs = parseInt(__ENV.VUS || '50');
const DURATION = __ENV.DURATION || '30s';

export const options = {
  stages: [
    { duration: '10s', target: VUs },
    { duration: DURATION, target: VUs },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

// Shared token: all VUs use the same token to verify CDN caching behavior
let sharedToken = '';
let sharedEntryTimestamp = 0;

export function setup() {
  const fanId = `loadtest-fan-${Date.now()}`;
  const res = http.post(`${BASE_URL}/api/v1/event/${EVENT_ID}/join`, JSON.stringify({ fanId }), {
    headers: { 'content-type': 'application/json' },
  });

  check(res, {
    'join succeeded': (r) => r.status === 200,
    'join has token': (r) => {
      const body = r.json();
      return body.token !== undefined;
    },
  });

  const body = res.json();
  return { token: body.token, entryTimestamp: body.entryTimestamp };
}

export default function (data) {
  const res = http.get(`${BASE_URL}/api/v1/event/${EVENT_ID}/status`);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response has global state': (r) => {
      try {
        const body = r.json();
        return body.admittedUntilTimestamp !== undefined && body.densityBuckets !== undefined;
      } catch {
        return false;
      }
    },
    'no auth header needed': (r) => r.request.headers['Authorization'] === undefined,
    'fast response': (r) => r.timings.duration < 500,
  });

  sleep(1);
}
