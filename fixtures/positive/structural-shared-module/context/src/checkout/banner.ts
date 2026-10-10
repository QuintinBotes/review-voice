export function checkoutBannerFor(status: Status): string | null {
  return status === 'payment-due' ? 'Payment due before checkout' : null;
}
