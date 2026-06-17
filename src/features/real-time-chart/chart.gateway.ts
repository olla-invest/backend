import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { IRealtimeSource, REALTIME_SOURCE_TOKEN } from '../../integrations/kiwoom/websocket/realtime-source.interface';
import { RealtimePriceCacheService } from './realtime-price-cache.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/chart',
})
export class ChartGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChartGateway.name);
  private clientSubscriptions = new Map<string, Set<string>>(); // clientId -> Set<stockCode>

  constructor(
    @Inject(REALTIME_SOURCE_TOKEN)
    private readonly realtimeSource: IRealtimeSource,
    private readonly realtimeCache: RealtimePriceCacheService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('Chart WebSocket Gateway initialized');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientSubscriptions.set(client.id, new Set());
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // 클라이언트 구독 해제
    const stockCodes = this.clientSubscriptions.get(client.id);
    if (stockCodes) {
      stockCodes.forEach((stockCode) => {
        // 다른 클라이언트도 구독 중인지 확인
        const hasOtherSubscribers = Array.from(this.clientSubscriptions.entries()).some(
          ([id, codes]) => id !== client.id && codes.has(stockCode),
        );

        if (!hasOtherSubscribers) {
          // 마지막 구독자인 경우에만 실시간 소스 구독 해제
          this.realtimeSource.unsubscribe(stockCode);
        }
      });

      this.clientSubscriptions.delete(client.id);
    }
  }

  /**
   * 실시간 차트 구독
   */
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { stockCode: string },
  ): Promise<void> {
    const { stockCode } = data;

    // 클라이언트 구독 목록에 추가
    const stockCodes = this.clientSubscriptions.get(client.id)!;
    stockCodes.add(stockCode);

    // 실시간 소스 구독 (실시간 체결 + 호가) + room 자동 join
    await this.realtimeSource.subscribe(stockCode, ['0B', '0D']);
    client.join(`stock:${stockCode}`);

    // 캐시에 현재가가 있으면 즉시 snapshot 전송 (프론트 초기 렌더링용)
    const cached = this.realtimeCache.getPrice(stockCode);
    if (cached) {
      client.emit('snapshot', {
        stockCode,
        price: cached.currentPrice,
        changeRate: cached.changeRate,
        prevDayCompare: cached.changeAmount,
        open: cached.openPrice,
        high: cached.highPrice,
        low: cached.lowPrice,
        accVolume: cached.accVolume,
      });
    }

    client.emit('subscribed', { stockCode });
  }

  /**
   * 실시간 차트 구독 해제
   */
  @SubscribeMessage('unsubscribe')
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { stockCode: string },
  ): Promise<void> {
    const { stockCode } = data;


    // 클라이언트 구독 목록에서 제거
    const stockCodes = this.clientSubscriptions.get(client.id);
    if (stockCodes) {
      stockCodes.delete(stockCode);
    }

    // 다른 클라이언트도 구독 중인지 확인
    const hasOtherSubscribers = Array.from(this.clientSubscriptions.entries()).some(
      ([id, codes]) => id !== client.id && codes.has(stockCode),
    );

    if (!hasOtherSubscribers) {
      // 마지막 구독자인 경우에만 실시간 소스 구독 해제
      await this.realtimeSource.unsubscribe(stockCode);
    }

    client.leave(`stock:${stockCode}`);
    client.emit('unsubscribed', { stockCode });
  }

  /**
   * 실시간 체결 데이터 브로드캐스트 (0B)
   */
  @OnEvent('kiwoom.realtime.0B')
  handleRealtimeTick(event: {
    stockCode: string;
    type: string;
    values: Record<string, string>;
  }): void {
    const { stockCode, values } = event;

    // 구독 중인 클라이언트에게만 전송
    const tickData = {
      stockCode,
      time: this.parseKiwoomTime(values['20']),        // 체결시간 → Unix timestamp(초)
      price: String(Math.abs(Number(values['10']))),   // 현재가 (부호 제거)
      volume: values['15'],                            // 거래량
      prevDayCompare: String(Math.abs(Number(values['11']))), // 전일대비 (부호 제거)
      changeRate: values['12'],                        // 등락율
      askPrice: values['27'],                          // 매도호가
      bidPrice: values['28'],                          // 매수호가
      accVolume: values['13'],                         // 누적거래량
      open: String(Math.abs(Number(values['16']))),    // 시가 (부호 제거)
      high: String(Math.abs(Number(values['17']))),    // 고가 (부호 제거)
      low: String(Math.abs(Number(values['18']))),     // 저가 (부호 제거)
    };

    this.server.to(`stock:${stockCode}`).emit('tick', tickData);

    // 전체 클라이언트에게 가격 업데이트 브로드캐스트 (테이블 currentPrice 갱신용)
    // 키움 현재가(values['10'])는 등락 방향 부호 포함 → 절대값으로 변환
    const changeRateNum = parseFloat(values['12']);
    const changeRateStr = isNaN(changeRateNum)
      ? values['12']
      : `${changeRateNum > 0 ? '+' : ''}${changeRateNum.toFixed(2)}%`;
    this.server.emit('priceUpdated', {
      stockCode,
      price: String(Math.abs(Number(values['10']))),  // 현재가 (부호 제거)
      changeRate: changeRateStr,                       // 등락율 (+5.23% 형식)
      prevDayCompare: values['11'],                    // 전일대비
    });
  }

  /**
   * metrics 재계산 완료 시 전체 클라이언트에게 알림
   */
  @OnEvent('metrics.updated')
  handleMetricsUpdated(event: { tradeDate: string; filteredCount: number }): void {
    this.server.emit('metricsUpdated', event);
  }

  /**
   * 실시간 호가 데이터 브로드캐스트 (0D)
   */
  @OnEvent('kiwoom.realtime.0D')
  handleRealtimeQuote(event: {
    stockCode: string;
    type: string;
    values: Record<string, string>;
  }): void {
    const { stockCode, values } = event;

    const quoteData = {
      stockCode,
      time: values['21'], // 호가시간
      asks: [
        { price: values['41'], volume: values['61'] },
        { price: values['42'], volume: values['62'] },
        { price: values['43'], volume: values['63'] },
        { price: values['44'], volume: values['64'] },
        { price: values['45'], volume: values['65'] },
      ],
      bids: [
        { price: values['51'], volume: values['71'] },
        { price: values['52'], volume: values['72'] },
        { price: values['53'], volume: values['73'] },
        { price: values['54'], volume: values['74'] },
        { price: values['55'], volume: values['75'] },
      ],
      totalAskVolume: values['121'],
      totalBidVolume: values['125'],
    };

    this.server.to(`stock:${stockCode}`).emit('quote', quoteData);
  }

  private parseKiwoomTime(hhmmss: string): number {
    const now = new Date();
    const todayKst = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
    const h = hhmmss.slice(0, 2);
    const m = hhmmss.slice(2, 4);
    const s = hhmmss.slice(4, 6);
    return Math.floor(new Date(`${todayKst}T${h}:${m}:${s}+09:00`).getTime() / 1000);
  }

  /**
   * 클라이언트를 종목별 룸에 참가시킴
   */
  @SubscribeMessage('join')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { stockCode: string },
  ): void {
    const { stockCode } = data;
    client.join(`stock:${stockCode}`);
  }

  /**
   * 클라이언트를 종목별 룸에서 퇴장시킴
   */
  @SubscribeMessage('leave')
  handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { stockCode: string },
  ): void {
    const { stockCode } = data;
    client.leave(`stock:${stockCode}`);
  }
}
