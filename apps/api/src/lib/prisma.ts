import { PrismaClient } from '@prisma/client';

// Support seamless JSON serialization of BigInt values across Express responses
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof (BigInt.prototype as any).toJSON === 'undefined') {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
