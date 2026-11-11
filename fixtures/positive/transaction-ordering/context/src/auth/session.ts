import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { db } from '../db';

function randomToken(): string {
  return randomBytes(32).toString('hex');
}

export async function issueRefreshToken(userId: string, res: Response) {
  const tx = await db.begin();
  const token = await tx.tokens.create({ userId, value: randomToken() });
  await tx.commit();
  res.json({ refreshToken: token.value });
}
