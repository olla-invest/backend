import { maskEmail, maskIpAddress, maskName, maskPhone, normalizePhone } from './masking.util';

describe( 'masking.util', () => {
    describe( 'maskEmail', () => {
        it( '기획서 예시: 로컬파트 앞 4자만 노출하고 도메인은 유지한다', () => {
            expect( maskEmail( 'ttaerin92@gmail.com' ) ).toBe( 'ttae*****@gmail.com' );
        } );

        it( '로컬파트가 4자 이하여도 최소 1자는 가린다', () => {
            expect( maskEmail( 'abcd@gmail.com' ) ).toBe( 'abc*@gmail.com' );
            expect( maskEmail( 'a@gmail.com' ) ).toBe( 'a@gmail.com' );
        } );

        it( 'null 과 undefined 는 그대로 통과시킨다', () => {
            expect( maskEmail( null ) ).toBeNull();
            expect( maskEmail( undefined ) ).toBeNull();
        } );
    } );

    describe( 'maskName', () => {
        it( '기획서 예시: 첫 글자와 마지막 글자만 노출한다', () => {
            expect( maskName( '이태린' ) ).toBe( '이*린' );
            expect( maskName( '남궁민수' ) ).toBe( '남**수' );
        } );

        it( '2자 이름은 첫 글자만 노출한다', () => {
            expect( maskName( '이태' ) ).toBe( '이*' );
        } );

        it( '영어 이름은 단어마다 첫 글자만 노출한다', () => {
            expect( maskName( 'Taerin Lee' ) ).toBe( 'T***** L**' );
        } );
    } );

    describe( 'maskPhone', () => {
        it( '기획서 예시: 가운데 자리를 전부 가린다', () => {
            expect( maskPhone( '010-1234-5678' ) ).toBe( '010-****-5678' );
        } );

        it( '하이픈이 없어도 동일하게 처리한다', () => {
            expect( maskPhone( '01012345678' ) ).toBe( '010-****-5678' );
        } );

        it( '10자리 번호도 가운데를 가린다', () => {
            expect( maskPhone( '0311234567' ) ).toBe( '031-***-4567' );
        } );
    } );

    describe( 'normalizePhone', () => {
        it( '저장 시 하이픈을 자동 부여한다', () => {
            expect( normalizePhone( '01012345678' ) ).toBe( '010-1234-5678' );
            expect( normalizePhone( '010 1234 5678' ) ).toBe( '010-1234-5678' );
        } );
    } );

    describe( 'maskIpAddress', () => {
        it( '가운데 두 옥텟을 가린다', () => {
            expect( maskIpAddress( '211.123.456.42' ) ).toBe( '211.***.***.42' );
        } );
    } );
} );
