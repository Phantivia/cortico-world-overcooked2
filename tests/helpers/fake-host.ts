/** World 测试共用的假宿主：记录推送的事件、唤醒口径和待渲染的场景事件，其余宿主接口都是空实现。 */
import type { DeferredEventSpec, EventEnvelope, WorldHost, PushOptions } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  /** 待渲染的场景事件；测试里调 render 模拟 bot 读到它的那一刻。 */
  deferred: Array<Pick<DeferredEventSpec, 'type' | 'render' | 'tags'>> = [];
  pushDeferred(e: Pick<DeferredEventSpec, 'type' | 'render' | 'tags'>): void {
    this.deferred.push(e);
  }
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  /** 与 events 逐条对齐:唤醒/攒批的口径也要能断言 */
  pushOpts: Array<PushOptions | undefined> = [];

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}
