import type { CheckoutData, Order } from './types';

export async function loadCheckout(order: Order): Promise<CheckoutData> {
  return {};
}
export function checkoutPath(order: Order): string {
  return `/orders/${order.id}/checkout`;
}
