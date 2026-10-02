/**
 * 개인정보 마스킹 정책 (백오피스 기획서 10장)
 *
 * - 원본은 DB 에만 저장하고, 마스킹은 항상 서버에서 처리해 응답한다.
 * - 목록 / 상세 / 검색 결과 / CSV 등 관리자 화면에 개인정보가 노출되는 모든 곳에 적용한다.
 */

/**
 * 이메일: @ 앞부분은 앞 4자만 노출, 나머지는 * 처리. 도메인은 그대로 노출.
 * ex) ttaerin92@gmail.com -> ttae*****@gmail.com
 *
 * [확인 필요] 로컬파트가 4자 이하인 경우의 규칙이 기획서에 없어, 최소 1자는 가리도록 처리한다.
 */
export function maskEmail( email: string | null | undefined ): string | null {
    if ( !email ) {
        return email ?? null;
    }

    const atIndex = email.lastIndexOf( '@' );
    if ( atIndex <= 0 ) {
        return maskAll( email );
    }

    const local = email.slice( 0, atIndex );
    const domain = email.slice( atIndex );
    const visible = Math.min( 4, Math.max( 1, local.length - 1 ) );

    return `${ local.slice( 0, visible ) }${ '*'.repeat( local.length - visible ) }${ domain }`;
}

/**
 * 이름: 첫 글자와 마지막 글자만 노출하고 가운데는 전부 * 처리.
 * - 2자 이름은 첫 글자만 노출      ex) 이태 -> 이*
 * - 영어 이름은 단어마다 첫 글자만 ex) Taerin Lee -> T***** L**
 */
export function maskName( name: string | null | undefined ): string | null {
    if ( !name ) {
        return name ?? null;
    }

    const trimmed = name.trim();
    if ( trimmed.length === 0 ) {
        return trimmed;
    }

    if ( /[A-Za-z]/.test( trimmed ) ) {
        return trimmed
            .split( /\s+/ )
            .map( ( word ) => ( word.length <= 1 ? word : `${ word[ 0 ] }${ '*'.repeat( word.length - 1 ) }` ) )
            .join( ' ' );
    }

    if ( trimmed.length === 1 ) {
        return trimmed;
    }
    if ( trimmed.length === 2 ) {
        return `${ trimmed[ 0 ] }*`;
    }

    return `${ trimmed[ 0 ] }${ '*'.repeat( trimmed.length - 2 ) }${ trimmed[ trimmed.length - 1 ] }`;
}

/**
 * 전화번호: 가운데 자리는 전부 * 처리하고 앞·뒷자리는 노출.
 * ex) 010-1234-5678 -> 010-****-5678 / 01012345678 -> 010-****-5678
 *
 * [확인 필요] 10~11자리가 아닌 비표준 번호는 전체를 가린다.
 */
export function maskPhone( phone: string | null | undefined ): string | null {
    if ( !phone ) {
        return phone ?? null;
    }

    const digits = phone.replace( /\D/g, '' );

    if ( digits.length === 11 ) {
        return `${ digits.slice( 0, 3 ) }-****-${ digits.slice( 7 ) }`;
    }
    if ( digits.length === 10 ) {
        return `${ digits.slice( 0, 3 ) }-***-${ digits.slice( 6 ) }`;
    }

    return maskAll( phone );
}

/** 전화번호 저장 포맷: 숫자만 남긴 뒤 하이픈을 자동 부여한다. */
export function normalizePhone( phone: string | null | undefined ): string | null {
    if ( !phone ) {
        return phone ?? null;
    }

    const digits = phone.replace( /\D/g, '' );

    if ( digits.length === 11 ) {
        return `${ digits.slice( 0, 3 ) }-${ digits.slice( 3, 7 ) }-${ digits.slice( 7 ) }`;
    }
    if ( digits.length === 10 ) {
        return `${ digits.slice( 0, 3 ) }-${ digits.slice( 3, 6 ) }-${ digits.slice( 6 ) }`;
    }

    return digits;
}

/** IP 마스킹: 로그인 이력 화면은 211.***.***.42 형태로 노출한다. */
export function maskIpAddress( ip: string | null | undefined ): string | null {
    if ( !ip ) {
        return ip ?? null;
    }

    const parts = ip.split( '.' );
    if ( parts.length !== 4 ) {
        return maskAll( ip );
    }

    return `${ parts[ 0 ] }.***.***.${ parts[ 3 ] }`;
}

function maskAll( value: string ): string {
    return '*'.repeat( value.length );
}

export interface MaskablePersonalInfo {
    email?: string | null;
    name?: string | null;
    phone?: string | null;
}

/**
 * 회원 개인정보 3종을 한 번에 마스킹한다.
 * `unmasked` 가 true 면 원문을 그대로 반환하며, 호출부는 반드시 감사 로그를 남겨야 한다.
 */
export function maskPersonalInfo<T extends MaskablePersonalInfo>( value: T, unmasked = false ): T {
    if ( unmasked ) {
        return value;
    }

    return {
        ...value,
        email: maskEmail( value.email ),
        name: maskName( value.name ),
        phone: maskPhone( value.phone ),
    };
}
