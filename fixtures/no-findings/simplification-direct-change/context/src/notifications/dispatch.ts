import type { Order } from '../orders/order';
import { sendReceiptEmail, sendShipmentEmail } from './email';

export type UpdateKind = 'receipt' | 'shipment';

export function dispatchOrderUpdate(order: Order, kind: UpdateKind): Promise<void> {
  if (kind === 'receipt') return sendReceiptEmail(order);
  return sendShipmentEmail(order);
}
