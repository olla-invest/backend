process.env.DATABASE_URL = "postgresql://kiwoom_user:kiwoom@2026@localhost:15433/investment_db?schema=public";
const { PrismaClient } = require('./generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function check() {
  const codes = ['024850', '380540', '010120'];
  
  for (const code of codes) {
    const company = await prisma.company.findFirst({ where: { stockCode: code }, select: { stockCode: true, companyName: true, marketType: true } });
    if (!company) { console.log(`\n=== ${code}: Company not found in DB ===`); continue; }
    
    const candleCount = await prisma.stockCandle.count({ where: { stockCode: code, candleType: 'day' } });
    
    const latest = await prisma.stockCandle.findFirst({
      where: { stockCode: code, candleType: 'day' },
      orderBy: { candleTime: 'desc' }
    });
    
    const candles = await prisma.stockCandle.findMany({
      where: { stockCode: code, candleType: 'day' },
      orderBy: { candleTime: 'desc' },
      take: 252,
      select: { candleTime: true, closePrice: true, tradingValue: true }
    });
    
    const closes = candles.map(c => Number(c.closePrice)).reverse();
    const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((a,b)=>a+b,0)/50 : null;
    const ma150 = closes.length >= 150 ? closes.slice(-150).reduce((a,b)=>a+b,0)/150 : null;
    const ma200 = closes.length >= 200 ? closes.slice(-200).reduce((a,b)=>a+b,0)/200 : null;
    
    const closeNow = latest ? Number(latest.closePrice) : null;
    const tradeValue = latest ? Number(latest.tradingValue) : null;
    
    const prices = candles.map(c => Number(c.closePrice));
    const high52 = prices.length > 0 ? Math.max(...prices) : null;
    const low52 = prices.length > 0 ? Math.min(...prices) : null;
    
    console.log(`\n=== ${code} ${company.companyName} (${company.marketType}) ===`);
    console.log(`  캔들수(day): ${candleCount}, 최근캔들: ${latest?.candleTime?.toISOString().slice(0,10)}`);
    console.log(`  closeNow=${closeNow}, 거래대금=${tradeValue ? (tradeValue/100000000).toFixed(1)+'억' : null}`);
    console.log(`  MA50=${ma50?.toFixed(0)}, MA150=${ma150?.toFixed(0)}, MA200=${ma200?.toFixed(0)}`);
    console.log(`  52주고가=${high52}, 52주저가=${low52}`);
    
    const sf1 = ma50 != null && ma150 != null ? ma50 > ma150 : null;
    const sf2 = ma150 != null && ma200 != null ? ma150 > ma200 : null;
    const sf5 = tradeValue != null ? tradeValue >= 1_000_000_000 : null;
    
    const df1 = closeNow != null && low52 != null ? closeNow >= low52 * 1.3 : null;
    const df2 = closeNow != null && high52 != null ? closeNow >= high52 * 0.75 : null;
    const df3 = closeNow != null && ma50 != null ? closeNow > ma50 : null;
    
    // SF3: MA200 uptrend (63 거래일 전 MA200)
    const candles300 = await prisma.stockCandle.findMany({
      where: { stockCode: code, candleType: 'day' },
      orderBy: { candleTime: 'desc' },
      take: 300,
      select: { closePrice: true }
    });
    const closes300 = candles300.map(c => Number(c.closePrice)).reverse();
    const ma200_63ago = closes300.length >= 263 ? closes300.slice(-263, -63).reduce((a,b)=>a+b,0)/200 : null;
    const sf3 = ma200 != null && ma200_63ago != null ? ma200 > ma200_63ago : null;
    
    console.log(`  [SF1] MA50>MA150: ${sf1}  (${ma50?.toFixed(0)} > ${ma150?.toFixed(0)})`);
    console.log(`  [SF2] MA150>MA200: ${sf2}  (${ma150?.toFixed(0)} > ${ma200?.toFixed(0)})`);
    console.log(`  [SF3] MA200 uptrend: ${sf3}  (현재 ${ma200?.toFixed(0)} > 63일전 ${ma200_63ago?.toFixed(0)})`);
    console.log(`  [SF5] 거래대금>=10억: ${sf5}  (${tradeValue ? (tradeValue/100000000).toFixed(1)+'억' : null})`);
    console.log(`  [DF1] close>=52저×1.3: ${df1}  (${closeNow} >= ${low52 ? (low52*1.3).toFixed(0) : 'N/A'})`);
    console.log(`  [DF2] close>=52고×0.75: ${df2}  (${closeNow} >= ${high52 ? (high52*0.75).toFixed(0) : 'N/A'})`);
    console.log(`  [DF3] close>MA50: ${df3}  (${closeNow} > ${ma50?.toFixed(0)})`);
    
    const failedSF = [sf1===false&&'SF1', sf2===false&&'SF2', sf3===false&&'SF3', sf5===false&&'SF5'].filter(Boolean);
    const failedDF = [df1===false&&'DF1', df2===false&&'DF2', df3===false&&'DF3'].filter(Boolean);
    if (failedSF.length || failedDF.length) {
      console.log(`  >>> 실패 필터: ${[...failedSF, ...failedDF].join(', ')}`);
    } else if (candleCount < 64) {
      console.log(`  >>> 캔들 부족 (${candleCount}개 < 64개 필요)`);
    } else {
      console.log(`  >>> 모든 필터 통과 (다른 이유로 누락?)`);
    }
  }
  
  await prisma.$disconnect();
  await pool.end();
}
check().catch(console.error);
