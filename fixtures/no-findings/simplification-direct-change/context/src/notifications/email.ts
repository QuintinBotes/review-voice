import type { Order } from '../orders/order';

export interface Email {
  to: string;
  subject: string;
}

export const outbox: Email[] = [];

export async function sendReceiptEmail(order: Order): Promise<void> {
  outbox.push({ to: order.email, subject: `Receipt for order ${order.id}` });
}

export async function sendShipmentEmail(order: Order): Promise<void> {
  outbox.push({ to: order.email, subject: `Order ${order.id} has shipped` });
}
