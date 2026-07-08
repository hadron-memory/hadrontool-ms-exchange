/**
 * Prisma client singleton for the tool's own database.
 */
import { PrismaClient } from '@prisma/client';

export const db = new PrismaClient();
export type Db = PrismaClient;
