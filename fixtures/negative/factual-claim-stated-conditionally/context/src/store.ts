const identifiers = new Set<string>();

export const store = {
  has(identifier: string): boolean {
    return identifiers.has(identifier);
  },
  add(identifier: string): string {
    identifiers.add(identifier);
    return identifier;
  },
};
