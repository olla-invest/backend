/**
 * 백오피스 관리자 계정 생성 / 비밀번호 재설정 스크립트
 *
 *   npx ts-node -r tsconfig-paths/register scripts/create-admin.ts <loginId> <password> <name> [role]
 *
 * role: SUPER_ADMIN | OPERATOR | VIEWER (기본 SUPER_ADMIN)
 */
import * as bcrypt from 'bcrypt';
import { PrismaClient, AdminRole } from '../generated/prisma';

async function main() {
    const [ loginId, password, name, roleArg ] = process.argv.slice( 2 );

    if ( !loginId || !password || !name ) {
        console.error( 'usage: create-admin.ts <loginId> <password> <name> [role]' );
        process.exit( 1 );
    }

    const role = ( roleArg as AdminRole ) ?? AdminRole.SUPER_ADMIN;
    if ( !Object.values( AdminRole ).includes( role ) ) {
        console.error( `invalid role: ${ role }. one of ${ Object.values( AdminRole ).join( ', ' ) }` );
        process.exit( 1 );
    }

    const prisma = new PrismaClient();
    const hashed = await bcrypt.hash( password, 10 );

    try {
        const existing = await prisma.admin.findFirst( { where: { loginId, deletedAt: null } } );

        if ( existing ) {
            await prisma.admin.update( {
                where: { adminId: existing.adminId },
                data: { password: hashed, name, role, isActive: true },
            } );
            console.log( `관리자 계정 갱신: ${ loginId } (${ role })` );
            return;
        }

        const created = await prisma.admin.create( {
            data: { loginId, password: hashed, name, role },
        } );
        console.log( `관리자 계정 생성: ${ created.loginId } (${ created.role }) / ${ created.adminId }` );
    } finally {
        await prisma.$disconnect();
    }
}

main().catch( ( error ) => {
    console.error( error );
    process.exit( 1 );
} );
