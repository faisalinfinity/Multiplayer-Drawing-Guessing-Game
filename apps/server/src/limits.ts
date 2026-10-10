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
