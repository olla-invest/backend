import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { Prisma, AdminAuditAction } from '../../../generated/prisma';
import { PrismaService } from '../../common/prisma/prisma.service';
import { extractClientInfo } from './utils/client-info.util';

export interface RecordAuditParams {
    adminId: string;
    action: AdminAuditAction;
    targetUserId?: string | null;
    targetScope?: string | null;
    before?: Prisma.InputJsonValue | null;
    after?: Prisma.InputJsonValue | null;
    reason?: string | null;
    success?: boolean;
    failureCode?: string | null;
    request?: Request;
}

/**
 * 운영 감사 로그 (기획서 5.4)
 *
 * 개인정보 원문과 비밀번호·재설정 토큰은 절대 기록하지 않는다.
 * 기록 실패가 본 작업을 실패시키지 않도록 예외는 삼킨 뒤 로그만 남긴다.
 */
@Injectable()
export class AdminAuditService {
    private readonly logger = new Logger( AdminAuditService.name );

    constructor( private readonly prisma: PrismaService ) {}

    async record( params: RecordAuditParams ): Promise<void> {
        const client = params.request ? extractClientInfo( params.request ) : null;

        try {
            await this.prisma.adminAuditLog.create( {
                data: {
                    adminId: params.adminId,
                    action: params.action,
                    targetUserId: params.targetUserId ?? null,
                    targetScope: params.targetScope ?? null,
                    beforeValue: params.before ?? Prisma.DbNull,
                    afterValue: params.after ?? Prisma.DbNull,
                    reason: params.reason ?? null,
                    success: params.success ?? true,
                    failureCode: params.failureCode ?? null,
                    ipAddress: client?.ipAddress ?? null,
                    userAgent: client?.userAgent ?? null,
                },
            } );
        } catch ( error ) {
            this.logger.error(
                `감사 로그 기록 실패 (action=${ params.action }, admin=${ params.adminId })`,
                error instanceof Error ? error.stack : String( error ),
            );
        }
    }

    /** 회원 상세 화면에 노출할 감사 로그를 최신순으로 조회한다. */
    async findByTargetUser( userId: string, limit = 20 ) {
        const logs = await this.prisma.adminAuditLog.findMany( {
            where: { targetUserId: userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: { admin: { select: { loginId: true, name: true } } },
        } );

        return logs.map( ( log ) => ( {
            logId: log.logId,
            createdAt: log.createdAt,
            adminLoginId: log.admin.loginId,
            adminName: log.admin.name,
            action: log.action,
            description: describeAuditLog( log.action, log.beforeValue, log.afterValue, log.reason ),
            reason: log.reason,
            success: log.success,
        } ) );
    }
}

const ACTION_LABELS: Record<AdminAuditAction, string> = {
    LOGIN: '관리자 로그인',
    USER_DETAIL_VIEW: '회원 상세 조회',
    USER_LIST_EXPORT: '회원 목록 CSV 다운로드',
    USER_UNMASK: '개인정보 마스킹 해제',
    USER_PLAN_CHANGE: '플랜변경',
    USER_STATUS_CHANGE: '상태변경',
    USER_PASSWORD_RESET: '비밀번호 초기화',
    USER_PROFILE_UPDATE: '회원정보 수정',
    DASHBOARD_EXPORT: '서비스 현황 CSV 다운로드',
};

/**
 * 감사 로그 표기 문구 (기획서 8.6)
 * - 개인정보 마스킹 해제 (사유 : CS 문의 대응)
 * - 플랜변경 (변경 전 플랜) → (변경 후 플랜)
 * - 상태변경 (변경 전 상태) → (변경 후 상태)
 * - 비밀번호 초기화 (사유: ...)
 */
export function describeAuditLog(
    action: AdminAuditAction,
    before: Prisma.JsonValue | null,
    after: Prisma.JsonValue | null,
    reason: string | null,
): string {
    const label = ACTION_LABELS[ action ] ?? action;

    if ( action === AdminAuditAction.USER_PLAN_CHANGE || action === AdminAuditAction.USER_STATUS_CHANGE ) {
        const from = readValue( before );
        const to = readValue( after );
        if ( from && to ) {
            return `${ label } (${ from }) → (${ to })`;
        }
    }

    if ( reason ) {
        return `${ label } (사유 : ${ reason })`;
    }

    return label;
}

function readValue( value: Prisma.JsonValue | null ): string | null {
    if ( value === null || value === undefined ) {
        return null;
    }
    if ( typeof value === 'string' ) {
        return value;
    }
    if ( typeof value === 'object' && !Array.isArray( value ) ) {
        const record = value as Record<string, unknown>;
        const first = record.planType ?? record.status ?? Object.values( record )[ 0 ];
        return first === undefined || first === null ? null : String( first );
    }

    return String( value );
}
