import type { Flags } from '../config/defaults';
import { store } from './store';

export function register(identifier: string, flags: Flags) {
  return store.add(identifier);
}
