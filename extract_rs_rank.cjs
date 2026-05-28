const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: 'postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public',
});

const TARGET_DATES = ['2026-03-10', '2026-03-11', '2026-03-19'];

async function extractRsRank() {
  const client = await pool.connect();
  try {
    for (const date of TARGET_DATES) {
      const result = await client.query(
        `SELECT
          m.rank,
          m.stock_code,
          c.company_name,
          m.market_type,
          m.relative_strength_score,
          m.close_price,
          m.price_change_rate_1d,
          m.is_new_high,
          m.passed_static_filters,
          m.is_trend_template
        FROM stock_daily_metrics m
        LEFT JOIN companies c ON m.stock_code = c.stock_code
        WHERE m.trade_date = $1
        ORDER BY m.rank ASC`,
        [date]
      );

      const rows = result.rows;
      if (rows.length === 0) {
        console.log(`[${date}] 데이터 없음`);
        continue;
      }

      // CSV 생성
      const header = 'rank,stock_code,company_name,market_type,rs_score,close_price,price_change_rate_1d,is_new_high,passed_static_filters,is_trend_template';
      const lines = rows.map(r =>
        [
          r.rank,
          r.stock_code,
          `"${r.company_name || ''}"`,
          r.market_type === '0' ? 'KOSPI' : r.market_type === '10' ? 'KOSDAQ' : r.market_type,
          r.relative_strength_score,
          r.close_price,
          r.price_change_rate_1d,
          r.is_new_high,
          r.passed_static_filters,
          r.is_trend_template,
        ].join(',')
      );

      const csv = [header, ...lines].join('\n');
      const filename = `rs_rank_${date}.csv`;
      fs.writeFileSync(path.join(__dirname, filename), csv, 'utf8');
      console.log(`[${date}] ${rows.length}건 저장 → ${filename}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

extractRsRank().catch(console.error);
