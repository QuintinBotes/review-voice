import { labels, type Status } from './status';

export function statusLabel(status: Status): string {
  return labels[status];
}
