import { PrismaClient } from './generated/prisma/index.js';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public'
    }
  }
});

async function main() {
  const hourDist = await prisma.$queryRaw`
    SELECT 
      EXTRACT(HOUR FROM candle_time)::int as utc_hour,
      COUNT(*)::int as cnt
    FROM stock_candles
    WHERE candle_type = 'day'
    GROUP BY EXTRACT(HOUR FROM candle_time)
    ORDER BY cnt DESC
  `;
  console.log('시간대 분포:');
  hourDist.forEach(r => console.log(`  UTC ${r.utc_hour}시: ${r.cnt}개`));

  const dups = await prisma.$queryRaw`
    SELECT stock_code, 
      (candle_time AT TIME ZONE 'Asia/Seoul')::date::text as kst_date, 
      COUNT(*)::int as cnt
    FROM stock_candles
    WHERE candle_type = 'day' AND candle_time >= '2026-03-01'
    GROUP BY stock_code, (candle_time AT TIME ZONE 'Asia/Seoul')::date
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 10
  `;
  console.log('\nKST 기준 중복 건수 (3월 이후):', dups.length);
  if (dups.length > 0) {
    dups.forEach(d => console.log(`  ${d.stock_code} ${d.kst_date}: ${d.cnt}개`));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
