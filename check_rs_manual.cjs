const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public' });

const STOCKS = [
  { code: '440110', name: '파두' },
  { code: '347700', name: '스피어' },
  { code: '321370', name: '센서뷰' },
  { code: '458870', name: '씨어스테크놀로지' },
  { code: '073490', name: '이노와이어리스' },
];

const DATE_NOW = '2026-03-19';
const DATE_63  = '2025-12-10';  // 실제 63거래일 기준일

async function getDayCandle(client, code, kstDate) {
  const r = await client.query(`
    SELECT close_price
    FROM stock_candles
    WHERE stock_code = $1 AND candle_type = 'day'
      AND DATE(candle_time + interval '9 hours') = $2::date
    ORDER BY candle_time DESC LIMIT 1
  `, [code, kstDate]);
  return r.rows[0] ? Number(r.rows[0].close_price) : null;
}

async function main() {
  const client = await pool.connect();
  try {
    const compResult = await client.query(`
      SELECT stock_code, market_type FROM companies WHERE stock_code = ANY($1)
    `, [STOCKS.map(s => s.code)]);
    const marketMap = Object.fromEntries(compResult.rows.map(r => [r.stock_code, r.market_type]));

    // 지수값 (공통)
    const kosdaqNow = await getDayCandle(client, 'INDEX_KOSDAQ', DATE_NOW);
    const kosdaq63  = await getDayCandle(client, 'INDEX_KOSDAQ', DATE_63);
    const kospiNow  = await getDayCandle(client, 'INDEX_KOSPI', DATE_NOW);
    const kospi63   = await getDayCandle(client, 'INDEX_KOSPI', DATE_63);

    console.log(`\n[지수] KOSDAQ ${DATE_NOW}: ${kosdaqNow} | ${DATE_63}: ${kosdaq63}`);
    console.log(`[지수] KOSPI  ${DATE_NOW}: ${kospiNow}  | ${DATE_63}: ${kospi63}\n`);
    console.log('='.repeat(70));

    for (const s of STOCKS) {
      const market  = marketMap[s.code] ?? '?';
      const idxCode = market === '0' ? 'INDEX_KOSPI' : 'INDEX_KOSDAQ';
      const mktNow  = market === '0' ? kospiNow  : kosdaqNow;
      const mkt63   = market === '0' ? kospi63   : kosdaq63;

      const stockNow = await getDayCandle(client, s.code, DATE_NOW);
      const stock63  = await getDayCandle(client, s.code, DATE_63);

      const rsRaw = stockNow && stock63 && mktNow && mkt63
        ? (stockNow / stock63) / (mktNow / mkt63)
        : null;

      // 로그 파일에서 확인한 값
      const logValues = {
        '440110': { rsRaw: 1.941241, close63: 24000, idx63: 93464 },
        '347700': { rsRaw: 3.953182, close63:  9480, idx63: 93464 },
        '321370': { rsRaw: 3.295432, close63:  1007, idx63: 93464 },
        '458870': { rsRaw: 1.312514, close63: 39253, idx63: 93464 },
        '073490': { rsRaw: 1.417950, close63: 23000, idx63: 93464 },
      };
      const log = logValues[s.code];

      console.log(`[${s.code}] ${s.name} (${market === '0' ? 'KOSPI' : 'KOSDAQ'})`);
      console.log(`  종가 ${DATE_NOW}: ${stockNow}  |  종가 ${DATE_63}: ${stock63}  (로그 close63: ${log.close63})`);
      console.log(`  idx ${DATE_NOW}: ${mktNow}  |  ${DATE_63}: ${mkt63}  (로그 idx63: ${log.idx63})`);
      console.log(`  rsRaw 계산: ${rsRaw?.toFixed(6) ?? 'N/A'}  |  로그 rsRaw: ${log.rsRaw}`);
      console.log(`  ${Math.abs((rsRaw ?? 0) - log.rsRaw) < 0.001 ? '✓ 일치' : '✗ 불일치'}`);
      console.log();
    }
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(console.error);
