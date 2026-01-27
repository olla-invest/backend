# Kiwoom Investment System

키움증권 API를 활용한 주식 정보 실시간 차트 시스템

## 기술 스택

- **Backend**: NestJS, TypeScript, Prisma
- **Database**: PostgreSQL 18
- **Cache**: Redis Stack
- **Package Manager**: pnpm

## 시작하기

### 1. Prerequisites

```bash
# Docker 설치 확인
docker --version
docker-compose --version

# pnpm 설치 확인
pnpm --version
```

### 2. Docker 컨테이너 실행

#### PostgreSQL 실행

```bash
# Linux/Mac
cd docker/postgresql
chmod +x start.sh
./start.sh

# Windows
cd docker/postgresql
start.bat

# 또는 직접 실행
cd docker/postgresql
docker-compose up -d
```

#### Redis 실행

```bash
# Linux/Mac
cd docker/redis
chmod +x start.sh
./start.sh

# Windows
cd docker/redis
start.bat

# 또는 직접 실행
cd docker/redis
docker-compose up -d
```

### 3. 환경 변수 설정

`.env` 파일이 자동으로 생성되어 있습니다. 필요시 수정하세요.

```env
DATABASE_URL="postgresql://kiwoom_user:kiwoom@2026@localhost:15432/investment_db?schema=public"
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=kiwoom@redis2026
PORT=3000
NODE_ENV=development
```

### 4. 의존성 설치

```bash
pnpm install
```

### 5. 데이터베이스 마이그레이션

```bash
# Prisma Client 생성
pnpm prisma:generate

# 마이그레이션 실행
pnpm prisma:migrate
```

### 6. 개발 서버 실행

```bash
pnpm start:dev
```

애플리케이션이 http://localhost:3000 에서 실행됩니다.

## Docker 서비스

### PostgreSQL

- **Host**: localhost
- **Port**: 15432
- **Database**: investment_db
- **User**: kiwoom_user
- **Password**: kiwoom@2026

### Redis Stack

- **Host**: localhost
- **Port**: 6379
- **Password**: kiwoom@redis2026
- **Redis Insight**: http://localhost:8001

## 유용한 명령어

### Docker

```bash
# PostgreSQL 관리
cd docker/postgresql
docker-compose ps              # 상태 확인
docker-compose logs -f         # 로그 확인
docker-compose down            # 중지
docker-compose down -v         # 중지 및 볼륨 삭제

# Redis 관리
cd docker/redis
docker-compose ps              # 상태 확인
docker-compose logs -f         # 로그 확인
docker-compose down            # 중지
docker-compose down -v         # 중지 및 볼륨 삭제

# Redis CLI 접속
docker exec -it kiwoom-redis redis-cli -a kiwoom@redis2026
```

### Prisma

```bash
# Prisma Client 생성
pnpm prisma:generate

# 마이그레이션
pnpm prisma:migrate

# Prisma Studio 실행 (DB GUI)
pnpm prisma:studio
```

### 린팅 & 포맷팅

```bash
# 코드 포맷팅
pnpm format

# ESLint 실행
pnpm lint
```

## 프로젝트 구조

```
kiwoom/
├── docker/
│   ├── postgresql/
│   │   ├── docker-compose.yml  # PostgreSQL 구성
│   │   ├── start.sh           # 실행 스크립트 (Linux/Mac)
│   │   └── start.bat          # 실행 스크립트 (Windows)
│   └── redis/
│       ├── docker-compose.yml  # Redis 구성
│       ├── redis.conf         # Redis 설정
│       ├── start.sh           # 실행 스크립트 (Linux/Mac)
│       └── start.bat          # 실행 스크립트 (Windows)
├── prisma/
│   └── schema.prisma          # Prisma 스키마
├── src/
│   ├── common/
│   │   ├── prisma/           # Prisma 모듈
│   │   └── redis/            # Redis 모듈
│   ├── modules/
│   │   ├── users/            # 사용자 관리
│   │   ├── companies/        # 종목 정보
│   │   ├── watchlist/        # 관심종목
│   │   ├── tags/             # 태그 관리
│   │   ├── stocks/           # 주가 히스토리
│   │   └── market/           # 시장 지수
│   ├── app.module.ts
│   └── main.ts
└── .env                       # 환경 변수
```

## 코드 스타일

- **Quotes**: Single quotes (`'`)
- **Tab Width**: 4 spaces
- **Bracket Spacing**: `{ foo: bar }`, `( param )`, `[ array ]`
- **Semicolons**: Always

## License

ISC
