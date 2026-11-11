import type { Order } from './types';

export function orderLabel(order: Order): string {
  return order.number;
}
