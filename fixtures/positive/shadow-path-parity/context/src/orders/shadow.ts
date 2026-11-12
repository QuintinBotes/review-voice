import { auth, backend, metrics } from '../platform';
import type { Order } from './order';

export async function submitOrder(order: Order, ct: AbortSignal) {
  const startedAt = performance.now();
  const token = await auth.getToken(ct);
  const result = await backend.submit(order, token, ct);
  metrics.record("order_latency", performance.now() - startedAt);
  return result;
}
