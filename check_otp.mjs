import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const otps = await p.oTP.findMany();
console.log('OTP records:', JSON.stringify(otps, null, 2));
console.log('NOW (server):', new Date().toISOString());
await p.$disconnect();
