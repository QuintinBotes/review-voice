const counts = new Map<string, number>();

export const metrics = {
  increment(name: string): void {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  },
};
