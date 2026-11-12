export interface DeliveryOption {
  carrier: string;
  days: number;
}

export async function loadDeliveryOptions(addressId: string): Promise<DeliveryOption[]> {
  const response = await fetch(`/addresses/${addressId}/delivery-options`);
  return response.json();
}
