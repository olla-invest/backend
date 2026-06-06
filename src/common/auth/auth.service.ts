import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { AuthProvider } from '../../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { FindIdDto } from './dto/find-id.dto';
import { FindPasswordDto } from './dto/find-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CompleteSocialProfileDto } from './dto/complete-social-profile.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { SocialProfile } from './types/social-profile.type';

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly emailService: EmailService,
    ) {}

    async register( dto: RegisterDto ) {
        if ( !dto.agreeService || !dto.agreePrivacy ) {
            throw new BadRequestException( '필수 약관에 동의해주세요' );
        }

        const existingByUsername = await this.prisma.user.findFirst( {
            where: { username: dto.username, deletedAt: null },
        } );
        if ( existingByUsername ) {
            throw new ConflictException( '이미 사용 중인 ID입니다' );
        }

        const existingByEmail = await this.prisma.user.findFirst( {
            where: { email: dto.email, deletedAt: null },
        } );
        if ( existingByEmail ) {
            throw new ConflictException( '이미 사용 중인 이메일입니다' );
        }

        const hashedPassword = await bcrypt.hash( dto.password, 10 );

        const user = await this.prisma.user.create( {
            data: {
                username: dto.username,
                email: dto.email,
                password: hashedPassword,
                name: dto.name,
                phone: dto.phone,
                marketingConsent: dto.agreeMarketing ?? false,
            },
        } );

        return {
            userId: user.userId,
            username: user.username,
            email: user.email,
            name: user.name,
        };
    }

    async login( dto: LoginDto ) {
        const user = await this.prisma.user.findFirst( {
            where: { username: dto.username, deletedAt: null },
        } );

        if ( !user ) {
            throw new NotFoundException( '가입된 계정이 없습니다. 회원가입 후 이용해주세요.' );
        }

        if ( !user.password ) {
            const providerName = user.provider === AuthProvider.NAVER ? '네이버' : '카카오';
            throw new UnauthorizedException(
                `${providerName} 소셜 로그인으로 가입된 계정입니다. 소셜 로그인을 이용해주세요.`,
            );
        }

        const isPasswordValid = await bcrypt.compare( dto.password, user.password );
        if ( !isPasswordValid ) {
            throw new UnauthorizedException( '비밀번호가 일치하지 않습니다.' );
        }

        const payload: JwtPayload = {
            sub: user.userId,
            username: user.username,
            email: user.email,
        };

        const accessToken = this.jwtService.sign( payload );

        return {
            accessToken,
            user: {
                userId: user.userId,
                username: user.username,
                email: user.email,
                name: user.name,
                isTempPassword: user.isTempPassword,
            },
        };
    }

    async findId( dto: FindIdDto ) {
        const user = await this.prisma.user.findFirst( {
            where: {
                name: dto.name,
                email: dto.email,
                deletedAt: null,
            },
        } );

        if ( !user ) {
            throw new NotFoundException( '사용자 정보가 일치하지 않습니다' );
        }

        return { maskedUsername: this.maskUsername( user.username ) };
    }

    async findPassword( dto: FindPasswordDto ) {
        const user = await this.prisma.user.findFirst( {
            where: {
                username: dto.username,
                email: dto.email,
                deletedAt: null,
            },
        } );

        if ( !user ) {
            throw new NotFoundException(
                '입력하신 정보로 가입된 계정을 찾을 수 없습니다. 다시 확인해주세요.',
            );
        }

        const tempPassword = this.generateTempPassword();
        const hashedTemp = await bcrypt.hash( tempPassword, 10 );

        await this.prisma.user.update( {
            where: { userId: user.userId },
            data: { password: hashedTemp, isTempPassword: true },
        } );

        await this.emailService.sendTempPassword( user.email, tempPassword );

        return { email: user.email };
    }

    async changePassword( userId: string, dto: ChangePasswordDto ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId },
        } );

        if ( !user ) {
            throw new NotFoundException( '사용자를 찾을 수 없습니다.' );
        }

        if ( !user.password ) {
            throw new BadRequestException( '소셜 로그인 계정은 비밀번호를 변경할 수 없습니다.' );
        }

        // 임시 비밀번호 상태가 아닌 경우 현재 비밀번호 검증 필수
        if ( !user.isTempPassword ) {
            if ( !dto.currentPassword ) {
                throw new BadRequestException( '현재 비밀번호를 입력해주세요.' );
            }
            const isCurrentPasswordValid = await bcrypt.compare( dto.currentPassword, user.password );
            if ( !isCurrentPasswordValid ) {
                throw new UnauthorizedException( '현재 비밀번호가 일치하지 않습니다.' );
            }
        }

        if ( dto.newPassword !== dto.confirmPassword ) {
            throw new BadRequestException( '새 비밀번호가 일치하지 않습니다.' );
        }

        const isSameAsCurrent = await bcrypt.compare( dto.newPassword, user.password );
        if ( isSameAsCurrent ) {
            throw new BadRequestException( '기존 비밀번호와 다른 비밀번호를 입력해주세요.' );
        }

        const hashedPassword = await bcrypt.hash( dto.newPassword, 10 );

        await this.prisma.user.update( {
            where: { userId },
            data: { password: hashedPassword, isTempPassword: false },
        } );

        return { message: '비밀번호가 변경되었습니다.' };
    }

    async socialLogin( profile: SocialProfile ): Promise<{ accessToken: string; user: object }> {
        const provider = AuthProvider[ profile.provider ];
        const isFallbackEmail = this.isFallbackSocialEmail( profile.email );

        let user = await this.prisma.user.findFirst( {
            where: { provider, socialId: profile.socialId, deletedAt: null },
        } );

        if ( !user ) {
            if ( !isFallbackEmail ) {
                const emailUser = await this.prisma.user.findFirst( {
                    where: { email: profile.email, deletedAt: null },
                } );
                if ( emailUser ) {
                    throw new ConflictException(
                        '이미 해당 이메일로 가입된 계정이 있습니다. 일반 로그인을 이용해주세요.',
                    );
                }
            }

            const username = this.generateUniqueSocialUsername( provider );

            user = await this.prisma.user.create( {
                data: {
                    username,
                    email: profile.email,
                    password: null,
                    provider,
                    socialId: profile.socialId,
                    name: profile.name ?? null,
                    phone: profile.phone ?? null,
                    marketingConsent: false,
                },
            } );
        } else {
            const updateData: {
                email?: string;
                name?: string | null;
                phone?: string | null;
            } = {};

            if ( !isFallbackEmail && this.isFallbackSocialEmail( user.email ) && user.email !== profile.email ) {
                const emailUser = await this.prisma.user.findFirst( {
                    where: {
                        email: profile.email,
                        deletedAt: null,
                        NOT: { userId: user.userId },
                    },
                } );

                if ( !emailUser ) {
                    updateData.email = profile.email;
                }
            }

            if ( profile.name && ( !user.name || user.name === '미연동 계정' ) ) {
                updateData.name = profile.name;
            }

            if ( profile.phone && !user.phone ) {
                updateData.phone = profile.phone;
            }

            if ( Object.keys( updateData ).length > 0 ) {
                user = await this.prisma.user.update( {
                    where: { userId: user.userId },
                    data: updateData,
                } );
            }
        }

        const payload: JwtPayload = {
            sub: user.userId,
            username: user.username,
            email: user.email,
        };

        const accessToken = this.jwtService.sign( payload );

        return {
            accessToken,
            user: {
                userId: user.userId,
                username: user.username,
                email: this.isFallbackSocialEmail( user.email ) ? null : user.email,
                name: user.name,
                provider: user.provider,
                snsLinkedYn: this.isSocialProfileCompleted( user ),
            },
        };
    }

    async getMe( userId: string ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
        } );

        if ( !user ) {
            throw new NotFoundException( '사용자를 찾을 수 없습니다.' );
        }

        return {
            userId: user.userId,
            username: user.username,
            email: this.toMeResponseEmail( user ),
            name: user.name,
            provider: user.provider,
            phone: user.phone,
            snsLinkedYn: this.isSocialProfileCompleted( user ),
        };
    }

    async completeSocialProfile( userId: string, dto: CompleteSocialProfileDto ) {
        if ( !dto.agreeService || !dto.agreePrivacy ) {
            throw new BadRequestException( '필수 약관에 동의해주세요' );
        }

        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
        } );

        if ( !user ) {
            throw new NotFoundException( '사용자를 찾을 수 없습니다.' );
        }

        if ( !this.isSocialAccount( user ) ) {
            throw new BadRequestException( 'SNS 로그인 계정만 추가 정보를 등록할 수 있습니다.' );
        }

        if ( dto.email !== user.email ) {
            const existingEmail = await this.prisma.user.findFirst( {
                where: {
                    email: dto.email,
                    deletedAt: null,
                    NOT: { userId },
                },
            } );
            if ( existingEmail ) {
                throw new ConflictException( '이미 사용 중인 이메일입니다.' );
            }
        }

        const username = this.isLegacySocialUsername( user )
            ? this.generateUniqueSocialUsername( user.provider )
            : user.username;

        const updated = await this.prisma.user.update( {
            where: { userId },
            data: {
                username,
                email: dto.email,
                name: dto.name,
                phone: dto.phone,
                marketingConsent: dto.agreeMarketing ?? false,
            },
        } );

        return {
            userId: updated.userId,
            username: updated.username,
            email: updated.email,
            name: updated.name,
            phone: updated.phone,
            provider: updated.provider,
            snsLinkedYn: this.isSocialProfileCompleted( updated ),
        };
    }

    async validateUser( userId: string ) {
        return this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
        } );
    }

    private maskUsername( username: string ): string {
        if ( username.length <= 4 ) {
            return username.slice( 0, 2 ) + '*'.repeat( username.length - 2 );
        }
        const visible = username.slice( 0, 4 );
        const last = username.slice( -1 );
        const masked = '*'.repeat( username.length - 5 );
        return visible + masked + last;
    }

    private isSocialAccount( user: { provider: AuthProvider; socialId?: string | null } ): boolean {
        return user.provider !== AuthProvider.LOCAL && !!user.socialId;
    }

    private isSocialProfileCompleted( user: { provider: AuthProvider; socialId?: string | null; email: string; name?: string | null; phone?: string | null } ): boolean {
        if ( !this.isSocialAccount( user ) ) return false;
        return !this.isFallbackSocialEmail( user.email ) && !!user.name && !!user.phone;
    }

    private isFallbackSocialEmail( email: string ): boolean {
        return email.endsWith( '@naver.social' ) || email.endsWith( '@kakao.social' );
    }

    private toMeResponseEmail( user: { provider: AuthProvider; email: string } ): string | null {
        if ( user.provider === AuthProvider.KAKAO ) {
            return null;
        }

        return user.email;
    }

    private isLegacySocialUsername( user: { provider: AuthProvider; socialId?: string | null; username: string } ): boolean {
        if ( !user.socialId ) return false;
        return user.username === `${user.provider.toLowerCase()}_${user.socialId}`.substring( 0, 50 );
    }

    private generateUniqueSocialUsername( provider: AuthProvider ): string {
        const prefix = provider.toLowerCase();
        const suffix = crypto.randomUUID().replace( /-/g, '' ).slice( 0, 8 );
        return `${prefix}_${suffix}`;
    }

    private generateTempPassword(): string {
        const animalWords = [
            'bear', 'wolf', 'lion', 'swan', 'tiger',
            'eagle', 'otter', 'panda', 'zebra', 'koala',
            'horse', 'whale', 'shark', 'mouse', 'camel',
            'sheep', 'goose', 'llama', 'bison', 'raven',
            'moose', 'lemur', 'gecko', 'badger', 'beaver',
            'falcon', 'jaguar', 'rabbit', 'monkey',
        ];
        const specialChars = '#!@&';

        const word = animalWords[ crypto.randomInt( 0, animalWords.length ) ];
        const special = specialChars[ crypto.randomInt( 0, specialChars.length ) ];
        const number = crypto.randomInt( 100, 10000 );

        return `${word}${special}${number}`;
    }
}
