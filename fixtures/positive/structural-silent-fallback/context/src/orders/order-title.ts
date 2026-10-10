import { customerTitle } from './customer-title';

export function orderTitle(order: Order): string {
  return customerTitle({ customerName: order.customer.name });
}
