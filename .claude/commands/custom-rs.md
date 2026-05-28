# 특정 종목 RS 상세 로그 추출

인수로 받은 날짜와 종목코드로 `POST /real-time-chart/metrics/custom-rs` API를 호출하여 `logs/custom-rs-scores-*.log` 파일을 생성합니다.
SF1~SF5, DF1~DF3 각 필터 통과/실패 상세값이 포함됩니다.

## 사용법
- `/custom-rs 20260424 005930 001510` — 날짜 + 종목코드(들)
- `/custom-rs 20260424 005930` — 단일 종목

## 동작

$ARGUMENTS 첫 번째 인수는 날짜(YYYYMMDD → YYYY-MM-DD), 나머지는 종목코드 목록입니다.

### 실행할 Bash 명령

```bash
curl -s -X POST http://localhost:3000/real-time-chart/metrics/custom-rs \
  -H "Content-Type: application/json" \
  -d '{"tradeDate":"<YYYY-MM-DD>","stockCodes":["<코드1>","<코드2>",...]}'
```

완료 후 `logs/` 디렉토리에서 생성된 `custom-rs-scores-*.log` 파일을 확인하여 사용자에게 알려주세요.
