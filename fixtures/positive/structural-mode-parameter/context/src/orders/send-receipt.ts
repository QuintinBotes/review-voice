import { mail, type Message } from './mail';
import type { Receipt } from './receipt';
import { renderReceipt } from './render-receipt';

export function sendReceipt(receipt: Receipt): Message {
  return mail(renderReceipt(receipt));
}
