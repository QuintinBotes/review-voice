import type { Order } from './orders/order';

export const auth = {
  async getToken(signal: AbortSignal): Promise<string> {
    const response = await fetch('/auth/token', { method: 'POST', signal });
    return response.text();
  },
};

export const backend = {
  async submit(order: Order, token: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch('/orders', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(order),
      signal,
    });
    return response.json();
  },
};

const samples: { name: string; value: number }[] = [];

export const metrics = {
  record(name: string, value: number): void {
    samples.push({ name, value });
  },
};

let enabledAccounts: Set<string> | null = null;

export const flags = {
  load(accountIds: string[]): void {
    enabledAccounts = new Set(accountIds);
  },
  isEnabled(accountId: string): boolean {
    if (enabledAccounts === null) throw new Error('The flags are not loaded.');
    return enabledAccounts.has(accountId);
  },
};

export const logger = {
  warn(fields: Record<string, unknown>, message: string): void {
    console.warn(message, fields);
  },
};
