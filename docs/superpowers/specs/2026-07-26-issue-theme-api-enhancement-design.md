# 이슈테마 API 고도화 설계

## 1. 목적과 범위

첨부된 이슈테마 순위·히트맵·상세 패널 화면에서 필요한 데이터를 `olla-back`의 기존 이슈테마 API 확장으로 제공한다.

이번 범위는 백엔드 API, 장마감 집계, LLM 기반 테마 요약 저장까지다. 프론트 레이아웃과 렌더링은 포함하지 않는다. 기존 `GET /issue-theme`, `GET /issue-theme/:themeCode`, 즐겨찾기 API, `ThemeDailySnapshot`을 재사용한다.

## 2. 핵심 원칙

- 목록과 상세는 기존 엔드포인트를 확장하며 화면 전용 중복 API를 만들지 않는다.
- 장중 목록은 실시간 가격 캐시를 사용할 수 있지만, 연속일·모멘텀·AI 요약은 확정된 거래일 스냅샷을 기준으로 한다.
- LLM 호출은 사용자 요청 경로에서 실행하지 않는다. 장마감 집계 후 하루 1회 비동기로 실행한다.
- LLM 실패가 테마 스냅샷 저장이나 목록 API를 실패시키지 않아야 한다.
- 검색, 관심테마, 선택 필터는 AND 조건으로 결합한다.

## 3. 목록 API

### 3.1 엔드포인트

`GET /issue-theme`

### 3.2 쿼리

| 필드 | 값 | 기본값 | 설명 |
|---|---|---|---|
| `search` | 문자열 | 없음 | 테마명 부분 일치, 대소문자 무시, 앞뒤 공백 제거 |
| `view` | `rank`, `heatmap` | `rank` | 응답 데이터는 동일하며 히트맵 사용 시 검색을 허용하지 않음 |
| `filter` | `all`, `rs80`, `momentum`, `stockCount5`, `changeRate5`, `hasNewHigh` | `all` | 단일 필터 선택 |
| `favoritesOnly` | boolean | `false` | 로그인 사용자의 관심테마만 조회 |
| `sort` | `rs`, `changeRate`, `previousRank` | `rs` | 목록 정렬 |
| `display` | 1~300 | 20 | 페이지 크기 |
| `page` | 1 이상 | 1 | 페이지 번호 |

`favoritesOnly=true`는 선택 JWT 인증을 사용한다. 인증 정보가 없으면 `401`을 반환한다. `view=heatmap`과 비어 있지 않은 `search`를 함께 전달하면 `400`을 반환해 화면 규칙을 API에서도 명확히 한다.

### 3.3 필터 순서

1. 노출 대상 테마: RS 80 이상 종목을 2개 이상 보유
2. `search`
3. `favoritesOnly`
4. `filter`
5. `sort`
6. 페이지네이션

필터 칩 카운트는 1~3단계가 적용된 모집단에서 각 필터를 독립 적용한 개수다. 따라서 검색어나 관심테마 조건이 바뀌면 카운트도 같이 바뀐다.

### 3.4 필터 정의

- `all`: 노출 대상 전체
- `rs80`: 테마 평균 RS가 80 이상
- `momentum`: 모멘텀 값이 0보다 큼
- `stockCount5`: 테마 전체 소속 종목이 5개 이상
- `changeRate5`: RS 80 이상 종목의 평균 등락률이 5% 이상
- `hasNewHigh`: 신고가 종목이 1개 이상

### 3.5 정렬

- `rs`: `rsScore DESC`, `changeRate DESC`, `themeCode ASC`
- `changeRate`: `changeRate DESC`, `rsScore DESC`, `themeCode ASC`
- `previousRank`: `previousRank ASC NULLS LAST`, `rsScore DESC`, `themeCode ASC`

### 3.6 응답

```json
{
  "items": [
    {
      "rank": 1,
      "previousRank": 3,
      "rankChange": 2,
      "themeCode": 100001,
      "themeName": "로봇",
      "rsScore": 94.2,
      "shortTermRs": 95.1,
      "momentum": 2.4,
      "changeRate": 7.9,
      "stockCount": 22,
      "eligibleStockCount": 5,
      "risingCount": 15,
      "newHighCount": 1,
      "streakBadge": {
        "direction": "STRONG",
        "days": 2,
        "label": "2일 연속 강세",
        "tone": "RED"
      },
      "isFavorite": false,
      "topStocks": [
        { "stockCode": "000000", "stockName": "종목명" }
      ]
    }
  ],
  "filterCounts": {
    "all": 120,
    "rs80": 42,
    "momentum": 18,
    "stockCount5": 76,
    "changeRate5": 9,
    "hasNewHigh": 14
  },
  "pagination": { "page": 1, "display": 20, "total": 120, "totalPages": 6 },
  "updatedAt": "2026-07-26T06:50:00.000Z"
}
```

검색 결과가 없으면 정상 응답 `200`과 빈 `items`를 반환한다. 안내 문구는 프론트가 결정한다.

## 4. 상세 API

### 4.1 엔드포인트

`GET /issue-theme/:themeCode`

추가 쿼리:

- `stockSort=rs|shortTermRs|changeRate|tradingValue|previousRatio|newHigh`, 기본 `rs`
- `stockDisplay`, 기본 20, 최대 300

### 4.2 응답 구성

- 기본정보: 테마 코드·이름·이미지·즐겨찾기
- 순위: 현재 순위·전 거래일 순위·변동
- 집계: RS·단기 RS·모멘텀·등락률·상승 종목 수·전체 종목 수·신고가 수
- 연속 강세·약세 배지
- 최신 성공 AI 요약과 생성 시각·출처 기사
- 정렬된 종목 목록
- 연관테마 최대 3개

종목 행에는 다음 필드를 제공한다.

- `rank`, `stockCode`, `stockName`
- `rsScore`, `shortTermRs`
- `changeRate`, `tradingValue`
- `previousTradingValueRatio`
- `newHighRate`: 신고가 대비 현재가 이격률. 당일 신고가 돌파는 0%, 음수는 신고가 미도달
- `isNewHigh`

## 5. 계산 규칙

### 5.1 집계 대상

테마별 계산 대상은 해당 거래일에 RS 점수가 80 이상인 소속 종목이다. 동일 테마·종목 매핑은 중복 제거한다. 대상 종목이 2개 미만이면 목록과 연관테마 후보에서 제외한다.

`stockCount`는 테마 전체 소속 종목 수이고 `eligibleStockCount`는 RS 80 이상 집계 종목 수다. 두 값을 구분해 반환한다.

### 5.2 지표

- `rsScore`: 대상 종목의 현재 RS 백분위 평균
- `shortTermRs`: 최근 3거래일의 일별 테마 평균 RS를 다시 평균한 값
- `changeRate`: 대상 종목의 당일 등락률 평균
- `risingCount`: 대상 종목 중 등락률이 0보다 큰 종목 수
- `newHighCount`: 대상 종목 중 신고가 상태인 종목 수
- `momentum`: 최근 3거래일 테마 평균 RS에서 기준 기간 테마 평균 RS를 뺀 값

1차 구현의 모멘텀 기준 기간은 시스템 기본 RS 기간인 63거래일로 고정한다. 3거래일 중 데이터가 하나라도 없으면 `shortTermRs`와 `momentum`은 `null`이며 모멘텀 필터에서 제외한다.

### 5.3 연속 배지

대상 종목의 당일 평균 등락률로 거래일 상태를 판정한다.

- `STRONG`: 0.5% 이상
- `WEAK`: -0.5% 이하
- `NEUTRAL`: 그 사이

전 거래일과 같은 방향이면 일수를 1 증가시킨다. 방향이 바뀌면 1일부터 다시 시작한다. `NEUTRAL`이면 일수를 0으로 초기화한다. 휴장일은 거래일 목록에 포함하지 않는다.

노출 규칙:

- 강세 1~3일: `RED`
- 강세 4일 이상: `ORANGE`
- 약세 2일 이상: `BLUE`
- 약세 1일과 중립: 배지 없음

### 5.4 연관테마

현재 테마와 RS 80 이상 종목 집합을 공유하는 테마를 후보로 한다.

`similarity = 교집합 종목 수 / 합집합 종목 수`

- 공유 종목 2개 이상
- 유사도 0.10 이상
- 현재 테마 제외
- 유사도 내림차순, 동점이면 연관테마 RS 내림차순
- 최대 3개

연관테마 칩의 방향과 색상 기준값은 해당 테마의 RS 80 이상 종목 평균 등락률을 사용한다.

## 6. 저장 구조

### 6.1 `ThemeDailySnapshot` 확장

- `shortTermRs Decimal?`
- `momentum Decimal?`
- `newHighCount Int @default(0)`
- `streakDirection String?`
- `streakDays Int @default(0)`

기존 `avgRsScore`, `avgChangeRate`, `risingCount`, `totalCount`, `rank`는 유지한다. `totalCount`의 기존 의미가 필터 통과 종목 수이므로, 전체 테마 소속 종목 수는 응답 생성 시 별도 집계하거나 명시적인 컬럼으로 추가한다. 구현 계획 단계에서 기존 데이터 호환성을 우선해 최종 컬럼명을 확정한다.

### 6.2 `ThemeAiSummary` 신규 모델

- `summaryId UUID`
- `themeCode Int`
- `tradeDate Date`
- `summary Text?`
- `sourceArticles Json`
- `model String`
- `promptVersion String`
- `status PENDING|SUCCESS|FAILED`
- `errorMessage Text?`
- `generatedAt DateTime?`
- `createdAt`, `updatedAt`

`themeCode + tradeDate`는 유니크다. 상세 API는 가장 최근 `SUCCESS` 행만 반환한다.

## 7. AI 요약 설계

### 7.1 입력

- 테마명
- 테마 상위 종목 3~5개
- 테마명 및 종목명으로 검색한 최근 뉴스
- 기사 제목, 설명, 언론사, 발행 시각, 원문 URL
- 테마 가격 반응 요약: 평균 등락률, 상승 종목 수

기존 네이버 뉴스 호출 코드를 공통 뉴스 클라이언트로 분리해 재사용한다. 제목·URL 기준 중복을 제거하고 최신성과 테마 관련성을 기준으로 제한된 기사만 LLM에 전달한다.

### 7.2 출력 계약

LLM은 구조화 JSON을 반환한다.

```json
{
  "summary": "시장 반응을 유발한 핵심 이슈를 설명하는 2~4문장",
  "sourceIndexes": [0, 2, 4]
}
```

프롬프트는 단순 기사 나열, 근거 없는 전망, 투자 권유를 금지한다. 파싱 실패나 출처가 없는 응답은 실패로 처리한다.

### 7.3 실행과 실패 처리

1. 15:50 테마 스냅샷 저장
2. 스냅샷 트랜잭션 완료
3. 노출 대상 상위 테마의 AI 요약 작업 실행
4. 테마별 성공·실패를 독립 저장

LLM 제공자는 인터페이스로 격리한다. 최초 구현 시 선택한 공급자의 HTTP API 또는 공식 SDK를 어댑터 하나에만 둔다.

- 타임아웃과 제한된 재시도 적용
- 동시 호출 수 제한
- 기사 없음: `FAILED`가 아니라 요약 미생성 상태로 기록
- 일부 테마 실패: 나머지 테마 계속 처리
- 최신 생성 실패: 직전 성공 요약 유지
- API 키 없음: 스냅샷은 정상 완료하고 AI 배치만 건너뜀

운영 비용을 제한하기 위해 1차 범위에서는 목록 노출 상위 테마만 생성하도록 환경설정 가능한 최대 개수를 둔다.

## 8. 관리자 API

- `POST /issue-theme/snapshot/theme`: 기존 스냅샷 수동 실행
- `POST /issue-theme/ai-summary/generate?tradeDate=YYYY-MM-DD&limit=N`: 해당 거래일 요약 생성 또는 실패 건 재시도
- `POST /issue-theme/ai-summary/:themeCode/regenerate?tradeDate=YYYY-MM-DD`: 단일 테마 강제 재생성

모두 `AdminApiKeyGuard`를 적용한다. 실행 결과에는 대상·성공·실패·건너뜀 개수와 실패 테마 코드를 반환한다.

## 9. 코드 구성

- `issue-theme.controller.ts`: 목록·상세 쿼리와 관리자 트리거
- `issue-theme.service.ts`: 목록, 상세 조합, 검색·필터·정렬
- `theme-metrics.service.ts` 신규: 테마 지표, 연속 배지, 연관테마 계산
- `theme-ai-summary.service.ts` 신규: 뉴스 선별, 프롬프트 구성, 저장, 재시도
- `llm-client.interface.ts` 및 공급자 어댑터 신규: LLM 호출 격리
- DTO 신규: 목록 쿼리, 상세 쿼리, 목록·상세 응답
- `prisma/schema.prisma` 및 마이그레이션: 스냅샷 확장, AI 요약 테이블

기존 `issue-theme.service.ts`가 동기화·집계·상세·즐겨찾기를 모두 담당하므로, 이번 작업과 직접 관련된 지표 및 AI 책임만 분리한다. unrelated 리팩터링은 하지 않는다.

## 10. 오류와 경계 조건

- 존재하지 않거나 삭제된 테마: `404`
- 잘못된 enum·범위: `400`
- 인증 없는 `favoritesOnly=true`: `401`
- 검색 결과 없음: `200`, 빈 목록
- 스냅샷 없음: 계산 가능한 장중 필드는 반환하고 역사 기반 필드는 `null`
- AI 요약 없음 또는 실패: `aiSummary: null`, 테마 상세 자체는 `200`
- 실시간 캐시가 오래됨: 최신 확정 일별 지표로 폴백하고 `updatedAt`은 실제 데이터 시점을 반환
- 휴장일: 스냅샷과 AI 배치 모두 실행하지 않음

## 11. 테스트 전략

### 단위 테스트

- 검색·관심테마·필터 AND 결합
- 각 필터 카운트 모집단
- 세 정렬 규칙과 동점 처리
- 3거래일 단기 RS와 결측 처리
- 강세·약세·중립 전환 및 휴장일 연속 계산
- 연관테마 교집합·합집합, 최소 조건, Top 3
- LLM JSON 검증, 기사 중복 제거, 실패 폴백

### 서비스 통합 테스트

- 목록 페이지네이션 및 선택 인증
- 상세 종목 정렬
- 최신 성공 AI 요약 선택
- 스냅샷 저장 후 AI 작업 분리
- 일부 LLM 실패에도 배치가 계속되는지 검증

### 검증 명령

- 신규 이슈테마 테스트 파일을 지정한 `pnpm test -- ... --runInBand`
- `pnpm exec prisma validate`
- `pnpm build`
- 마이그레이션을 적용한 테스트 DB에서 목록·상세·관리자 API 표본 조회

## 12. 구현 순서

1. 목록·상세 DTO와 응답 계약 작성
2. 계산 규칙 단위 테스트 작성
3. Prisma 모델과 마이그레이션 추가
4. 지표 계산 서비스 분리 및 스냅샷 확장
5. 목록 검색·필터·정렬·카운트 구현
6. 상세 종목 정렬과 연관테마 구현
7. 뉴스 클라이언트 공통화와 LLM 어댑터 구현
8. 장마감 AI 요약 배치 및 관리자 재생성 API 구현
9. Swagger와 API 문서 갱신
10. 테스트, Prisma 검증, 빌드, 표본 API 검증

## 13. 완료 기준

- 순위 뷰와 히트맵 뷰가 동일한 목록 데이터 계약으로 표현된다.
- 검색·관심테마·필터가 AND 조건으로 동작하고 필터 카운트가 동일 모집단을 반영한다.
- RS, 단기 RS, 모멘텀, 연속 배지, 신고가, 연관테마가 거래일 기준으로 재현 가능하다.
- 상세 API가 종목 정렬과 최신 성공 AI 요약을 제공한다.
- 장마감 스냅샷 성공 여부가 LLM 상태에 의존하지 않는다.
- LLM 장애 시 기존 API 가용성과 직전 성공 요약이 유지된다.
