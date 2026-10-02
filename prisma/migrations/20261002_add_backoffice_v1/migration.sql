-- 백오피스 v1: 관리자 계정, 계정 상태, 로그인/플랜 이력, 운영 감사 로그

-- 1. Enums
CREATE TYPE "admin_role_enum" AS ENUM ('SUPER_ADMIN', 'OPERATOR', 'VIEWER');
CREATE TYPE "user_status_enum" AS ENUM ('ACTIVE', 'INACTIVE', 'DORMANT', 'DELETED');
CREATE TYPE "admin_audit_action_enum" AS ENUM (
    'LOGIN',
    'USER_DETAIL_VIEW',
    'USER_LIST_EXPORT',
    'USER_UNMASK',
    'USER_PLAN_CHANGE',
    'USER_STATUS_CHANGE',
    'USER_PASSWORD_RESET',
    'USER_PROFILE_UPDATE',
    'DASHBOARD_EXPORT'
);

-- 2. users.status 추가 후 기존 데이터 보정
ALTER TABLE "users" ADD COLUMN "status" "user_status_enum" NOT NULL DEFAULT 'ACTIVE';
UPDATE "users" SET "status" = 'DELETED' WHERE "deleted_at" IS NOT NULL;
CREATE INDEX "idx_users_status" ON "users" ( "status" );

-- 3. 관리자 계정
CREATE TABLE "admins" (
    "admin_id" UUID NOT NULL,
    "login_id" VARCHAR(50) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "role" "admin_role_enum" NOT NULL DEFAULT 'VIEWER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "admins_pkey" PRIMARY KEY ( "admin_id" )
);
CREATE UNIQUE INDEX "uk_admins_login_id" ON "admins" ( "login_id", "deleted_at" );
CREATE INDEX "idx_admins_deleted_at" ON "admins" ( "deleted_at" );

-- 4. 회원 로그인 이력
CREATE TABLE "user_login_histories" (
    "history_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "auth_provider_enum" NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "device_type" VARCHAR(20),
    "os_name" VARCHAR(30),
    "logged_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_login_histories_pkey" PRIMARY KEY ( "history_id" )
);
CREATE INDEX "idx_login_history_user" ON "user_login_histories" ( "user_id", "logged_in_at" DESC );
ALTER TABLE "user_login_histories"
    ADD CONSTRAINT "user_login_histories_user_id_fkey"
    FOREIGN KEY ( "user_id" ) REFERENCES "users" ( "user_id" ) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. 회원 플랜 이력
CREATE TABLE "user_plan_histories" (
    "history_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "from_plan" "plan_type_enum",
    "to_plan" "plan_type_enum" NOT NULL,
    "reason" TEXT,
    "changed_by_admin_id" UUID,
    "note" VARCHAR(100),
    "effective_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_plan_histories_pkey" PRIMARY KEY ( "history_id" )
);
CREATE INDEX "idx_plan_history_user" ON "user_plan_histories" ( "user_id", "effective_at" DESC );
ALTER TABLE "user_plan_histories"
    ADD CONSTRAINT "user_plan_histories_user_id_fkey"
    FOREIGN KEY ( "user_id" ) REFERENCES "users" ( "user_id" ) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_plan_histories"
    ADD CONSTRAINT "user_plan_histories_changed_by_admin_id_fkey"
    FOREIGN KEY ( "changed_by_admin_id" ) REFERENCES "admins" ( "admin_id" ) ON DELETE SET NULL ON UPDATE CASCADE;

-- 기존 회원의 최초 플랜 부여 이력 백필
INSERT INTO "user_plan_histories" ( "history_id", "user_id", "from_plan", "to_plan", "note", "effective_at", "created_at" )
SELECT gen_random_uuid(), "user_id", NULL, "plan_type", '가입 시 기본 부여', "created_at", "created_at"
FROM "users";

-- 6. 운영 감사 로그
CREATE TABLE "admin_audit_logs" (
    "log_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "action" "admin_audit_action_enum" NOT NULL,
    "target_user_id" UUID,
    "target_scope" VARCHAR(300),
    "before_value" JSONB,
    "after_value" JSONB,
    "reason" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "failure_code" VARCHAR(50),
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ( "log_id" )
);
CREATE INDEX "idx_audit_target_user" ON "admin_audit_logs" ( "target_user_id", "created_at" DESC );
CREATE INDEX "idx_audit_admin" ON "admin_audit_logs" ( "admin_id", "created_at" DESC );
CREATE INDEX "idx_audit_action" ON "admin_audit_logs" ( "action" );
ALTER TABLE "admin_audit_logs"
    ADD CONSTRAINT "admin_audit_logs_admin_id_fkey"
    FOREIGN KEY ( "admin_id" ) REFERENCES "admins" ( "admin_id" ) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_audit_logs"
    ADD CONSTRAINT "admin_audit_logs_target_user_id_fkey"
    FOREIGN KEY ( "target_user_id" ) REFERENCES "users" ( "user_id" ) ON DELETE SET NULL ON UPDATE CASCADE;
