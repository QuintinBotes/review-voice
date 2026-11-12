const pounds = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export function formatAmount(amount: number): string {
  return pounds.format(amount);
}
