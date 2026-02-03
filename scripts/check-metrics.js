const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();

async function checkMetrics() {
  try {
    const metrics = await prisma.stockDailyMetrics.findMany({
      take: 5,
      orderBy: { tradeDate: 'desc' },
    });

    console.log('Found', metrics.length, 'metrics');
    console.log(JSON.stringify(metrics, null, 2));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkMetrics();
