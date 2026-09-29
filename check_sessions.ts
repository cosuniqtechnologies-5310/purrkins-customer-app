import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const sessions = await prisma.session.findMany({
    where: { shop: 'purrkins-mhrlfymw.myshopify.com' }
  });

  console.log(sessions);
}

run();
