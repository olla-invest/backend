process.env.DATABASE_URL = "postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public";
const { PrismaClient } = require('./generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // 1. 경남제약 종목 코드 찾기
  const kyungnam = await prisma.company.findMany({
    where: { companyName: { contains: '경남제약' } },
    select: { stockCode: true, companyName: true, marketType: true }
  });
  console.log('=== 경남제약 ===');
  console.log(JSON.stringify(kyungnam));

  if (kyungnam.length > 0) {
    const code = kyungnam[0].stockCode;
    // 거래정지 기간 데이터 확인 (closePrice=0 또는 volume=0)
    const zeroCandles = await prisma.stockCandle.findMany({
      where: {
        stockCode: code,
        candleType: 'day',
        OR: [
          { closePrice: { lte: 0 } },
          { volume: 0n }
        ]
      },
      orderBy: { candleTime: 'desc' },
      take: 20,
      select: { candleTime: true, closePrice: true, volume: true, tradingValue: true }
    });
    console.log(`\n경남제약(${code}) 거래정지 의심 캔들 (closePrice=0 or volume=0): ${zeroCandles.length}개`);
    zeroCandles.slice(0, 10).forEach(c => {
      const d = new Date(c.candleTime.getTime()+9*3600000).toISOString().split('T')[0];
      console.log(` ${d}: close=${Number(c.closePrice)} vol=${c.volume} tv=${c.tradingValue}`);
    });

    // 최근 캔들 확인
    const recent = await prisma.stockCandle.findMany({
      where: { stockCode: code, candleType: 'day' },
      orderBy: { candleTime: 'desc' }, take: 5,
      select: { candleTime: true, closePrice: true, adjClosePrice: true, volume: true }
    });
    console.log('\n경남제약 최근 5일:');
    recent.forEach(c => {
      const d = new Date(c.candleTime.getTime()+9*3600000).toISOString().split('T')[0];
      console.log(` ${d}: close=${Number(c.closePrice)} adj=${c.adjClosePrice ? Number(c.adjClosePrice) : 'null'} vol=${c.volume}`);
    });
  }

  // 2. 수정주가 미반영 종목 (adj_close_price가 NULL인 종목 수)
  console.log('\n=== 수정주가 반영 현황 ===');
  const totalWithAdj = await prisma.$queryRaw`
    SELECT 
      COUNT(DISTINCT stock_code) FILTER (WHERE adj_close_price IS NOT NULL) as with_adj,
      COUNT(DISTINCT stock_code) FILTER (WHERE adj_close_price IS NULL) as without_adj,
      COUNT(DISTINCT stock_code) as total
    FROM stock_candles
    WHERE candle_type = 'day'
      AND stock_code NOT LIKE 'INDEX_%'
  `;
  console.log('전체:', JSON.stringify(totalWithAdj));

  // adj_close_price가 NULL인 종목 목록 (최근 데이터 기준)
  const noAdjStocks = await prisma.$queryRaw`
    SELECT DISTINCT sc.stock_code, c.company_name
    FROM stock_candles sc
    LEFT JOIN companies c ON sc.stock_code = c.stock_code
    WHERE sc.candle_type = 'day'
      AND sc.stock_code NOT LIKE 'INDEX_%'
      AND sc.adj_close_price IS NULL
      AND sc.candle_time >= NOW() - INTERVAL '10 days'
    ORDER BY sc.stock_code
    LIMIT 30
  `;
  console.log(`\nadj_close_price NULL 종목 (최근 10일 기준, 최대 30개):`);
  noAdjStocks.forEach(r => console.log(` ${r.stock_code} ${r.company_name}`));

  await prisma.$disconnect();
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
