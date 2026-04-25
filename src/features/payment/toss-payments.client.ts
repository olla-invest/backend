import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface TossBillingKeyResponse {
    billingKey: string;
    customerKey: string;
    card: {
        issuerCode: string;
        acquirerCode?: string;
        number: string;         // 마스킹된 카드번호
        cardType: string;
        ownerType: string;
    };
}

export interface TossPaymentResponse {
    paymentKey: string;
    orderId: string;
    orderName: string;
    status: string;
    amount: number;
    method: string;
    card?: {
        issuerCode: string;
        number: string;
        cardType: string;
        ownerType: string;
    };
    failureCode?: string;
    failureMessage?: string;
}

@Injectable()
export class TossPaymentsClient {
    private readonly client: AxiosInstance;
    private readonly logger = new Logger( TossPaymentsClient.name );

    constructor( private readonly config: ConfigService ) {
        const secretKey = this.config.get<string>( 'TOSS_SECRET_KEY' );
        const encoded = Buffer.from( `${secretKey}:` ).toString( 'base64' );

        this.client = axios.create( {
            baseURL: 'https://api.tosspayments.com/v1',
            headers: {
                Authorization: `Basic ${encoded}`,
                'Content-Type': 'application/json',
            },
        } );
    }

    /**
     * 빌링키 발급 (카드 등록 + 첫 결제)
     */
    async issueBillingKey( authKey: string, customerKey: string ): Promise<TossBillingKeyResponse> {
        try {
            const { data } = await this.client.post( '/billing/authorizations/issue', {
                authKey,
                customerKey,
            } );
            return data;
        } catch ( error ) {
            this.logger.error( '빌링키 발급 실패', error?.response?.data );
            throw new InternalServerErrorException(
                error?.response?.data?.message ?? '카드 등록 중 오류가 발생했습니다.',
            );
        }
    }

    /**
     * 빌링 결제 실행
     */
    async chargeBilling(
        billingKey: string,
        params: {
            customerKey: string;
            amount: number;
            orderId: string;
            orderName: string;
            customerEmail?: string;
            customerName?: string;
        },
    ): Promise<TossPaymentResponse> {
        try {
            const { data } = await this.client.post( `/billing/${billingKey}`, params );
            return data;
        } catch ( error ) {
            this.logger.error( '빌링 결제 실패', error?.response?.data );
            // 결제 실패는 throw하지 않고 실패 응답 반환 (상태 기록용)
            return {
                paymentKey: '',
                orderId: params.orderId,
                orderName: params.orderName,
                status: 'FAILED',
                amount: params.amount,
                method: 'CARD',
                failureCode: error?.response?.data?.code,
                failureMessage: error?.response?.data?.message ?? '결제에 실패했습니다.',
            };
        }
    }

    /**
     * 결제 취소
     */
    async cancelPayment(
        paymentKey: string,
        cancelReason: string,
    ): Promise<void> {
        try {
            await this.client.post( `/payments/${paymentKey}/cancel`, { cancelReason } );
        } catch ( error ) {
            this.logger.error( '결제 취소 실패', error?.response?.data );
            throw new InternalServerErrorException(
                error?.response?.data?.message ?? '결제 취소 중 오류가 발생했습니다.',
            );
        }
    }
}
