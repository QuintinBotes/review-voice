import type { Order } from './order';

export interface CheckResult {
  check: string;
  passed: boolean;
}

export interface Check {
  run(order: Order, token: string, signal: AbortSignal): Promise<unknown>;
}

export const check: Check = {
  async run(order, token, signal) {
    const response = await fetch('/checks/order', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(order),
      signal,
    });
    return response.json();
  },
};

export function validateResult(raw: unknown): CheckResult[] {
  if (!Array.isArray(raw)) throw new Error('The check answered with something that is not a list of results.');
  return raw.map((entry: Partial<CheckResult>) => {
    if (typeof entry.check !== 'string' || typeof entry.passed !== 'boolean') {
      throw new Error('The check answered with something that is not a result.');
    }
    return { check: entry.check, passed: entry.passed };
  });
}

export const cache = new Map<string, CheckResult[]>();

export function cachedResults(orderId: string): CheckResult[] {
  return cache.get(orderId) ?? [];
}
