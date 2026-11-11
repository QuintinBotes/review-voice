export interface Invoice {
  id: string;
  archivedAt: Date | null;
}

export async function archiveInvoice(invoice: Invoice): Promise<void> {
  invoice.archivedAt = new Date();
}
