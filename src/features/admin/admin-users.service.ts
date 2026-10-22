import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import {
    AdminAuditAction,
    AdminRole,
    Prisma,
    UserStatus,
} from '../../../generated/prisma';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { AdminAuditService } from './admin-audit.service';
import { AuthenticatedAdmin } from './decorators/current-admin.decorator';
import { AdminUserListQuery } from './dto/admin-user-list.query';
import {
    BulkChangeUserStatusDto,
    ChangeUserPlanDto,
    ChangeUserStatusDto,
    ResetUserPasswordDto,
    UnmaskUserDto,
    UpdateUserProfileDto,
} from './dto/admin-user-actions.dto';
import {
    maskEmail,
    maskIpAddress,
    maskName,
    maskPhone,
    normalizePhone,
} from './utils/masking.util';

const ACTIVITY_WINDOW_DAYS = 30;
const LOGIN_HISTORY_LIMIT = 5;
const EXPORT_ROW_LIMIT = 50_000;

/** VIEWER 는 조회만 가능하고 개인정보 원문 열람과 운영 액션은 수행할 수 없다. */
const OPERATOR_ROLES: AdminRole[] = [ AdminRole.SUPER_ADMIN, AdminRole.OPERATOR ];

@Injectable()
export class AdminUsersService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly auditService: AdminAuditService,
        private readonly emailService: EmailService,
    ) {}

    // =============================================
    // 회원 목록
    // =============================================

    async list( query: AdminUserListQuery ) {
        const page = query.page ?? 1;
        const pageSize = query.pageSize ?? 10;
        const where = this.buildListWhere( query );

        const [ totalCount, users ] = await Promise.all( [
            this.prisma.user.count( { where } ),
            this.prisma.user.findMany( {
                where,
                orderBy: { [ query.sortBy ?? 'createdAt' ]: query.sortOrder ?? 'desc' },
                skip: ( page - 1 ) * pageSize,
                take: pageSize,
            } ),
        ] );

        return {
            users: users.map( ( user ) => this.toListRow( user ) ),
            page,
            pageSize,
            totalCount,
            totalPages: Math.max( 1, Math.ceil( totalCount / pageSize ) ),
        };
    }

    /**
     * 목록 CSV. 화면과 동일한 마스킹 값으로 내보내고, 다운로드 사실을 감사 로그에 남긴다.
     * 탈퇴일시 컬럼은 '삭제 계정 포함' 조회일 때만 추가한다.
     */
    async exportCsv( admin: AuthenticatedAdmin, query: AdminUserListQuery, request: Request ) {
        const where = this.buildListWhere( query );
        const users = await this.prisma.user.findMany( {
            where,
            orderBy: { [ query.sortBy ?? 'createdAt' ]: query.sortOrder ?? 'desc' },
            take: EXPORT_ROW_LIMIT,
        } );

        const includeDeleted = query.includeDeleted === true;
        const header = [ 'ID', '이메일', '이름', '전화번호', '가입경로', '플랜', '상태', '가입일시' ];
        if ( includeDeleted ) {
            header.push( '탈퇴일시' );
        }

        const rows = users.map( ( user ) => {
            const row = [
                user.username,
                maskEmail( user.email ) ?? '',
                maskName( user.name ) ?? '',
                maskPhone( user.phone ) ?? '',
                user.provider,
                user.planType,
                user.status,
                formatDateTime( user.createdAt ),
            ];
            if ( includeDeleted ) {
                row.push( user.deletedAt ? formatDateTime( user.deletedAt ) : '' );
            }
            return row;
        } );

        await this.auditService.record( {
            adminId: admin.adminId,
            action: AdminAuditAction.USER_LIST_EXPORT,
            targetScope: `회원 목록 ${ users.length }건 / 조건: ${ JSON.stringify( query ) }`.slice( 0, 300 ),
            request,
        } );

        return {
            filename: `olla-members-${ formatDateOnly( new Date() ) }.csv`,
            content: toCsv( [ header, ...rows ] ),
            rowCount: users.length,
            truncated: users.length >= EXPORT_ROW_LIMIT,
        };
    }

    private buildListWhere( query: AdminUserListQuery ): Prisma.UserWhereInput {
        const where: Prisma.UserWhereInput = {};

        if ( !query.includeDeleted ) {
            where.deletedAt = null;
        }
        if ( query.userIds?.length ) {
            where.userId = { in: query.userIds };
        }
        if ( query.provider ) {
            where.provider = query.provider;
        }
        if ( query.planType ) {
            where.planType = query.planType;
        }
        if ( query.status ) {
            where.status = query.status;
        }

        const createdAt = buildDateRange( query.joinedFrom, query.joinedTo );
        if ( createdAt ) {
            where.createdAt = createdAt;
        }

        // 검색은 마스킹된 값이 아니라 DB 원문 기준 부분 일치로 수행한다 (기획서 10.5)
        const keyword = query.search?.trim();
        if ( keyword ) {
            const digitsOnly = keyword.replace( /\D/g, '' );
            where.OR = [
                { username: { contains: keyword, mode: 'insensitive' } },
                { email: { contains: keyword, mode: 'insensitive' } },
                { name: { contains: keyword, mode: 'insensitive' } },
                { phone: { contains: keyword } },
                ...( digitsOnly.length >= 4 ? [ { phone: { contains: digitsOnly } } ] : [] ),
            ];
        }

        return where;
    }

    private toListRow( user: UserRecord ) {
        return {
            userId: user.userId,
            username: user.username,
            email: maskEmail( user.email ),
            name: maskName( user.name ),
            phone: maskPhone( user.phone ),
            provider: user.provider,
            planType: user.planType,
            status: user.status,
            createdAt: user.createdAt,
            deletedAt: user.deletedAt,
        };
    }

    // =============================================
    // 회원 상세
    // =============================================

    async detail( admin: AuthenticatedAdmin, userId: string, request: Request ) {
        const user = await this.findUserOrThrow( userId );
        const since = daysAgo( ACTIVITY_WINDOW_DAYS );

        const [ loginHistories, planHistories, auditLogs, activitySummary, subscription ] = await Promise.all( [
            this.prisma.userLoginHistory.findMany( {
                where: { userId },
                orderBy: { loggedInAt: 'desc' },
                take: LOGIN_HISTORY_LIMIT,
            } ),
            this.prisma.userPlanHistory.findMany( {
                where: { userId },
                orderBy: { effectiveAt: 'desc' },
                include: { admin: { select: { loginId: true, name: true } } },
            } ),
            this.auditService.findByTargetUser( userId ),
            this.buildActivitySummary( userId, since ),
            this.prisma.userSubscription.findUnique( { where: { userId }, select: { nextBillingDate: true } } ),
        ] );

        await this.auditService.record( {
            adminId: admin.adminId,
            action: AdminAuditAction.USER_DETAIL_VIEW,
            targetUserId: userId,
            request,
        } );

        return {
            userId: user.userId,
            username: user.username,
            name: maskName( user.name ),
            status: user.status,
            planType: user.planType,
            // 플랜 변경 시작일(다음 결제일). 없으면 변경 즉시 적용된다.
            nextBillingDate: subscription?.nextBillingDate ?? null,
            basicInfo: {
                email: maskEmail( user.email ),
                phone: maskPhone( user.phone ),
                provider: user.provider,
                createdAt: user.createdAt,
                lastLoginAt: loginHistories[ 0 ]?.loggedInAt ?? null,
                marketingConsent: user.marketingConsent,
                // [확인 필요] 마케팅 수신 동의 시각을 별도 저장하지 않아 최종 수정 시각으로 대체한다.
                marketingConsentAt: user.updatedAt,
                masked: true,
            },
            activitySummary,
            loginHistories: loginHistories.map( ( history ) => ( {
                loggedInAt: history.loggedInAt,
                provider: history.provider,
                ipAddress: maskIpAddress( history.ipAddress ),
                device: [ history.deviceType, history.osName ].filter( Boolean ).join( ' · ' ) || null,
            } ) ),
            planHistories: planHistories.map( ( history ) => ( {
                historyId: history.historyId,
                fromPlan: history.fromPlan,
                toPlan: history.toPlan,
                note: history.note,
                reason: history.reason,
                effectiveAt: history.effectiveAt,
                expiresAt: history.expiresAt,
                changedBy: history.admin ? `${ history.admin.name }(${ history.admin.loginId })` : null,
            } ) ),
            auditLogs,
        };
    }

    /**
     * 활동 요약 (최근 30일).
     * 필터 적용 횟수는 행동 이벤트 수집이 선행되어야 해 현재는 null 로 내려보낸다.
     */
    private async buildActivitySummary( userId: string, since: Date ) {
        const [ loginDates, savedRsPresets, savedSearchPresets, watchlistCount ] = await Promise.all( [
            this.prisma.userLoginHistory.findMany( {
                where: { userId, loggedInAt: { gte: since } },
                select: { loggedInAt: true },
            } ),
            this.prisma.rsFilterPreset.count( { where: { userId, deletedAt: null, createdAt: { gte: since } } } ),
            this.prisma.searchFilterPreset.count( { where: { userId, deletedAt: null, createdAt: { gte: since } } } ),
            this.prisma.userWatchlist.count( { where: { userId, deletedAt: null, addedDate: { gte: since } } } ),
        ] );

        const visitedDays = new Set(
            loginDates.map( ( row ) => formatDateOnly( row.loggedInAt ) ),
        ).size;

        return {
            windowDays: ACTIVITY_WINDOW_DAYS,
            visitedDays,
            filterApplied: null as number | null, // TODO: 행동 이벤트 수집 후 집계 (Phase 2)
            savedFilters: savedRsPresets + savedSearchPresets,
            watchlistCount,
        };
    }

    // =============================================
    // 운영 액션
    // =============================================

    /** 개인정보 마스킹 해제. 회원 상세에서만 가능하며 사유 입력이 필수다. */
    async unmask( admin: AuthenticatedAdmin, userId: string, dto: UnmaskUserDto, request: Request ) {
        this.assertOperator( admin, '개인정보 마스킹 해제' );
        const user = await this.findUserOrThrow( userId );

        await this.auditService.record( {
            adminId: admin.adminId,
            action: AdminAuditAction.USER_UNMASK,
            targetUserId: userId,
            reason: dto.reason,
            request,
        } );

        // 원문은 응답으로만 전달하고 감사 로그에는 남기지 않는다.
        return {
            email: user.email,
            name: user.name,
            phone: user.phone,
            masked: false,
        };
    }

    async changePlan( admin: AuthenticatedAdmin, userId: string, dto: ChangeUserPlanDto, request: Request ) {
        this.assertOperator( admin, '플랜 변경' );
        const user = await this.findUserOrThrow( userId );

        if ( user.planType === dto.planType ) {
            throw new BadRequestException( '현재 플랜과 동일합니다.' );
        }

        const subscription = await this.prisma.userSubscription.findUnique( { where: { userId } } );
        const effectiveAt = dto.effectiveAt
            ? new Date( dto.effectiveAt )
            : ( subscription?.nextBillingDate ?? new Date() );
        const expiresAt = dto.expiresAt ? new Date( dto.expiresAt ) : null;

        if ( expiresAt && expiresAt <= effectiveAt ) {
            throw new BadRequestException( '만료일은 시작일 이후여야 합니다.' );
        }

        const appliesNow = effectiveAt <= new Date();

        await this.prisma.$transaction( async ( tx ) => {
            await tx.userPlanHistory.create( {
                data: {
                    userId,
                    fromPlan: user.planType,
                    toPlan: dto.planType,
                    reason: dto.reason,
                    changedBy: admin.adminId,
                    effectiveAt,
                    expiresAt,
                },
            } );

            // 시작일이 미래면 이력만 남기고 현재 플랜은 유지한다 (다음 결제일부터 적용).
            if ( appliesNow ) {
                await tx.user.update( {
                    where: { userId },
                    data: { planType: dto.planType },
                } );
            }
        } );

        await this.auditService.record( {
            adminId: admin.adminId,
            action: AdminAuditAction.USER_PLAN_CHANGE,
            targetUserId: userId,
            before: { planType: user.planType },
            after: { planType: dto.planType },
            reason: dto.reason,
            request,
        } );

        return { userId, planType: dto.planType, effectiveAt, expiresAt, appliedImmediately: appliesNow };
    }

    /**
     * 상태 변경.
     * ACTIVE 가 아닌 계정은 JwtStrategy 에서 거부되므로 기존 토큰도 다음 요청에서 바로 만료된다.
     */
    async changeStatus( admin: AuthenticatedAdmin, userId: string, dto: ChangeUserStatusDto, request: Request ) {
        this.assertOperator( admin, '상태 변경' );
        const user = await this.findUserOrThrow( userId );

        if ( user.status === dto.status ) {
            throw new BadRequestException( '현재 상태와 동일합니다.' );
        }

        await this.applyStatus( userId, dto.status );

        await this.auditService.record( {
            adminId: admin.adminId,
            action: AdminAuditAction.USER_STATUS_CHANGE,
            targetUserId: userId,
            before: { status: user.status },
            after: { status: dto.status },
            reason: dto.reason,
            request,
        } );

        return { userId, status: dto.status };
    }

    async bulkChangeStatus( admin: AuthenticatedAdmin, dto: BulkChangeUserStatusDto, request: Request ) {
        this.assertOperator( admin, '일괄 상태 변경' );

        const users = await this.prisma.user.findMany( {
            where: { userId: { in: dto.userIds } },
            select: { userId: true, status: true },
        } );

        const targets = users.filter( ( user ) => user.status !== dto.status );

        for ( const target of targets ) {
            await this.applyStatus( target.userId, dto.status );
            await this.auditService.record( {
                adminId: admin.adminId,
                action: AdminAuditAction.USER_STATUS_CHANGE,
                targetUserId: target.userId,
                before: { status: target.status },
                after: { status: dto.status },
                reason: dto.reason,
                request,
            } );
        }

        return {
            requested: dto.userIds.length,
            changed: targets.length,
            skipped: dto.userIds.length - targets.length,
        };
    }

    /** DELETED 로 전환할 때만 deletedAt 을 세팅하고, 복구 시 해제한다 (물리 삭제하지 않는다). */
    private async applyStatus( userId: string, status: UserStatus ) {
        await this.prisma.user.update( {
            where: { userId },
            data: {
                status,
                deletedAt: status === UserStatus.DELETED ? new Date() : null,
            },
        } );
    }

    /**
     * 비밀번호 초기화.
     *
     * [확인 필요] 기획서 팝업의 본문은 '재설정 링크 발송 · 기존 비밀번호 유지'인데
     * 버튼 액션 설명은 '임시비밀번호 메일 발송'으로 서로 충돌한다.
     * 현재는 기존 시스템(EmailService.sendTempPassword)에 맞춰 임시 비밀번호 방식으로 구현한다.
     */
    async resetPassword( admin: AuthenticatedAdmin, userId: string, dto: ResetUserPasswordDto, request: Request ) {
        this.assertOperator( admin, '비밀번호 초기화' );
        const user = await this.findUserOrThrow( userId );

        if ( !user.password ) {
            throw new BadRequestException( '소셜 로그인 계정은 비밀번호를 초기화할 수 없습니다.' );
        }

        const tempPassword = generateTempPassword();
        await this.prisma.user.update( {
            where: { userId },
            data: { password: await bcrypt.hash( tempPassword, 10 ), isTempPassword: true },
        } );

        await this.emailService.sendTempPassword( user.email, tempPassword );

        // 임시 비밀번호 원문은 감사 로그에 남기지 않는다.
        await this.auditService.record( {
            adminId: admin.adminId,
            action: AdminAuditAction.USER_PASSWORD_RESET,
            targetUserId: userId,
            reason: dto.reason ?? null,
            request,
        } );

        return { sent: true, email: maskEmail( user.email ) };
    }

    /** 회원정보 수정. 마스킹된 문자열이 그대로 저장되는 사고를 막기 위해 '*' 포함 값은 거부한다. */
    async updateProfile( admin: AuthenticatedAdmin, userId: string, dto: UpdateUserProfileDto, request: Request ) {
        this.assertOperator( admin, '회원정보 수정' );
        const user = await this.findUserOrThrow( userId );

        assertNotMasked( dto.name, '이름' );
        assertNotMasked( dto.email, '이메일' );
        assertNotMasked( dto.phone, '전화번호' );

        const phone = normalizePhone( dto.phone );
        if ( dto.phone && phone && phone.replace( /\D/g, '' ).length < 10 ) {
            throw new BadRequestException( '올바른 전화번호를 입력해주세요.' );
        }

        if ( dto.email !== user.email ) {
            const duplicated = await this.prisma.user.findFirst( {
                where: { email: dto.email, deletedAt: null, NOT: { userId } },
                select: { userId: true },
            } );
            if ( duplicated ) {
                throw new ConflictException( '이미 사용 중인 이메일입니다.' );
            }
        }

        await this.prisma.user.update( {
            where: { userId },
            data: { name: dto.name, email: dto.email, phone },
        } );

        // 변경 전/후에 개인정보 원문을 남기지 않도록 어떤 항목이 바뀌었는지만 기록한다.
        const changedFields = [
            dto.name !== user.name ? 'name' : null,
            dto.email !== user.email ? 'email' : null,
            phone !== user.phone ? 'phone' : null,
        ].filter( Boolean ) as string[];

        await this.auditService.record( {
            adminId: admin.adminId,
            action: AdminAuditAction.USER_PROFILE_UPDATE,
            targetUserId: userId,
            after: { changedFields },
            request,
        } );

        return {
            userId,
            name: maskName( dto.name ),
            email: maskEmail( dto.email ),
            phone: maskPhone( phone ),
            changedFields,
        };
    }

    // =============================================
    // 공통
    // =============================================

    private async findUserOrThrow( userId: string ) {
        const user = await this.prisma.user.findUnique( { where: { userId } } );
        if ( !user ) {
            throw new NotFoundException( '회원을 찾을 수 없습니다.' );
        }
        return user;
    }

    private assertOperator( admin: AuthenticatedAdmin, action: string ) {
        if ( !OPERATOR_ROLES.includes( admin.role ) ) {
            throw new ForbiddenException( `${ action } 권한이 없습니다.` );
        }
    }
}

type UserRecord = Awaited<ReturnType<PrismaService[ 'user' ][ 'findUniqueOrThrow' ]>>;

function assertNotMasked( value: string | undefined, label: string ) {
    if ( value && value.includes( '*' ) ) {
        throw new BadRequestException( `${ label }에 마스킹된 값을 저장할 수 없습니다. 마스킹 해제 후 원문을 입력해주세요.` );
    }
}

function buildDateRange( from?: string, to?: string ): Prisma.DateTimeFilter | undefined {
    if ( !from && !to ) {
        return undefined;
    }

    // 화면의 날짜는 KST 기준이다.
    const filter: Prisma.DateTimeFilter = {};
    if ( from ) {
        filter.gte = new Date( `${ from.slice( 0, 10 ) }T00:00:00.000+09:00` );
    }
    if ( to ) {
        // 종료일 당일까지 포함한다.
        filter.lte = new Date( `${ to.slice( 0, 10 ) }T23:59:59.999+09:00` );
    }

    return filter;
}

function daysAgo( days: number ): Date {
    const date = new Date();
    date.setDate( date.getDate() - days );
    return date;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function formatDateOnly( date: Date ): string {
    return new Date( date.getTime() + KST_OFFSET_MS ).toISOString().slice( 0, 10 );
}

/** CSV 가입·탈퇴 일시 (KST, yyyy-mm-dd hh:mm) */
function formatDateTime( date: Date ): string {
    return new Date( date.getTime() + KST_OFFSET_MS ).toISOString().replace( 'T', ' ' ).slice( 0, 16 );
}

function generateTempPassword(): string {
    return crypto.randomBytes( 6 ).toString( 'base64url' ).slice( 0, 10 );
}

/** Excel 호환을 위해 UTF-8 BOM 을 붙이고 쌍따옴표를 이스케이프한다. */
function toCsv( rows: string[][] ): string {
    const body = rows
        .map( ( row ) => row.map( ( cell ) => `"${ String( cell ?? '' ).replace( /"/g, '""' ) }"` ).join( ',' ) )
        .join( '\r\n' );

    return `﻿${ body }`;
}
