import type { Item } from './item';

export function calc(items: Item[]): number {
  return items.reduce((acc, i) => acc + i.price * i.qty, 0);
}
