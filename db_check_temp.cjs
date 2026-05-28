const { PrismaClient } = require('./generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: 'postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public' });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  // 기존 백만원 단위 데이터를 원 단위로 변환 (× 1,000,000)
  const result = await prisma.$executeRaw`
    UPDATE stock_candles
    SET trading_value = trading_value * 1000000
    WHERE trading_value IS NOT NULL
  `;
  console.log('업데이트된 레코드 수:', result);

  // 확인
  const sample = await prisma.$queryRaw`
    SELECT candle_time, close_price, volume, trading_value
    FROM stock_candles
    WHERE stock_code = '043260' AND candle_type = 'day'
    ORDER BY candle_time DESC LIMIT 3
  `;
  console.log('\n043260 변환 후:');
  sample.forEach(r => {
    const tv억 = r.trading_value ? (Number(r.trading_value) / 1e8).toFixed(1) : null;
    console.log(`  ${r.candle_time.toISOString().slice(0,10)} close=${r.close_price} vol=${r.volume} tradingValue=${r.trading_value} (${tv억}억원)`);
  });
}
main().catch(console.error).finally(() => prisma.$disconnect());
