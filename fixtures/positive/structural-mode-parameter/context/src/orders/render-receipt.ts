import type { Receipt } from './receipt';

export function renderReceipt(receipt: Receipt): string {
  const lines = [receipt.number, receipt.total];
  return lines.join('\n');
}
