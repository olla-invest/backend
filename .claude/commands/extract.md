# RS 순위 로그 파일 추출

인수로 받은 날짜(들)에 대해 `POST /real-time-chart/metrics/calculate` API를 호출하여 `logs/rs-scores-*.log` 파일을 생성합니다.

## 사용법
- `/extract 20260415` — 단일 날짜
- `/extract 20260414 20260415 20260416` — 여러 날짜
- `/extract 20260414-20260417` — 범위 (평일만)

## 동작

$ARGUMENTS 를 파싱하여 날짜 목록을 만든 뒤 각 날짜에 대해 API를 호출하세요.

### 날짜 파싱 규칙
- `YYYYMMDD` → `YYYY-MM-DD` 변환
- `YYYYMMDD-YYYYMMDD` 범위는 시작~종료 사이 평일(월~금)만 포함

### 실행할 Bash 명령

```bash
for date in <파싱된 날짜들>; do
  echo -n "[$date] "
  curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/real-time-chart/metrics/calculate \
    -H "Content-Type: application/json" \
    -d "{\"tradeDate\":\"$date\",\"marketType\":\"all\",\"writeLogFile\":true}"
  echo ""
done
```

완료 후 `logs/` 디렉토리에서 생성된 파일 목록을 확인하여 사용자에게 알려주세요.
