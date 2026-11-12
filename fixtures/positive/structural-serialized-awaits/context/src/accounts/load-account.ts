export interface Account {
  id: string;
  name: string;
}

export async function loadAccount(accountId: string): Promise<Account> {
  const response = await fetch(`/accounts/${accountId}`);
  return response.json();
}
