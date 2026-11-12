import { customerTitle } from '../orders/customer-title';
import type { Order } from '../orders/order';

export function returnTitle(order: Order): string {
  return customerTitle({ customerName: order.customer.name });
}
