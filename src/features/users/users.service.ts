import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthProvider, PlanType } from '../../../generated/prisma';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

interface AdminUserListQuery {
    page?: number;
    pageSize?: number;
    search?: string;
    provider?: AuthProvider;
    planType?: PlanType;
    includeDeleted?: boolean;
}

interface AdminCreateUserInput {
    username: string;
    email: string;
    password?: string;
    name?: string;
    phone?: string;
    planType?: PlanType;
    marketingConsent?: boolean;
}

interface AdminUpdateUserInput {
    username?: string;
    email?: string;
    password?: string;
    name?: string | null;
    phone?: string | null;
    planType?: PlanType;
    marketingConsent?: boolean;
    isTempPassword?: boolean;
    restore?: boolean;
    delete?: boolean;
}

@Injectable()
export class UsersService {
    constructor( private readonly prisma: PrismaService ) {}

    async adminListUsers( query: AdminUserListQuery ) {
        const page = Math.max( 1, Number( query.page ) || 1 );
        const pageSize = Math.min( 100, Math.max( 1, Number( query.pageSize ) || 20 ) );
        const search = query.search?.trim();

        const where: any = {
            ...(query.includeDeleted ? {} : { deletedAt: null }),
            ...(query.provider && { provider: query.provider }),
            ...(query.planType && { planType: query.planType }),
            ...(search && {
                OR: [
                    { username: { contains: search, mode: 'insensitive' } },
                    { email: { contains: search, mode: 'insensitive' } },
                    { name: { contains: search, mode: 'insensitive' } },
                    { phone: { contains: search, mode: 'insensitive' } },
                ],
            }),
        };

        const [ totalCount, users ] = await Promise.all( [
            this.prisma.user.count( { where } ),
            this.prisma.user.findMany( {
                where,
                orderBy: { createdAt: 'desc' },
                skip: ( page - 1 ) * pageSize,
                take: pageSize,
                select: this.adminUserSelect(),
            } ),
        ] );

        return {
            page,
            pageSize,
            totalCount,
            totalPages: Math.ceil( totalCount / pageSize ),
            users: users.map( ( user ) => this.toAdminUserResponse( user ) ),
        };
    }

    async adminCreateUser( input: AdminCreateUserInput ) {
        await this.assertUniqueActiveUser( input.username, input.email );

        const password = input.password || this.generateAdminTempPassword();
        const hashedPassword = await bcrypt.hash( password, 10 );

        const user = await this.prisma.user.create( {
            data: {
                username: input.username,
                email: input.email,
                password: hashedPassword,
                name: input.name || null,
                phone: input.phone || null,
                planType: input.planType || PlanType.FREE,
                marketingConsent: input.marketingConsent ?? false,
                isTempPassword: !input.password,
            },
            select: this.adminUserSelect(),
        } );

        return {
            user: this.toAdminUserResponse( user ),
            tempPassword: input.password ? null : password,
        };
    }

    async adminUpdateUser( userId: string, input: AdminUpdateUserInput ) {
        const user = await this.prisma.user.findUnique( { where: { userId } } );
        if ( !user ) {
            throw new NotFoundException( 'User not found' );
        }

        if ( input.delete ) {
            return this.adminHardDeleteUser( userId );
        }

        if ( input.username && input.username !== user.username ) {
            const existing = await this.prisma.user.findFirst( {
                where: { username: input.username, deletedAt: null, NOT: { userId } },
            } );
            if ( existing ) throw new ConflictException( 'Username already exists' );
        }

        if ( input.email && input.email !== user.email ) {
            const existing = await this.prisma.user.findFirst( {
                where: { email: input.email, deletedAt: null, NOT: { userId } },
            } );
            if ( existing ) throw new ConflictException( 'Email already exists' );
        }

        const updated = await this.prisma.user.update( {
            where: { userId },
            data: {
                ...(input.username !== undefined && { username: input.username }),
                ...(input.email !== undefined && { email: input.email }),
                ...(input.name !== undefined && { name: input.name || null }),
                ...(input.phone !== undefined && { phone: input.phone || null }),
                ...(input.planType !== undefined && { planType: input.planType }),
                ...(input.marketingConsent !== undefined && { marketingConsent: input.marketingConsent }),
                ...(input.isTempPassword !== undefined && { isTempPassword: input.isTempPassword }),
                ...(input.password && {
                    password: await bcrypt.hash( input.password, 10 ),
                    isTempPassword: false,
                }),
                ...(input.restore && { deletedAt: null }),
            },
            select: this.adminUserSelect(),
        } );

        return this.toAdminUserResponse( updated );
    }

    async getMyProfile( userId: string ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
            select: {
                userId: true,
                username: true,
                email: true,
                name: true,
                phone: true,
                provider: true,
                socialId: true,
                planType: true,
                marketingConsent: true,
                createdAt: true,
            },
        } );

        if ( !user ) {
            throw new NotFoundException( '사용자를 찾을 수 없습니다.' );
        }

        return {
            ...user,
            snsLinkedYn: this.isSocialProfileCompleted( user ),
        };
    }

    async updateProfile( userId: string, dto: UpdateProfileDto ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
        } );

        if ( !user ) {
            throw new NotFoundException( '사용자를 찾을 수 없습니다.' );
        }

        const updated = await this.prisma.user.update( {
            where: { userId },
            data: {
                ...(dto.name !== undefined && { name: dto.name }),
                ...(dto.phone !== undefined && { phone: dto.phone }),
            },
            select: {
                userId: true,
                username: true,
                email: true,
                name: true,
                phone: true,
                planType: true,
            },
        } );

        return updated;
    }

    async updateMarketingConsent( userId: string, consent: boolean ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
        } );

        if ( !user ) {
            throw new NotFoundException( '사용자를 찾을 수 없습니다.' );
        }

        await this.prisma.user.update( {
            where: { userId },
            data: { marketingConsent: consent },
        } );

        return { marketingConsent: consent };
    }

    async findByUsername( username: string ) {
        return this.prisma.user.findFirst( {
            where: { username, deletedAt: null },
        } );
    }

    async findByEmail( email: string ) {
        return this.prisma.user.findFirst( {
            where: { email, deletedAt: null },
        } );
    }

    private isSocialAccount( user: { provider: AuthProvider; socialId?: string | null } ): boolean {
        return user.provider !== AuthProvider.LOCAL && !!user.socialId;
    }

    private isSocialProfileCompleted( user: { provider: AuthProvider; socialId?: string | null; name?: string | null; phone?: string | null } ): boolean {
        if ( !this.isSocialAccount( user ) ) return false;
        return !!user.name && user.name !== '미연동 계정' && !!user.phone;
    }

    private async assertUniqueActiveUser( username: string, email: string ) {
        const existing = await this.prisma.user.findFirst( {
            where: {
                deletedAt: null,
                OR: [ { username }, { email } ],
            },
            select: { username: true, email: true },
        } );

        if ( !existing ) return;
        if ( existing.username === username ) throw new ConflictException( 'Username already exists' );
        throw new ConflictException( 'Email already exists' );
    }

    private adminUserSelect() {
        return {
            userId: true,
            username: true,
            email: true,
            name: true,
            phone: true,
            provider: true,
            socialId: true,
            planType: true,
            marketingConsent: true,
            isTempPassword: true,
            createdAt: true,
            updatedAt: true,
            deletedAt: true,
        } as const;
    }

    private toAdminUserResponse( user: any ) {
        return {
            ...user,
            snsLinkedYn: this.isSocialProfileCompleted( user ),
            status: user.deletedAt ? 'DELETED' : 'ACTIVE',
        };
    }

    private async adminHardDeleteUser( userId: string ) {
        const deleted = await this.prisma.$transaction( async ( tx ) => {
            const watchlistTags = await tx.watchlistTag.deleteMany( { where: { userId } } );
            const watchlist = await tx.userWatchlist.deleteMany( { where: { userId } } );
            const watchlistThemes = await tx.userWatchlistTheme.deleteMany( { where: { userId } } );
            const rsFilterPeriods = await tx.rsFilterPeriod.deleteMany( {
                where: { preset: { userId } },
            } );
            const rsFilterPresets = await tx.rsFilterPreset.deleteMany( { where: { userId } } );
            const searchFilterPresets = await tx.searchFilterPreset.deleteMany( { where: { userId } } );
            const apiCallLogs = await tx.kiwoomApiCallLog.deleteMany( { where: { userId } } );
            const payments = await tx.payment.deleteMany( { where: { userId } } );
            const subscription = await tx.userSubscription.deleteMany( { where: { userId } } );
            const paymentCards = await tx.paymentCard.deleteMany( { where: { userId } } );

            await tx.user.delete( { where: { userId } } );

            return {
                watchlistTags: watchlistTags.count,
                watchlist: watchlist.count,
                watchlistThemes: watchlistThemes.count,
                rsFilterPeriods: rsFilterPeriods.count,
                rsFilterPresets: rsFilterPresets.count,
                searchFilterPresets: searchFilterPresets.count,
                apiCallLogs: apiCallLogs.count,
                payments: payments.count,
                subscription: subscription.count,
                paymentCards: paymentCards.count,
            };
        } );

        return {
            userId,
            deleted: true,
            deletedCounts: deleted,
        };
    }

    private generateAdminTempPassword(): string {
        return `Temp${Math.random().toString( 36 ).slice( 2, 8 )}!1A`;
    }
}
