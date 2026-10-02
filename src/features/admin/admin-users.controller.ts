import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdminRole } from '../../../generated/prisma';
import { Public } from '../../common/auth/decorators/public.decorator';
import { AdminUsersService } from './admin-users.service';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { AdminRolesGuard } from './guards/admin-roles.guard';
import { AdminRoles } from './decorators/admin-roles.decorator';
import { AuthenticatedAdmin, CurrentAdmin } from './decorators/current-admin.decorator';
import { AdminUserListQuery } from './dto/admin-user-list.query';
import {
    BulkChangeUserStatusDto,
    ChangeUserPlanDto,
    ChangeUserStatusDto,
    ResetUserPasswordDto,
    UnmaskUserDto,
    UpdateUserProfileDto,
} from './dto/admin-user-actions.dto';

@ApiTags( '백오피스 - 회원관리' )
@ApiBearerAuth( 'access-token' )
@Controller( 'admin/users' )
@Public() // 전역 회원용 JwtAuthGuard 를 건너뛰고 관리자 전용 가드를 사용한다.
@UseGuards( AdminJwtGuard, AdminRolesGuard )
export class AdminUsersController {
    constructor( private readonly adminUsersService: AdminUsersService ) {}

    @Get()
    @ApiOperation( { summary: '회원 목록 조회', description: '가입기간·가입경로·플랜·상태 필터와 원문 검색을 지원하며 개인정보는 마스킹해 반환한다.' } )
    list( @Query() query: AdminUserListQuery ) {
        return this.adminUsersService.list( query );
    }

    @Get( 'export' )
    @ApiOperation( { summary: '회원 목록 CSV 다운로드', description: '화면과 동일한 마스킹 값으로 내보내며 다운로드 이력을 감사 로그에 기록한다.' } )
    async export(
        @CurrentAdmin() admin: AuthenticatedAdmin,
        @Query() query: AdminUserListQuery,
        @Req() request: Request,
        @Res() response: Response,
    ) {
        const result = await this.adminUsersService.exportCsv( admin, query, request );

        response.setHeader( 'Content-Type', 'text/csv; charset=utf-8' );
        response.setHeader( 'Content-Disposition', `attachment; filename="${ result.filename }"` );
        response.setHeader( 'X-Total-Rows', String( result.rowCount ) );
        response.send( result.content );
    }

    @Patch( 'status' )
    @AdminRoles( AdminRole.OPERATOR )
    @ApiOperation( { summary: '회원 상태 일괄 변경' } )
    bulkChangeStatus(
        @CurrentAdmin() admin: AuthenticatedAdmin,
        @Body() dto: BulkChangeUserStatusDto,
        @Req() request: Request,
    ) {
        return this.adminUsersService.bulkChangeStatus( admin, dto, request );
    }

    @Get( ':userId' )
    @ApiOperation( { summary: '회원 상세 조회', description: '기본정보·활동요약·로그인 이력·플랜 이력·운영 감사 로그를 함께 반환한다.' } )
    detail(
        @CurrentAdmin() admin: AuthenticatedAdmin,
        @Param( 'userId', ParseUUIDPipe ) userId: string,
        @Req() request: Request,
    ) {
        return this.adminUsersService.detail( admin, userId, request );
    }

    @Post( ':userId/unmask' )
    @HttpCode( HttpStatus.OK )
    @AdminRoles( AdminRole.OPERATOR )
    @ApiOperation( { summary: '개인정보 마스킹 해제', description: '사유가 필수이며 해제 사실과 사유를 감사 로그에 기록한다.' } )
    unmask(
        @CurrentAdmin() admin: AuthenticatedAdmin,
        @Param( 'userId', ParseUUIDPipe ) userId: string,
        @Body() dto: UnmaskUserDto,
        @Req() request: Request,
    ) {
        return this.adminUsersService.unmask( admin, userId, dto, request );
    }

    @Patch( ':userId/plan' )
    @AdminRoles( AdminRole.OPERATOR )
    @ApiOperation( { summary: '플랜 변경', description: '시작일이 미래면 이력만 예약하고 현재 플랜은 유지한다.' } )
    changePlan(
        @CurrentAdmin() admin: AuthenticatedAdmin,
        @Param( 'userId', ParseUUIDPipe ) userId: string,
        @Body() dto: ChangeUserPlanDto,
        @Req() request: Request,
    ) {
        return this.adminUsersService.changePlan( admin, userId, dto, request );
    }

    @Patch( ':userId/status' )
    @AdminRoles( AdminRole.OPERATOR )
    @ApiOperation( { summary: '계정 상태 변경', description: 'ACTIVE 가 아닌 계정은 다음 요청부터 로그인·세션이 차단된다.' } )
    changeStatus(
        @CurrentAdmin() admin: AuthenticatedAdmin,
        @Param( 'userId', ParseUUIDPipe ) userId: string,
        @Body() dto: ChangeUserStatusDto,
        @Req() request: Request,
    ) {
        return this.adminUsersService.changeStatus( admin, userId, dto, request );
    }

    @Post( ':userId/password-reset' )
    @HttpCode( HttpStatus.OK )
    @AdminRoles( AdminRole.OPERATOR )
    @ApiOperation( { summary: '비밀번호 초기화', description: '회원 이메일로 임시 비밀번호를 발송한다.' } )
    resetPassword(
        @CurrentAdmin() admin: AuthenticatedAdmin,
        @Param( 'userId', ParseUUIDPipe ) userId: string,
        @Body() dto: ResetUserPasswordDto,
        @Req() request: Request,
    ) {
        return this.adminUsersService.resetPassword( admin, userId, dto, request );
    }

    @Patch( ':userId' )
    @AdminRoles( AdminRole.OPERATOR )
    @ApiOperation( { summary: '회원정보 수정', description: 'ID 는 수정할 수 없고 마스킹된 값은 저장을 거부한다.' } )
    updateProfile(
        @CurrentAdmin() admin: AuthenticatedAdmin,
        @Param( 'userId', ParseUUIDPipe ) userId: string,
        @Body() dto: UpdateUserProfileDto,
        @Req() request: Request,
    ) {
        return this.adminUsersService.updateProfile( admin, userId, dto, request );
    }
}
