import { statusLabel } from '../shared/status-label';

export function pushMessage(status: Status): string {
  return statusLabel(status);
}
