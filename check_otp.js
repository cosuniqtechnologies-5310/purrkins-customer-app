const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const otps = await p.oTP.findMany();
  console.log('OTP records:', JSON.stringify(otps, null, 2));
  console.log('NOW (server):', new Date().toISOString());
}

main().finally(() => p.$disconnect());
