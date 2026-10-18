/** AI 子系统的统一出口。
 *
 *  别处只该从这里（或具体到 `ai/actions`）拿能力 —— 传输、提示词、
 *  解析、缓存都是内部实现。这条「一个桶口」正是「AI 代码内聚」的判据：
 *  想换供应商，改的是 `ai/transport.ts` + 配置，而不是全仓 grep。
 */
export * from './types'
export * from './config'
export * from './actions'
export * from './apply'
export * from './cache'
export * from './audit'
export { __setTransportForTest, resolvedTransport } from './transport'
