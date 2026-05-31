/**
 * Rate Limiter Middleware (fixture)
 *
 * Implements a per-IP fixed-window limiter:
 * - maxRequests per windowMs
 * - dependency-injected clock via options.now (required by task)
 *
 * Seeded bug:
 * - shouldReset() uses `>` instead of `>=`, so the window resets at 60001ms.
 */

function getClientIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim().length > 0) {
    return xff.split(',')[0].trim();
  }
  return req?.ip || req?.connection?.remoteAddress || 'unknown';
}

function createRateLimiter(options = {}) {
  const maxRequests = options.maxRequests ?? 100;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;

  /** @type {Map<string, { windowStart: number; count: number }>} */
  const stateByIp = new Map();

  function shouldReset(windowStart, currentTime) {
    // BUG: Should be >= so the window resets at exactly 60000ms.
    return currentTime - windowStart > windowMs;
  }

  function getOrInit(ip, currentTime) {
    const existing = stateByIp.get(ip);
    if (!existing) {
      const initial = { windowStart: currentTime, count: 0 };
      stateByIp.set(ip, initial);
      return initial;
    }
    if (shouldReset(existing.windowStart, currentTime)) {
      existing.windowStart = currentTime;
      existing.count = 0;
    }
    return existing;
  }

  function secondsUntilReset(windowStart, currentTime) {
    const msUntilReset = windowMs - (currentTime - windowStart);
    return Math.max(0, Math.ceil(msUntilReset / 1000));
  }

  return function rateLimiter(req, res, next) {
    const currentTime = now();
    const ip = getClientIp(req);
    const state = getOrInit(ip, currentTime);

    if (state.count >= maxRequests) {
      const retryAfter = secondsUntilReset(state.windowStart, currentTime);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfterSeconds: retryAfter,
      });
      return;
    }

    state.count += 1;
    next();
  };
}

module.exports = { createRateLimiter };
