import { Request } from 'express';

export interface ClientInfo {
    ipAddress: string | null;
    userAgent: string | null;
    deviceType: string | null;
    osName: string | null;
}

/** 요청에서 감사 로그 / 로그인 이력에 남길 접속 정보를 추출한다. */
export function extractClientInfo( request: Request ): ClientInfo {
    const forwarded = request.headers[ 'x-forwarded-for' ];
    const forwardedIp = Array.isArray( forwarded ) ? forwarded[ 0 ] : forwarded;
    const ipAddress = ( forwardedIp?.split( ',' )[ 0 ]?.trim() || request.ip || null );
    const userAgent = ( request.headers[ 'user-agent' ] as string | undefined ) ?? null;

    return {
        ipAddress: ipAddress ? ipAddress.replace( /^::ffff:/, '' ) : null,
        userAgent,
        deviceType: detectDeviceType( userAgent ),
        osName: detectOsName( userAgent ),
    };
}

/** User-Agent 기반 기기 구분. 정밀 분류가 필요해지면 ua-parser-js 도입을 검토한다. */
export function detectDeviceType( userAgent: string | null ): string | null {
    if ( !userAgent ) {
        return null;
    }

    if ( /iPad|Tablet/i.test( userAgent ) ) {
        return 'tablet';
    }
    if ( /Mobi|Android|iPhone/i.test( userAgent ) ) {
        return 'mobile';
    }

    return 'desktop';
}

export function detectOsName( userAgent: string | null ): string | null {
    if ( !userAgent ) {
        return null;
    }

    const iosMatch = userAgent.match( /OS (\d+)[_.]/ );
    if ( /iPhone|iPad|iPod/i.test( userAgent ) ) {
        return iosMatch ? `ios${ iosMatch[ 1 ] }` : 'iOS';
    }

    const androidMatch = userAgent.match( /Android (\d+)/ );
    if ( androidMatch ) {
        return `Android ${ androidMatch[ 1 ] }`;
    }

    if ( /Mac OS X/i.test( userAgent ) ) {
        return 'macOS';
    }
    if ( /Windows/i.test( userAgent ) ) {
        return 'Windows';
    }
    if ( /Linux/i.test( userAgent ) ) {
        return 'Linux';
    }

    return null;
}
