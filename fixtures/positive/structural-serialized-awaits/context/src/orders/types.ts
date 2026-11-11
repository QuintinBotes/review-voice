import type { Account } from '../accounts/load-account';
import type { DeliveryOption } from '../delivery/load-options';

export interface Order {
  id: string;
  accountId: string;
  addressId: string;
}

export interface CheckoutData {
  account?: Account;
  delivery?: DeliveryOption[];
}
