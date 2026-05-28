process.env.DATABASE_URL = "postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public";
const { PrismaClient } = require('./generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // 수정주가 반영 현황 (BigInt 직렬화 방식 수정)
  const rows = await prisma.$queryRawUnsafe(`
    SELECT 
      COUNT(DISTINCT stock_code) FILTER (WHERE adj_close_price IS NOT NULL) as with_adj,
      COUNT(DISTINCT stock_code) FILTER (WHERE adj_close_price IS NULL) as without_adj,
      COUNT(DISTINCT stock_code) as total
    FROM stock_candles
    WHERE candle_type = 'day'
      AND stock_code NOT LIKE 'INDEX_%'
  `);
  const r = rows[0];
  console.log(`수정주가 있음: ${r.with_adj} / 없음: ${r.without_adj} / 전체: ${r.total}`);

  // adj_close_price가 NULL인데 오늘(최근 1거래일)에도 캔들이 있는 종목
  const noAdj = await prisma.$queryRawUnsafe(`
    SELECT sc.stock_code, c.company_name,
           MAX(sc.candle_time) as last_date,
           COUNT(*) as total_candles,
           SUM(CASE WHEN sc.adj_close_price IS NULL THEN 1 ELSE 0 END) as null_adj_count
    FROM stock_candles sc
    LEFT JOIN companies c ON sc.stock_code = c.stock_code
    WHERE sc.candle_type = 'day'
      AND sc.stock_code NOT LIKE 'INDEX_%'
    GROUP BY sc.stock_code, c.company_name
    HAVING MAX(sc.candle_time) >= NOW() - INTERVAL '3 days'
       AND SUM(CASE WHEN sc.adj_close_price IS NULL THEN 1 ELSE 0 END) > 0
    ORDER BY null_adj_count DESC
    LIMIT 30
  `);
  console.log(`\n최근 3일 이내 캔들이 있는데 adj_close_price NULL 행이 있는 종목 (${noAdj.length}개):`);
  noAdj.forEach(r => {
    const d = new Date(r.last_date.getTime()+9*3600000).toISOString().split('T')[0];
    console.log(` ${r.stock_code} ${r.company_name} last=${d} null_adj=${r.null_adj_count}/${r.total_candles}`);
  });

  // adj_close_price가 아예 하나도 없는 종목 (전체 NULL)
  const allNull = await prisma.$queryRawUnsafe(`
    SELECT sc.stock_code, c.company_name, COUNT(*) as candles
    FROM stock_candles sc
    LEFT JOIN companies c ON sc.stock_code = c.stock_code
    WHERE sc.candle_type = 'day'
      AND sc.stock_code NOT LIKE 'INDEX_%'
    GROUP BY sc.stock_code, c.company_name
    HAVING COUNT(*) = SUM(CASE WHEN sc.adj_close_price IS NULL THEN 1 ELSE 0 END)
       AND MAX(sc.candle_time) >= NOW() - INTERVAL '3 days'
    ORDER BY sc.stock_code
    LIMIT 30
  `);
  console.log(`\nadj_close_price 전부 NULL인 종목 (최근 3일 캔들 있는 것, ${allNull.length}개):`);
  allNull.forEach(r => console.log(` ${r.stock_code} ${r.company_name} (캔들 ${r.candles}개)`));

  await prisma.$disconnect();
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
