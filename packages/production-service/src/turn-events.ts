import { ProductionError } from './contracts.js';

/** App Server 同时推送子代理事件；只有主线程的指定 turn 可以交付结果。 */
export function collectMainTurn(
  target: () => { threadId?: string; turnId?: string },
  finish: (result: { turn: any; text: string }) => void,
  fail: (error: Error) => void,
) {
  let finalText = '';
  return (event: any) => {
    const expected = target(), params = event.params;
    if (!expected.threadId || params?.threadId !== expected.threadId) return;
    const eventTurn = params.turnId ?? params.turn?.id;
    // 首个 turn 的通知可能早于 turn/start 响应；该新线程此时没有旧 turn。
    if (expected.turnId && eventTurn !== expected.turnId) return;
    if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
      finalText = params.item.text;
    }
    if (event.method === 'turn/completed') {
      if (params.turn.status === 'completed') finish({ turn: params.turn, text: finalText });
      else fail(new ProductionError('CODEX_TURN_FAILED', `Codex 状态 ${params.turn.status}：${JSON.stringify(params.turn.error)}`, 500));
    }
  };
}
