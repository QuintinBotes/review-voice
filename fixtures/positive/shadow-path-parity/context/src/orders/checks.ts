import type { Order } from './order';

export interface CheckResult {
  check: string;
  passed: boolean;
}

export interface Check {
  run(order: Order, token: string, signal?: AbortSignal): Promise<unknown>;
}

export const checks: Check[] = ['stock', 'fraud'].map((name) => ({
  async run(order, token, signal) {
    const response = await fetch(`/checks/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(order),
      signal,
    });
    return response.json();
  },
}));

export function mapResult(raw: unknown): CheckResult {
  const { check, passed } = (raw ?? {}) as Partial<CheckResult>;
  if (typeof check !== 'string' || typeof passed !== 'boolean') {
    throw new Error('A check answered with something that is not a result.');
  }
  return { check, passed };
}

export const cache = new Map<string, unknown>();

export function cachedResults(orderId: string): CheckResult[] {
  return (cache.get(orderId) ?? []) as CheckResult[];
}
