process.env.DATABASE_URL = "postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public";
const { PrismaClient } = require('./generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const company = await prisma.company.findFirst({
    where: { stockCode: '100790' },
    select: { stockCode: true, companyName: true, marketType: true }
  });
  console.log('Company:', JSON.stringify(company));

  const candles = await prisma.stockCandle.findMany({
    where: {
      stockCode: '100790', candleType: 'day',
      candleTime: { gte: new Date('2026-01-24T15:00:00Z'), lte: new Date('2026-02-06T15:00:00Z') }
    },
    orderBy: { candleTime: 'asc' },
    select: { candleTime: true, closePrice: true, adjClosePrice: true }
  });
  console.log('\n1월말~2월초 가격:');
  candles.forEach(c => {
    const d = new Date(c.candleTime.getTime() + 9*60*60*1000).toISOString().split('T')[0];
    console.log(` ${d}: close=${Number(c.closePrice)} adj=${c.adjClosePrice ? Number(c.adjClosePrice) : 'null'}`);
  });

  const kospi = await prisma.stockCandle.findMany({
    where: { stockCode: 'INDEX_KOSPI', candleType: 'day' },
    orderBy: { candleTime: 'desc' }, take: 65,
    select: { candleTime: true, closePrice: true }
  });
  const kd = await prisma.stockCandle.findMany({
    where: { stockCode: 'INDEX_KOSDAQ', candleType: 'day' },
    orderBy: { candleTime: 'desc' }, take: 65,
    select: { candleTime: true, closePrice: true }
  });
  console.log('\nKOSPI  now:', new Date(kospi[0].candleTime.getTime()+9*3600000).toISOString().split('T')[0], Number(kospi[0].closePrice));
  console.log('KOSPI  63ago:', new Date(kospi[63].candleTime.getTime()+9*3600000).toISOString().split('T')[0], Number(kospi[63].closePrice));
  console.log('KOSDAQ now:', new Date(kd[0].candleTime.getTime()+9*3600000).toISOString().split('T')[0], Number(kd[0].closePrice));
  console.log('KOSDAQ 63ago:', new Date(kd[63].candleTime.getTime()+9*3600000).toISOString().split('T')[0], Number(kd[63].closePrice));

  const closeNow = 55300, close63_olla = 19200;
  const kpNow = Number(kospi[0].closePrice), kp63 = Number(kospi[63].closePrice);
  const kdNow = Number(kd[0].closePrice), kd63 = Number(kd[63].closePrice);
  const sr = closeNow / close63_olla;
  console.log('\n미래에셋 stock return (close63=19200):', sr.toFixed(4));
  console.log('KOSPI  return:', (kpNow/kp63).toFixed(4), '-> rsRaw:', (sr/(kpNow/kp63)).toFixed(4));
  console.log('KOSDAQ return:', (kdNow/kd63).toFixed(4), '-> rsRaw:', (sr/(kdNow/kd63)).toFixed(4), '<-- Olla');

  await prisma.$disconnect();
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
