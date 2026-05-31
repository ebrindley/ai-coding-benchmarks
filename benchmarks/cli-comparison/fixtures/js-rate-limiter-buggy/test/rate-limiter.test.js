const { createRateLimiter } = require('../src/middleware/rate-limiter.js');

function makeReq(ip = '1.2.3.4') {
  return {
    headers: { 'x-forwarded-for': ip },
    ip,
    connection: { remoteAddress: ip },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function runOnce(middleware, { ip = '1.2.3.4' } = {}) {
  const req = makeReq(ip);
  const res = makeRes();
  let calledNext = false;
  middleware(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

describe('rate limiter fixture', () => {
  test('blocks-101st-request', () => {
    const t = 0;
    const limiter = createRateLimiter({ maxRequests: 100, windowMs: 60_000, now: () => t });

    for (let i = 0; i < 100; i++) {
      const { res, calledNext } = runOnce(limiter);
      expect(calledNext).toBe(true);
      expect(res.statusCode).toBe(200);
    }

    const blocked = runOnce(limiter);
    expect(blocked.calledNext).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
  });

  test('window-reset-timing', () => {
    let t = 0;
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000, now: () => t });

    expect(runOnce(limiter).res.statusCode).toBe(200);
    expect(runOnce(limiter).res.statusCode).toBe(200);
    expect(runOnce(limiter).res.statusCode).toBe(429);

    t = 60_000;
    // Should reset exactly at the boundary (this is the seeded bug).
    expect(runOnce(limiter).res.statusCode).toBe(200);
  });

  test('retry-after-header', () => {
    let t = 0;
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => t });

    expect(runOnce(limiter).res.statusCode).toBe(200);

    const blocked = runOnce(limiter);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers['retry-after']).toBe('60');

    t = 59_001;
    const blocked2 = runOnce(limiter);
    expect(blocked2.res.statusCode).toBe(429);
    expect(blocked2.res.headers['retry-after']).toBe('1');
  });

  test('per-ip-isolation', () => {
    const t = 0;
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => t });

    expect(runOnce(limiter, { ip: '1.1.1.1' }).res.statusCode).toBe(200);
    expect(runOnce(limiter, { ip: '1.1.1.1' }).res.statusCode).toBe(429);

    expect(runOnce(limiter, { ip: '2.2.2.2' }).res.statusCode).toBe(200);
    expect(runOnce(limiter, { ip: '2.2.2.2' }).res.statusCode).toBe(429);
  });
});
