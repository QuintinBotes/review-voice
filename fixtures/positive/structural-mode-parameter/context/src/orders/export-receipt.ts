import type { Receipt } from './receipt';
import { renderReceipt } from './render-receipt';

export function exportReceipt(receipt: Receipt): string {
  return renderReceipt(receipt);
}
