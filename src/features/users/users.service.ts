import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthProvider } from '../../../generated/prisma';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
    constructor( private readonly prisma: PrismaService ) {}

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
}
