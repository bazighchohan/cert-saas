import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Serverless-safe distributed sliding-window rate limiter backed by
 * Upstash Redis (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)
 * or Vercel KV (`KV_REST_API_URL` + `KV_REST_API_TOKEN`).
 *
 * Falls back to an in-memory sliding-window map ONLY when Redis/KV credentials
 * are absent (e.g. local offline dev or unit tests), logging a one-time warning
 * in production.
 */

let redisClient: Redis | null | undefined;
let warnedMissingRedis = false;
const upstashLimiterCache = new Map<string, Ratelimit>();

function getDistributedRedis(): Redis | null {
  if (redisClient !== undefined) {
    return redisClient;
  }

  const url =
    process.env.UPSTASH_REDIS_REST_URL?.trim() ||
    process.env.KV_REST_API_URL?.trim();
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ||
    process.env.KV_REST_API_TOKEN?.trim();

  if (url && token) {
    redisClient = new Redis({ url, token });
    return redisClient;
  }

  if (process.env.NODE_ENV === "production" && !warnedMissingRedis) {
    warnedMissingRedis = true;
    console.warn(
      "[rate-limit] UPSTASH_REDIS_REST_URL / KV_REST_API_URL not set; falling back to per-instance memory limiter.",
    );
  }

  redisClient = null;
  return null;
}

function getUpstashLimiter(limit: number, windowMs: number): Ratelimit | null {
  const redis = getDistributedRedis();
  if (!redis) return null;

  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  const cacheKey = `${limit}:${windowSec}`;
  let limiter = upstashLimiterCache.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
      prefix: "cert-saas:rl",
      analytics: false,
    });
    upstashLimiterCache.set(cacheKey, limiter);
  }
  return limiter;
}

// Local fallback store for offline development & automated tests
const memoryHits = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimitInMemory(
  key: string,
  limit: number,
  windowMs: number,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - windowMs;

  if (now - lastSweep > windowMs) {
    for (const [k, ts] of memoryHits) {
      if (ts.length === 0 || ts[ts.length - 1]! <= cutoff) {
        memoryHits.delete(k);
      }
    }
    lastSweep = now;
  }

  const recent = (memoryHits.get(key) ?? []).filter((t) => t > cutoff);
  if (recent.length >= limit) {
    memoryHits.set(key, recent);
    return {
      ok: false,
      retryAfterSec: Math.max(
        1,
        Math.ceil((recent[0]! + windowMs - now) / 1000),
      ),
    };
  }

  recent.push(now);
  memoryHits.set(key, recent);
  return { ok: true };
}

/**
 * Primary async rate-limit check used across Route Handlers and Server Actions.
 * Uses Upstash Redis / Vercel KV when configured, with resilient fallback on
 * transient Redis network errors so an outage doesn't take down certificate downloads.
 */
export async function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const upstash = getUpstashLimiter(limit, windowMs);
  if (upstash) {
    try {
      const res = await upstash.limit(key);
      if (res.success) {
        return { ok: true };
      }
      const retryAfterSec = Math.max(
        1,
        Math.ceil((res.reset - Date.now()) / 1000),
      );
      return { ok: false, retryAfterSec };
    } catch (err) {
      console.error("[rate-limit] Upstash Redis error, using fallback:", err);
    }
  }

  return rateLimitInMemory(key, limit, windowMs);
}

/**
 * Backwards-compatible synchronous wrapper for local/in-memory callers.
 */
export const rateLimit = rateLimitInMemory;

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export function clientIpFromHeaders(headersList: {
  get(name: string): string | null;
}): string {
  const fwd = headersList.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || "unknown";
  return headersList.get("x-real-ip")?.trim() || "unknown";
}
