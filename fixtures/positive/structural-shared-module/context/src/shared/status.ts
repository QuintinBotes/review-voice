export type Status = 'pending' | 'payment-due' | 'shipped';

export const labels: Record<Status, string> = {
  pending: 'Pending',
  'payment-due': 'Payment due',
  shipped: 'Shipped',
};
