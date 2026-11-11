import { customerTitle } from './customer-title';
import type { Order } from './order';

export function orderTitle(order: Order): string {
  return customerTitle({ customerName: order.customer.name });
}
