export interface RefreshToken {
  userId: string;
  value: string;
}

export interface Transaction {
  tokens: { create(token: RefreshToken): Promise<RefreshToken> };
  commit(): Promise<void>;
}

const committed: RefreshToken[] = [];

export const db = {
  async begin(): Promise<Transaction> {
    const pending: RefreshToken[] = [];
    return {
      tokens: {
        async create(token) {
          pending.push(token);
          return token;
        },
      },
      async commit() {
        committed.push(...pending);
      },
    };
  },
};
