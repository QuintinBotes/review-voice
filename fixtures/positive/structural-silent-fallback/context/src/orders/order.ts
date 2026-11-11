export interface Order {
  id: string;
  customer: { name: string };
}

export function orderFromRow(row: { id: string; customer_name: string | null }): Order {
  if (row.customer_name === null) throw new Error(`Order ${row.id} has no customer.`);
  return { id: row.id, customer: { name: row.customer_name } };
}
