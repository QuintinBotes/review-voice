import { customerTitle } from '../orders/customer-title';

export function returnTitle(order: Order): string {
  return customerTitle({ customerName: order.customer.name });
}
