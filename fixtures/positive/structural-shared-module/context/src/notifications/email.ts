import { statusLabel } from '../shared/status-label';

export function emailSubject(status: Status): string {
  return `Order update: ${statusLabel(status)}`;
}
