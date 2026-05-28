process.env.DATABASE_URL = "postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public";
const { PrismaClient } = require('./generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // 대표 종목(인터플렉스) null adj 날짜 확인
  const nullRows = await prisma.stockCandle.findMany({
    where: { stockCode: '051370', candleType: 'day', adjClosePrice: null },
    orderBy: { candleTime: 'desc' }, take: 10,
    select: { candleTime: true, closePrice: true, adjClosePrice: true }
  });
  console.log('인터플렉스 null adj 날짜:');
  nullRows.forEach(c => {
    const d = new Date(c.candleTime.getTime()+9*3600000).toISOString().split('T')[0];
    console.log(` ${d}: close=${Number(c.closePrice)} adj=null`);
  });

  // null adj가 있는 전체 종목 수 (1개 이상 null인 종목)
  const total = await prisma.$queryRawUnsafe(`
    SELECT COUNT(DISTINCT stock_code) as cnt
    FROM stock_candles
    WHERE candle_type = 'day'
      AND stock_code NOT LIKE 'INDEX_%'
      AND adj_close_price IS NULL
  `);
  console.log('\nnull adj 캔들 행이 1개 이상 있는 종목 수:', total[0].cnt.toString());

  // null adj 날짜 분포
  const dateDist = await prisma.$queryRawUnsafe(`
    SELECT TO_CHAR(candle_time + INTERVAL '9 hours', 'YYYY-MM-DD') as dt,
           COUNT(DISTINCT stock_code) as stocks
    FROM stock_candles
    WHERE candle_type = 'day'
      AND stock_code NOT LIKE 'INDEX_%'
      AND adj_close_price IS NULL
    GROUP BY dt
    ORDER BY dt DESC
    LIMIT 20
  `);
  console.log('\nnull adj 날짜별 종목 수 (최근):');
  dateDist.forEach(r => console.log(` ${r.dt}: ${r.stocks}종목`));

  // 경남제약 RS 계산 시 63거래일 전 종가 확인
  console.log('\n=== 경남제약(053950) RS 계산 분석 ===');
  const kosdaq = await prisma.stockCandle.findMany({
    where: { stockCode: 'INDEX_KOSDAQ', candleType: 'day' },
    orderBy: { candleTime: 'desc' }, take: 65,
    select: { candleTime: true, closePrice: true }
  });
  const kyungnam = await prisma.stockCandle.findMany({
    where: { stockCode: '053950', candleType: 'day' },
    orderBy: { candleTime: 'desc' }, take: 70,
    select: { candleTime: true, closePrice: true, adjClosePrice: true, volume: true, tradingValue: true }
  });

  const idx63Ago = kosdaq[63];
  console.log('KOSDAQ 63거래일전:', new Date(idx63Ago.candleTime.getTime()+9*3600000).toISOString().split('T')[0], Number(idx63Ago.closePrice));

  // 인덱스 63일전 날짜와 경남제약 가격 매칭
  const idx63Ms = idx63Ago.candleTime.getTime();
  const matching = kyungnam.find(c => c.candleTime.getTime() === idx63Ms);
  console.log('경남제약 63일전 종가:', matching
    ? `${new Date(matching.candleTime.getTime()+9*3600000).toISOString().split('T')[0]} close=${Number(matching.closePrice)} vol=${matching.volume}`
    : '해당 날짜 캔들 없음');

  const latest = kyungnam[0];
  if (matching) {
    const sr = Number(latest.closePrice) / Number(matching.closePrice);
    const ir = Number(kosdaq[0].closePrice) / Number(idx63Ago.closePrice);
    console.log(`rsRaw = (${Number(latest.closePrice)}/${Number(matching.closePrice)}) / (${Number(kosdaq[0].closePrice)}/${Number(idx63Ago.closePrice)}) = ${(sr/ir).toFixed(4)}`);
    console.log(`오늘 거래대금: ${latest.tradingValue ? Number(latest.tradingValue) : Number(latest.closePrice)*Number(latest.volume)}`);
  }

  await prisma.$disconnect();
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
