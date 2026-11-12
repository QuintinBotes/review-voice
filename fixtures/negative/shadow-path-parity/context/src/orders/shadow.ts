import { auth, backend, metrics } from '../platform';
import type { Order } from './order';

export async function submitOrder(order: Order) {
  const startedAt = performance.now();
  const budget = AbortSignal.timeout(4_000);
  const token = await auth.getToken(budget);
  const result = await backend.submit(order, token, budget);
  metrics.record("order_latency", performance.now() - startedAt);
  return result;
}
