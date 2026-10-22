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
import { CurrentPriceService } from './current-price.service';
import { isRegularSessionTick } from './current-price-resolver.service';
import { RealtimeSubscriptionManager } from './realtime-subscription-manager.service';

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
    private readonly currentPriceService: CurrentPriceService,
    private readonly subscriptionManager: RealtimeSubscriptionManager,
  ) {}

  /** The Kiwoom session is shared with the server's realtime-chart subscriptions. */
  private shouldRelease(stockCode: string, leavingClientId: string): boolean {
    const hasOtherSubscribers = Array.from(this.clientSubscriptions.entries()).some(
      ([id, codes]) => id !== leavingClientId && codes.has(stockCode),
    );
    return !hasOtherSubscribers && !this.subscriptionManager.isManaged(stockCode);
  }

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
        // 마지막 구독자이고 서버의 실시간 차트 대상이 아닐 때만 실시간 소스 구독 해제
        if (this.shouldRelease(stockCode, client.id)) {
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

    // 상세 요약 API 와 같은 현재가로 즉시 snapshot 전송 (프론트 초기 렌더링용)
    const current = await this.currentPriceService
      .getCurrentPrice(stockCode, { fetchMissing: true })
      .catch((error) => {
        this.logger.warn(`Snapshot price unavailable for ${stockCode}: ${(error as Error).message}`);
        return undefined;
      });
    if (current) {
      client.emit('snapshot', {
        stockCode,
        price: current.currentPrice,
        changeRate: current.changeRate,
        prevDayCompare: current.changeAmount,
        open: current.openPrice,
        high: current.highPrice,
        low: current.lowPrice,
        accVolume: current.accVolume == null ? null : Number(current.accVolume),
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

    // 마지막 구독자이고 서버의 실시간 차트 대상이 아닐 때만 실시간 소스 구독 해제
    if (this.shouldRelease(stockCode, client.id)) {
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
    // 정규장이 끝난 뒤 들어오는 체결(넥스트레이드·시간외)은 화면 가격을 종가에서 바꾸지 않는다.
    if (!isRegularSessionTick(new Date())) return;

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
