# 이슈테마 / 관심종목 / 로그인 API 명세서

Base URL: `http://localhost:3000`
인증: JWT Bearer Token (`Authorization: Bearer <accessToken>`)

---

---

## 1. 로그인 관련 API `/auth`

인증 방식: 앱 전체에 JwtAuthGuard 전역 적용. 🔒 표시 엔드포인트만 토큰 필요.
JWT 만료: 7일 / 페이로드: `{ sub: userId, username, email }`

---

### 1-1. 회원가입

```
POST /auth/register
```

파라미터 (Body · application/json)
```
username        String  필수   4~20자, 영문·숫자만  (/^[a-zA-Z0-9]{4,20}$/)
password        String  필수   8~50자
email           String  필수   이메일 형식, 최대 100자
name            String  필수   최대 100자
phone           String  필수   최대 20자
agreeService    Bool    필수   true 이어야 가입 가능 (false 시 400)
agreePrivacy    Bool    필수   true 이어야 가입 가능 (false 시 400)
agreeMarketing  Bool    선택   마케팅 수신 동의, 기본값 false
```

호출 예시
```http
POST /auth/register
Content-Type: application/json

{
  "username": "honggildong",
  "password": "myPass123!",
  "email": "hong@example.com",
  "name": "홍길동",
  "phone": "010-1234-5678",
  "agreeService": true,
  "agreePrivacy": true,
  "agreeMarketing": false
}
```

Response 201
```json
{
  "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "username": "honggildong",
  "email": "hong@example.com",
  "name": "홍길동"
}
```

에러 Response
```json
// 400 — 필수 약관 미동의
{ "statusCode": 400, "message": "필수 약관에 동의해주세요", "error": "Bad Request" }

// 409 — 아이디 중복
{ "statusCode": 409, "message": "이미 사용 중인 ID입니다", "error": "Conflict" }

// 409 — 이메일 중복
{ "statusCode": 409, "message": "이미 사용 중인 이메일입니다", "error": "Conflict" }
```

---

### 1-2. 로그인

```
POST /auth/login
```

파라미터 (Body · application/json)
```
username   String  필수   로그인 아이디
password   String  필수   비밀번호
```

호출 예시
```http
POST /auth/login
Content-Type: application/json

{
  "username": "honggildong",
  "password": "myPass123!"
}
```

Response 200
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhMWIyYzNkNC1lNWY2LTc4OTAtYWJjZC1lZjEyMzQ1Njc4OTAiLCJ1c2VybmFtZSI6ImhvbmdnaWxkb25nIiwiZW1haWwiOiJob25nQGV4YW1wbGUuY29tIiwiaWF0IjoxNzQyNDY1NjAwLCJleHAiOjE3NDMwNzA0MDB9.signature",
  "user": {
    "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "username": "honggildong",
    "email": "hong@example.com",
    "name": "홍길동",
    "isTempPassword": false
  }
}
```

필드 설명
```
accessToken      JWT 토큰 — 7일 유효, 이후 모든 인증 요청의 Authorization 헤더에 포함
isTempPassword   임시 비밀번호 여부 (Boolean)
                 — true: 비밀번호 찾기로 발급된 임시 비밀번호로 로그인한 상태
                         로그인 직후 비밀번호 변경 화면(1-5)으로 강제 이동 필요
                 — false: 정상 비밀번호 상태
```

에러 Response
```json
// 404 — 가입된 계정 없음
{ "statusCode": 404, "message": "가입된 계정이 없습니다. 회원가입 후 이용해주세요.", "error": "Not Found" }

// 401 — 비밀번호 불일치
{ "statusCode": 401, "message": "비밀번호가 일치하지 않습니다.", "error": "Unauthorized" }
```

---

### 1-3. 아이디 찾기

```
POST /auth/find-id
```

파라미터 (Body · application/json)
```
name    String  필수   가입 시 입력한 이름
email   String  필수   가입 이메일
```

호출 예시
```http
POST /auth/find-id
Content-Type: application/json

{
  "name": "홍길동",
  "email": "hong@example.com"
}
```

Response 200
```json
{
  "maskedUsername": "hong****g"
}
```

필드 설명
```
maskedUsername   마스킹된 아이디 (String)

마스킹 규칙:
  5자 이상: 앞 4자 + 중간 * + 마지막 1자
    예) honggildong  →  hong******g
    예) user1234     →  user***4

  4자 이하: 앞 2자 + 나머지 * 처리
    예) ab12  →  ab**
```

에러 Response
```json
// 404 — 이름 + 이메일 일치하는 계정 없음
{ "statusCode": 404, "message": "사용자 정보가 일치하지 않습니다", "error": "Not Found" }
```

---

### 1-4. 비밀번호 찾기 (임시 비밀번호 이메일 발송)

```
POST /auth/find-password
```

파라미터 (Body · application/json)
```
username   String  필수   로그인 아이디
email      String  필수   가입 이메일
```

호출 예시
```http
POST /auth/find-password
Content-Type: application/json

{
  "username": "honggildong",
  "email": "hong@example.com"
}
```

Response 200
```json
{
  "email": "hong@example.com"
}
```

필드 설명
```
email   임시 비밀번호를 발송한 이메일 주소
```

처리 흐름
```
1. username + email 일치 계정 조회
2. 12자리 임시 비밀번호 생성 (대문자 2 + 소문자 2 + 숫자 2 + 특수문자 2 + 랜덤 4, 셔플)
3. 임시 비밀번호 bcrypt 해시 후 DB 저장
4. isTempPassword = true 로 업데이트
5. 가입 이메일로 임시 비밀번호 발송
→ 로그인 후 반드시 비밀번호 변경(1-5) 필요
```

에러 Response
```json
// 404 — 아이디 + 이메일 일치하는 계정 없음
{ "statusCode": 404, "message": "입력하신 정보로 가입된 계정을 찾을 수 없습니다. 다시 확인해주세요.", "error": "Not Found" }
```

---

### 1-5. 비밀번호 변경 🔒

```
PATCH /auth/change-password
```

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

파라미터 (Body · application/json)
```
newPassword      String  필수   새 비밀번호, 8~50자
confirmPassword  String  필수   새 비밀번호 확인 — newPassword 와 동일해야 함
```

호출 예시
```http
PATCH /auth/change-password
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

{
  "newPassword": "newSecurePass1!",
  "confirmPassword": "newSecurePass1!"
}
```

Response 200
```json
{
  "message": "비밀번호가 변경되었습니다."
}
```

비고
```
성공 시 isTempPassword = false 로 초기화
임시 비밀번호로 로그인한 상태(isTempPassword=true)에서 이 API 호출 후 정상 이용 가능
```

에러 Response
```json
// 400 — newPassword / confirmPassword 불일치
{ "statusCode": 400, "message": "비밀번호가 일치하지 않습니다.", "error": "Bad Request" }

// 401 — 토큰 없음 또는 만료
{ "statusCode": 401, "message": "Unauthorized", "error": "Unauthorized" }
```

---

---

## 2. 이슈테마 API `/issue-theme`

인증: 불필요 (전체 공개)

종목 집계 기준: 정적 필터(passedStaticFilters=true) 통과 종목 중 동적 필터(DF) 3가지를 모두 통과한 종목만 사용
```
DF1   현재가 ≥ 52주 저가 × 1.3
DF2   현재가 ≥ 52주 고가 × 0.75
DF3   현재가 > 50일 이동평균
```

---

### 2-1. 테마 목록

```
GET /issue-theme
```

파라미터 (Query)
```
display   Number  선택   페이지당 항목 수, 기본값 20
page      Number  선택   페이지 번호, 기본값 1
```

호출 예시
```http
// 기본 조회 (1페이지, 20개)
GET /issue-theme

// 2페이지, 10개씩
GET /issue-theme?page=2&display=10
```

Response 200
```json
{
  "updatedAt": "2026-03-20T09:30:00.000Z",
  "total": 19,
  "page": 1,
  "display": 20,
  "themes": [
    {
      "themeCode": 5,
      "themeName": "건설",
      "rank": 1,
      "rankChange": 2,
      "totalCount": 12,
      "risingCount": 9,
      "risingRatio": 75.0,
      "avgChangeRate": 2.34,
      "upCount": 8,
      "flatCount": 3,
      "downCount": 1
    },
    {
      "themeCode": 12,
      "themeName": "2차전지",
      "rank": 2,
      "rankChange": -1,
      "totalCount": 18,
      "risingCount": 12,
      "risingRatio": 66.67,
      "avgChangeRate": 1.82,
      "upCount": 10,
      "flatCount": 5,
      "downCount": 3
    },
    {
      "themeCode": 7,
      "themeName": "반도체",
      "rank": 3,
      "rankChange": null,
      "totalCount": 24,
      "risingCount": 14,
      "risingRatio": 58.33,
      "avgChangeRate": 1.21,
      "upCount": 12,
      "flatCount": 8,
      "downCount": 4
    }
  ]
}
```

필드 설명 (최상단)
```
updatedAt   응답 생성 시각 (ISO8601 UTC)
total       전체 테마 수 (페이지 무관)
page        현재 페이지
display     페이지당 항목 수
```

필드 설명 (themes 항목)
```
themeCode      테마 코드 (Number)
themeName      테마명 (String)
rank           현재 순위 (Number) — 상승비율 내림차순, 동률 시 동일 순위 부여
rankChange     순위 변동 (Number | null)
               — 전일 순위 - 현재 순위, 양수=상승 / 음수=하락 / 0=동일
               — null: 전일 스냅샷 없음 (데이터 부족)
totalCount     필터 통과 종목 수 (Number)
risingCount    등락률 > 0% 종목 수 (Number) — 순위 계산 내부 기준
risingRatio    상승 비율 (Number, %, 소수 2자리) — 순위 산출 기준값
avgChangeRate  평균 등락률 (Number, %, 소수 2자리)
upCount        상승 종목 수 (Number) — 등락률 ≥ +1%
flatCount      보합 종목 수 (Number) — -1% ~ +1%
downCount      하락 종목 수 (Number) — 등락률 ≤ -1%
```

비고
```
등락률은 실시간 캐시(WebSocket 수신 데이터) 우선 사용, 없으면 전일 DB 종가 기준으로 대체
테마 데이터가 없을 경우: { "updatedAt": null, "total": 0, "page": 1, "display": 20, "themes": [] }
```

---

### 2-2. 테마 상세

```
GET /issue-theme/:themeCode
```

파라미터 (Path)
```
themeCode   Number  필수   테마 코드 (정수)
```

호출 예시
```http
// 건설 테마 (themeCode=5) 상세 조회
GET /issue-theme/5
```

Response 200
```json
{
  "themeCode": 5,
  "themeName": "건설",
  "rank": 1,
  "rankChange": 2,
  "risingCount": 9,
  "totalCount": 12,
  "insights": [
    "테마 내 상승 종목 비율 증가",
    "거래대금 급증 종목 증가",
    "평균 등락률 상승"
  ],
  "stocks": [
    {
      "rank": 1,
      "stockCode": "000720",
      "companyName": "현대건설",
      "currentPrice": 45000,
      "changeRate": 5.88,
      "rsScore": 92.5,
      "tradingValueRatio": "3.1배"
    },
    {
      "rank": 2,
      "stockCode": "047040",
      "companyName": "대우건설",
      "currentPrice": 5830,
      "changeRate": 3.45,
      "rsScore": 85.2,
      "tradingValueRatio": "1.8배"
    },
    {
      "rank": 3,
      "stockCode": "375500",
      "companyName": "DL이앤씨",
      "currentPrice": 38500,
      "changeRate": 2.13,
      "rsScore": 78.9,
      "tradingValueRatio": "-"
    }
  ],
  "updatedAt": "2026-03-20T09:30:00.000Z"
}
```

필드 설명 (상단)
```
rank           당일 스냅샷 기준 순위 (Number | null)
               — null: 당일 장중 조회로 아직 스냅샷 미저장 상태
rankChange     순위 변동 (Number | null) — 양수=상승, 음수=하락
risingCount    필터 통과 종목 중 상승 종목 수
totalCount     필터 통과 종목 수
insights       인사이트 문구 목록 (String[]) — 아래 발생 조건 참고, 해당 없으면 빈 배열 []
```

필드 설명 (stocks 항목)
```
rank               RS점수 기준 종목 순위 (1위가 최고 RS)
stockCode          종목 코드 (String, 6자리)
companyName        종목명 (String)
currentPrice       현재가 (Number) — 실시간 캐시 우선, 없으면 DB 종가
changeRate         등락률 (Number, %)
rsScore            RS(상대강도) 점수 (Number)
tradingValueRatio  전일 동시간 대비 거래대금 배율 (String)
                   — "N.N배": 전일 동시간 대비 배율
                   — "-": 전일 거래대금 데이터 없거나 100만원 이하로 비교 불가
```

인사이트 발생 조건
```
"테마 내 상승 종목 비율 증가"
  → 전일 스냅샷 대비 상승비율이 10%p 이상 증가 AND 현재 상승비율 ≥ 50%

"거래대금 급증 종목 증가"
  → 전일 동시간 대비 거래대금 2배 이상인 종목 수가 전일보다 2개 이상 증가

"평균 등락률 상승"
  → 테마 내 전체 종목 평균 등락률 ≥ 2%

"상위 종목 급등"
  → 테마 내 등락률 ≥ 7% 인 종목이 1개 이상 존재
```

에러 Response
```json
// 404 — 존재하지 않는 themeCode
{ "statusCode": 404, "message": "Theme 999 not found", "error": "Not Found" }
```

---

### 2-3. 관리용 엔드포인트 (수동 호출)

아래 3개는 스케줄러가 자동 실행하며, 필요 시 수동으로 직접 호출하는 관리용 엔드포인트입니다.

---

```
POST /issue-theme/sync-themes
```

키움 API 종목 리스트의 `upName` → `themes` 테이블 + `company.themeCode` 동기화
최초 1회 또는 테마 데이터 갱신 시 수동 호출

호출 예시
```http
POST /issue-theme/sync-themes
```

Response 201
```json
{
  "themesCreated": 3,
  "companiesUpdated": 142
}
```

필드 설명
```
themesCreated      신규 생성된 테마 수
companiesUpdated   themeCode가 업데이트된 종목(company) 수
```

---

```
POST /issue-theme/snapshot/theme
```

테마 일별 스냅샷 저장 (순위 · 상승비율 · 평균등락률 기록)
장 마감 후 1회 호출 (스케줄러: 평일 15:40 KST)

호출 예시
```http
POST /issue-theme/snapshot/theme
```

Response 201
```json
{
  "saved": 19,
  "date": "2026-03-20"
}
```

필드 설명
```
saved   저장된 테마 스냅샷 수
date    스냅샷 기준일 (YYYY-MM-DD)
```

---

```
POST /issue-theme/snapshot/trading-value
```

실시간 캐시의 누적 거래대금을 DB에 저장
장중 10분 단위 호출 (스케줄러: 09:00~15:30, 매 10분)

호출 예시
```http
POST /issue-theme/snapshot/trading-value
```

Response 201
```json
{
  "saved": 312,
  "time": "1030"
}
```

필드 설명
```
saved   저장된 종목 수
time    스냅샷 시각 (HHmm, 10분 단위 버킷 — 예: "1030", "1040")
```

---

---

## 3. 관심종목 API `/watchlist` 🔒

인증: 모든 엔드포인트 JWT 필요
요청 시 헤더에 `Authorization: Bearer <accessToken>` 포함 필수

---

### 3-1. 관심종목 현황 조회

```
GET /watchlist/stocks
```

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

Query 파라미터: 없음

호출 예시
```http
GET /watchlist/stocks
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Response 200 — 정상 (관심종목 있음)
```json
{
  "tradeDate": "2026-03-20T00:00:00.000Z",
  "stocks": [
    {
      "companyId": "123456",
      "stockCode": "005930",
      "companyName": "삼성전자",
      "marketType": "KOSPI",
      "addedDate": "2026-03-15T09:00:00.000Z",
      "memo": null,
      "closePrice": 72000,
      "priceChange1d": 900,
      "priceChangeRate1d": 1.27,
      "rank": 42,
      "prevRank": 50,
      "relativeStrengthScore": 87.5,
      "isNewHigh": false,
      "events": ["RANK_UP"]
    },
    {
      "companyId": "234567",
      "stockCode": "000660",
      "companyName": "SK하이닉스",
      "marketType": "KOSPI",
      "addedDate": "2026-03-10T09:00:00.000Z",
      "memo": null,
      "closePrice": 195000,
      "priceChange1d": -3000,
      "priceChangeRate1d": -1.52,
      "rank": 15,
      "prevRank": 15,
      "relativeStrengthScore": 94.2,
      "isNewHigh": false,
      "events": []
    },
    {
      "companyId": "345678",
      "stockCode": "247540",
      "companyName": "에코프로비엠",
      "marketType": "KOSDAQ",
      "addedDate": "2026-03-05T09:00:00.000Z",
      "memo": null,
      "closePrice": 112500,
      "priceChange1d": 8000,
      "priceChangeRate1d": 7.65,
      "rank": 8,
      "prevRank": 25,
      "relativeStrengthScore": 96.1,
      "isNewHigh": true,
      "events": ["NEW_HIGH", "RANK_UP"]
    }
  ]
}
```

Response 200 — 관심종목 없음
```json
{
  "tradeDate": null,
  "stocks": []
}
```

필드 설명 (최상단)
```
tradeDate   최신 거래일 (ISO8601 UTC | null)
            — null: 관심종목이 없거나 지표 데이터 없음
```

필드 설명 (stocks 항목)
```
companyId              종목 고유 ID (String)
stockCode              종목 코드 (String, 6자리)
companyName            종목명 (String)
marketType             시장 구분 (String) — "KOSPI" | "KOSDAQ"
addedDate              관심종목 등록일 (ISO8601 UTC)
memo                   메모 (String | null)
closePrice             종가 (Number | null) — 지표 데이터 없으면 null
priceChange1d          전일 대비 등락폭 (Number | null, 원)
priceChangeRate1d      전일 대비 등락률 (Number | null, %)
rank                   당일 RS 순위 (Number | null)
prevRank               전일 RS 순위 (Number | null)
relativeStrengthScore  RS 점수 (Number | null)
isNewHigh              신고가 여부 (Boolean)
events                 이벤트 목록 (String[]) — 해당 없으면 빈 배열 []
```

이벤트 종류
```
"NEW_HIGH"    당일 신고가 달성 (isNewHigh = true)
"RANK_UP"     전일 대비 순위 상승 (rank < prevRank)
"RANK_DOWN"   전일 대비 순위 하락 (rank > prevRank)
```

비고
```
응답 정렬: addedDate 내림차순 (최근 추가 종목이 맨 앞)
지표 데이터(rank, closePrice 등)는 최신 거래일 DB 기준
전일 지표가 없으면 prevRank = null, RANK_UP / RANK_DOWN 이벤트 미발생
```

에러 Response
```json
// 401 — 토큰 없음 또는 만료
{ "statusCode": 401, "message": "Unauthorized", "error": "Unauthorized" }
```

---

### 3-2. 관심종목 추가

```
POST /watchlist/stocks
```

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

파라미터 (Body · application/json)
```
stockCode   String  필수   종목 코드 (6자리, 예: "005930")
```

호출 예시
```http
POST /watchlist/stocks
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

{
  "stockCode": "005930"
}
```

Response 201
```json
{
  "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "companyId": "123456",
  "addedDate": "2026-03-20T09:15:00.000Z",
  "deletedAt": null,
  "memo": null,
  "company": {
    "stockCode": "005930",
    "companyName": "삼성전자",
    "marketType": "KOSPI"
  }
}
```

필드 설명
```
userId      현재 로그인 사용자 ID
companyId   추가된 종목의 고유 ID
addedDate   관심종목 등록일시 (ISO8601 UTC)
deletedAt   삭제일시 — 정상 등록 시 null
memo        메모 — 현재 미사용, null 고정
company     종목 기본 정보 (stockCode, companyName, marketType)
```

비고
```
이전에 삭제(DELETE)했던 종목을 재추가하면:
  → 신규 생성 대신 soft delete 복구 처리 (deletedAt = null, addedDate 현재 시각으로 갱신)
```

에러 Response
```json
// 401 — 토큰 없음 또는 만료
{ "statusCode": 401, "message": "Unauthorized", "error": "Unauthorized" }

// 404 — 존재하지 않는 종목 코드
{ "statusCode": 404, "message": "종목코드 999999를 찾을 수 없습니다", "error": "Not Found" }

// 409 — 이미 관심종목 등록된 종목
{ "statusCode": 409, "message": "이미 관심종목으로 등록된 종목입니다", "error": "Conflict" }
```

---

### 3-3. 관심종목 삭제

```
DELETE /watchlist/stocks/:stockCode
```

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

파라미터 (Path)
```
stockCode   String  필수   삭제할 종목 코드 (6자리)
```

호출 예시
```http
DELETE /watchlist/stocks/005930
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Response 200
```json
{
  "message": "관심종목에서 삭제되었습니다",
  "stockCode": "005930"
}
```

비고
```
Soft delete 처리 — DB에서 완전 삭제되지 않고 deletedAt 시각만 기록
삭제 후 동일 종목을 다시 추가(3-2)하면 복구 처리됨
```

에러 Response
```json
// 401 — 토큰 없음 또는 만료
{ "statusCode": 401, "message": "Unauthorized", "error": "Unauthorized" }

// 404 — 존재하지 않는 종목 코드
{ "statusCode": 404, "message": "종목코드 999999를 찾을 수 없습니다", "error": "Not Found" }

// 404 — 관심종목에 등록되지 않은 종목
{ "statusCode": 404, "message": "관심종목에 등록되지 않은 종목입니다", "error": "Not Found" }
```

---

### 3-4. 관심테마 현황 조회

```
GET /watchlist/themes
```

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

호출 예시
```http
GET /watchlist/themes
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Response 200
```json
{
  "themes": [
    {
      "themeCode": 5,
      "themeName": "건설",
      "imageUrl": null,
      "addedDate": "2026-03-15T09:00:00.000Z",
      "rank": 1,
      "prevRank": 3,
      "risingCount": 9,
      "totalCount": 12,
      "upCount": 8,
      "flatCount": 3,
      "downCount": 1,
      "event": "테마 순위가 3 → 1으로 상승했어요.(+2)"
    },
    {
      "themeCode": 12,
      "themeName": "2차전지",
      "imageUrl": null,
      "addedDate": "2026-03-10T09:00:00.000Z",
      "rank": 2,
      "prevRank": 2,
      "risingCount": 12,
      "totalCount": 18,
      "upCount": 10,
      "flatCount": 5,
      "downCount": 3,
      "event": "-"
    }
  ]
}
```

필드 설명 (themes 항목)
```
themeCode     테마 코드 (Number)
themeName     테마명 (String)
imageUrl      테마 이미지 URL (String | null)
addedDate     관심테마 등록일 (ISO8601 UTC)
rank          당일 순위 (Number | null) — 스냅샷 기준, 없으면 null
prevRank      전일 순위 (Number | null)
risingCount   등락률 > 0% 종목 수 (Number | null)
totalCount    필터 통과 전체 종목 수 (Number | null)
upCount       상승 종목 수 (Number | null) — 등락률 ≥ +1%
flatCount     보합 종목 수 (Number | null) — -1% ~ +1%
downCount     하락 종목 수 (Number | null) — 등락률 ≤ -1%
event         순위 변동 이벤트 문구 (String)
              — "테마 순위가 N → M으로 상승했어요.(+X)"
              — "테마 순위가 N → M으로 하락했어요.(X)"
              — "-": 순위 변동 없거나 전일 스냅샷 없음
```

비고
```
응답 정렬: 테마명 가나다순
upCount + flatCount + downCount = totalCount 항상 성립
스냅샷 데이터 없으면 rank, prevRank, risingCount, totalCount, upCount, flatCount, downCount 모두 null
```

에러 Response
```json
// 401 — 토큰 없음 또는 만료
{ "statusCode": 401, "message": "Unauthorized", "error": "Unauthorized" }
```

---

### 3-5. 관심테마 추가

```
POST /watchlist/themes
```

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

파라미터 (Body · application/json)
```
themeCode   Number  필수   테마 코드 (정수)
```

호출 예시
```http
POST /watchlist/themes
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

{
  "themeCode": 5
}
```

Response 201
```json
{
  "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "themeCode": 5,
  "addedDate": "2026-03-20T09:15:00.000Z",
  "deletedAt": null,
  "theme": {
    "themeName": "건설"
  }
}
```

에러 Response
```json
// 404 — 존재하지 않는 테마 코드
{ "statusCode": 404, "message": "테마코드 999를 찾을 수 없습니다", "error": "Not Found" }

// 409 — 이미 관심테마 등록됨
{ "statusCode": 409, "message": "이미 관심테마로 등록된 테마입니다", "error": "Conflict" }
```

---

### 3-6. 관심테마 삭제

```
DELETE /watchlist/themes/:themeCode
```

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

파라미터 (Path)
```
themeCode   Number  필수   삭제할 테마 코드 (정수)
```

호출 예시
```http
DELETE /watchlist/themes/5
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Response 200
```json
{
  "message": "관심테마에서 삭제되었습니다",
  "themeCode": 5
}
```

에러 Response
```json
// 404 — 존재하지 않는 테마 코드
{ "statusCode": 404, "message": "테마코드 999를 찾을 수 없습니다", "error": "Not Found" }

// 404 — 관심테마에 등록되지 않은 테마
{ "statusCode": 404, "message": "관심테마에 등록되지 않은 테마입니다", "error": "Not Found" }
```

---

---

## 4. 내 관심 페이지 API `/watchlist` 🔒

인증: 모든 엔드포인트 JWT 필요

---

### 4-1. 오늘 주목해야 할 내 관심항목 Top5

```
GET /watchlist/highlights
```

관심테마 중 순위 상위 2개 + 관심종목 중 RS 순위 상위 3개를 합산해 반환

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

호출 예시
```http
GET /watchlist/highlights
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Response 200
```json
{
  "highlights": [
    {
      "type": "THEME",
      "themeCode": 5,
      "themeName": "건설",
      "imageUrl": null,
      "rank": 1,
      "risingCount": 9,
      "totalCount": 12
    },
    {
      "type": "THEME",
      "themeCode": 12,
      "themeName": "2차전지",
      "imageUrl": null,
      "rank": 2,
      "risingCount": 12,
      "totalCount": 18
    },
    {
      "type": "STOCK",
      "companyId": "345678",
      "stockCode": "247540",
      "companyName": "에코프로비엠",
      "marketType": "KOSDAQ",
      "rank": 8,
      "closePrice": 112500,
      "priceChangeRate1d": 7.65,
      "relativeStrengthScore": 96.1
    },
    {
      "type": "STOCK",
      "companyId": "234567",
      "stockCode": "000660",
      "companyName": "SK하이닉스",
      "marketType": "KOSPI",
      "rank": 15,
      "closePrice": 195000,
      "priceChangeRate1d": -1.52,
      "relativeStrengthScore": 94.2
    },
    {
      "type": "STOCK",
      "companyId": "123456",
      "stockCode": "005930",
      "companyName": "삼성전자",
      "marketType": "KOSPI",
      "rank": 42,
      "closePrice": 72000,
      "priceChangeRate1d": 1.27,
      "relativeStrengthScore": 87.5
    }
  ]
}
```

필드 설명 (highlights 항목 — THEME)
```
type          "THEME" 고정
themeCode     테마 코드 (Number)
themeName     테마명 (String)
imageUrl      테마 이미지 URL (String | null)
rank          당일 순위 (Number | null)
risingCount   등락률 > 0% 종목 수 (Number | null)
totalCount    필터 통과 전체 종목 수 (Number | null)
```

필드 설명 (highlights 항목 — STOCK)
```
type                   "STOCK" 고정
companyId              종목 고유 ID (String)
stockCode              종목 코드 (String, 6자리)
companyName            종목명 (String)
marketType             시장 구분 — "KOSPI" | "KOSDAQ"
rank                   당일 RS 순위 (Number | null)
closePrice             종가 (Number | null)
priceChangeRate1d      전일 대비 등락률 (Number | null, %)
relativeStrengthScore  RS 점수 (Number | null)
```

비고
```
순서: THEME 2개(rank 오름차순) → STOCK 3개(rank 오름차순)
관심테마/관심종목이 없으면 해당 타입 항목 수 감소 (최대 5개)
지표/스냅샷 데이터 없으면 rank, closePrice 등 null
```

---

### 4-2. 내 관심 통합 목록

```
GET /watchlist/my
```

관심테마 + 관심종목을 addedDate 내림차순으로 합산 반환

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

호출 예시
```http
GET /watchlist/my
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Response 200
```json
{
  "items": [
    {
      "type": "STOCK",
      "companyId": "345678",
      "stockCode": "247540",
      "companyName": "에코프로비엠",
      "marketType": "KOSDAQ",
      "addedDate": "2026-03-20T09:00:00.000Z",
      "closePrice": 112500,
      "priceChangeRate1d": 7.65
    },
    {
      "type": "THEME",
      "themeCode": 5,
      "themeName": "건설",
      "imageUrl": null,
      "addedDate": "2026-03-15T09:00:00.000Z",
      "risingCount": 9,
      "totalCount": 12,
      "upCount": 8,
      "flatCount": 3,
      "downCount": 1
    }
  ]
}
```

필드 설명 (items 항목 — STOCK)
```
type               "STOCK" 고정
companyId          종목 고유 ID (String)
stockCode          종목 코드 (String, 6자리)
companyName        종목명 (String)
marketType         시장 구분 — "KOSPI" | "KOSDAQ"
addedDate          관심종목 등록일 (ISO8601 UTC)
closePrice         종가 (Number | null)
priceChangeRate1d  전일 대비 등락률 (Number | null, %)
```

필드 설명 (items 항목 — THEME)
```
type          "THEME" 고정
themeCode     테마 코드 (Number)
themeName     테마명 (String)
imageUrl      테마 이미지 URL (String | null)
addedDate     관심테마 등록일 (ISO8601 UTC)
risingCount   등락률 > 0% 종목 수 (Number | null)
totalCount    필터 통과 전체 종목 수 (Number | null)
upCount       상승 종목 수 (Number | null) — 등락률 ≥ +1%
flatCount     보합 종목 수 (Number | null) — -1% ~ +1%
downCount     하락 종목 수 (Number | null) — 등락률 ≤ -1%
```

비고
```
응답 정렬: addedDate 내림차순 (최근 추가 항목이 맨 앞)
THEME/STOCK 혼합 정렬
upCount + flatCount + downCount = totalCount 항상 성립
스냅샷 데이터 없으면 risingCount, totalCount, upCount, flatCount, downCount 모두 null
```

---

### 4-3. 함께 보면 좋을 만한 종목·테마 추천

```
GET /watchlist/recommendations
```

테마 추천 1개 + 종목 추천 1개 반환

파라미터 (Header)
```
Authorization   String  필수   Bearer <accessToken>
```

호출 예시
```http
GET /watchlist/recommendations
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Response 200
```json
{
  "recommendedTheme": {
    "reason": "1순위",
    "type": "THEME",
    "themeCode": 7,
    "themeName": "반도체",
    "imageUrl": null,
    "rank": 3,
    "prevRank": 5,
    "risingCount": 14,
    "totalCount": 24,
    "upCount": 12,
    "flatCount": 8,
    "downCount": 4
  },
  "recommendedStock": {
    "reason": "1순위",
    "type": "STOCK",
    "companyId": "456789",
    "stockCode": "000660",
    "companyName": "SK하이닉스",
    "marketType": "KOSPI",
    "rank": 15,
    "closePrice": 195000,
    "priceChangeRate1d": 3.45,
    "relativeStrengthScore": 94.2,
    "events": ["RANK_UP", "TREND_TEMPLATE"]
  }
}
```

필드 설명 (recommendedTheme)
```
reason        추천 선정 근거 — "1순위" | "2순위" (아래 추천 로직 참고)
type          "THEME" 고정
themeCode     테마 코드 (Number)
themeName     테마명 (String)
imageUrl      테마 이미지 URL (String | null)
rank          당일 순위 (Number | null)
prevRank      전일 순위 (Number | null)
risingCount   등락률 > 0% 종목 수 (Number | null)
totalCount    필터 통과 전체 종목 수 (Number | null)
upCount       상승 종목 수 (Number | null) — 등락률 ≥ +1%
flatCount     보합 종목 수 (Number | null) — -1% ~ +1%
downCount     하락 종목 수 (Number | null) — 등락률 ≤ -1%
```

필드 설명 (recommendedStock)
```
reason                 추천 선정 근거 — "1순위" | "2순위"
type                   "STOCK" 고정
companyId              종목 고유 ID (String)
stockCode              종목 코드 (String, 6자리)
companyName            종목명 (String)
marketType             시장 구분 — "KOSPI" | "KOSDAQ"
rank                   당일 RS 순위 (Number)
closePrice             종가 (Number)
priceChangeRate1d      전일 대비 등락률 (Number | null, %)
relativeStrengthScore  RS 점수 (Number)
events                 이벤트 목록 (String[]) — 해당 없으면 빈 배열 []
```

이벤트 종류 (events)
```
"NEW_HIGH"               당일 신고가 달성
"VOLATILITY_CONTRACTION" 변동성 수축 패턴
"PRICE_COMPRESSION"      가격 압축 패턴
"TREND_TEMPLATE"         트렌드 템플릿 조건 충족
"RANK_UP"                전일 대비 순위 상승
"RANK_DOWN"              전일 대비 순위 하락
```

추천 로직
```
[테마 추천]
1순위: 내 관심종목이 속한 테마 중 관심테마에 없는 것 → 당일 순위 가장 높은 1개
2순위: 당일 Top10 테마 중 관심테마 제외 → 날짜 기반 시드로 매일 다르게 1개

[종목 추천]
1순위: 내 관심테마에 속한 종목 중 관심종목 제외 → RS 상위 Top5 중 날짜 기반 시드로 1개
2순위: 당일 Top10 종목 중 관심종목 제외 → 날짜 기반 시드로 매일 다르게 1개
```

비고
```
관심테마/관심종목이 없어 추천 불가 시 해당 필드 null 반환
  예) { "recommendedTheme": null, "recommendedStock": { ... } }
```
