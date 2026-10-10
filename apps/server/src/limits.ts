import { isIP } from 'node:net';

export const INGRESS_RATE = 90;
export const INGRESS_BURST = 120;
export const INGRESS_STRIKES = 8;

/** TRUST_PROXY requires the server port to be reachable only through the trusted gateway. */
export function socketClientAddress(remote: string, forwarded: string | string[] | undefined, trustProxy: boolean): string {
  if (!trustProxy || !forwarded) return remote;
  // The shipped single Caddy gateway appends/replaces the actual peer at the right edge.
  const address = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',').at(-1)?.trim();
  return address && isIP(address) ? address : remote;
}

export class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  take(key: string, perSecond: number, burst: number, cost = 1, now = Date.now()) {
    const previous = this.buckets.get(key) ?? { tokens: burst, at: now };
    const tokens = Math.min(burst, previous.tokens + Math.max(0, now - previous.at) * perSecond / 1000);
    this.buckets.set(key, { tokens: Math.max(0, tokens - cost), at: now });
    return tokens >= cost;
  }
  sweep(now = Date.now()) { for (const [key, value] of this.buckets) if (now - value.at > 120000) this.buckets.delete(key); }
}
