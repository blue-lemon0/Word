<script setup lang="ts">
/** AI 设置 —— 只出现「这台设备怎么连 AI」这一件事。
 *
 *  ★ 为什么放在「更多」而不是专门的设置页：这个 app 只有一个设置入口，
 *    多一个页面只为四行输入框，不值得（D35 的清单长度同理）。
 *
 *  ★ 为什么 API Key 用密码框 + 只存本机：它不该出现在备份里、
 *    也不该出现在录屏/截图里（`maskKey` 用来显示「已保存的是哪一个」）。
 *
 *  ★ 为什么要「测试连接」：最贵的错误是「配错了 key，等真正用 AI 时
 *    才发现」—— 一次 8 token 的 ping 比一次审查便宜两个数量级。
 */
import { ref, watch } from 'vue'
import { cacheClear, cacheInfo } from '../ai/cache'
import { ping } from '../ai/client'
import { DEFAULT_CONFIG, isConfigured, loadConfig, maskKey, saveConfig, type AiConfig } from '../ai/config'
import { toast } from '../toast'

const c = ref<AiConfig>(loadConfig())
/** 编辑中的 key 只在本地输入框里；保存后显示遮起来的版本 */
const keyDraft = ref('')
const testing = ref(false)
const cache = ref<{ count: number; chars: number }>({ count: 0, chars: 0 })

void refreshCache()

/** 开关**当下就生效**，不等「保存」。
 *  真实的踩法：打开开关、离开这一页 —— 回词条页发现还是没入口，
 *  因为那个开关只改了内存里的 c.enabled。开关这种「一眼就能看出状态」
 *  的控件，人不认为它还需要再点一次保存。 */
watch(
  () => c.value.enabled,
  (on) => {
    if (on && !c.value.apiKey.trim()) {
      c.value.enabled = false
      toast('先填 API Key 再打开')
      return
    }
    saveConfig({ ...c.value })
  },
)

async function refreshCache(): Promise<void> {
  cache.value = await cacheInfo()
}

function save(): void {
  const cfg: AiConfig = { ...c.value }
  const k = keyDraft.value.trim()
  if (k) {
    cfg.apiKey = k
    // ★ 刚填了 key 就顺手打开开关。
    //   真实的失败长这样：key 填好了、点保存、回词条页 —— 按钮不出现。
    //   因为开关还关着，而「开关」这个词在界面上只是一个右上角的小圆点。
    //   「我填了 key」这个动作的意图就是「我要用」，别让人再找一次那个圆点。
    cfg.enabled = true
  }
  // 打开开关但没 key、没地址 —— 直接说清，而不是让它静默失效
  if (cfg.enabled && !isConfigured(cfg)) {
    toast('要填 API Key 才能开启')
    return
  }
  saveConfig(cfg)
  c.value = cfg
  keyDraft.value = ''
  toast('AI 配置已保存（只存在这台设备上）')
}

async function test(): Promise<void> {
  if (testing.value) return
  // 先落盘再测：手填的 key 还没保存时测试，测的必须是「刚填的」
  save()
  testing.value = true
  try {
    const r = await ping()
    toast(r.ok ? `连接正常：${r.detail}` : `连不上：${r.detail}`)
  } finally {
    testing.value = false
  }
}

async function clearCache(): Promise<void> {
  const n = await cacheClear()
  await refreshCache()
  toast(n ? `清掉了 ${n} 条 AI 缓存` : '缓存本来就是空的')
}

function reset(): void {
  c.value = { ...DEFAULT_CONFIG }
  keyDraft.value = ''
  saveConfig(c.value)
  toast('已恢复默认（AI 关闭）')
}
</script>

<template>
  <section class="wb-card ai">
    <h3>
      AI 助手<span class="wb-dim">可选 · 默认关闭</span>
      <span class="wb-sp" />
      <van-switch v-model="c.enabled" size="20px" />
    </h3>
    <p class="hint">
      用来审查义项/例句、补一句、换一句。Key 只存在这台设备上，不进备份；
      内容不变时结果走缓存，不重复花钱。
    </p>
    <!-- ★ 「填了 key 但开关是关的」是最容易踩的一格：
         页面上看不出 AI 没开，只会觉得「功能没生效」。所以显式说出来。 -->
    <p v-if="c.apiKey && !c.enabled" class="warnline">
      已保存 Key，但开关是关着的 —— 打开右上角开关（或重新填一次 Key）才有 AI 入口。
    </p>

    <label class="f">
      <span>接口地址</span>
      <input v-model="c.baseUrl" placeholder="https://api.deepseek.com" autocapitalize="off" />
    </label>
    <label class="f">
      <span>模型</span>
      <input v-model="c.model" placeholder="deepseek-chat" autocapitalize="off" />
    </label>
    <label class="f">
      <span>API Key</span>
      <input
        v-model="keyDraft"
        type="password"
        :placeholder="c.apiKey ? `已保存：${maskKey(c.apiKey)}（留空不改）` : 'sk-…'"
        autocapitalize="off"
        autocorrect="off"
      />
    </label>
    <div class="two">
      <label class="f">
        <span>单次输出上限</span>
        <input v-model.number="c.maxTokens" type="number" min="200" max="4000" step="100" />
      </label>
      <label class="f">
        <span>温度</span>
        <input v-model.number="c.temperature" type="number" min="0" max="1" step="0.1" />
      </label>
    </div>

    <div class="acts">
      <van-button size="small" plain @click="test" :loading="testing">测试连接</van-button>
      <van-button size="small" plain @click="clearCache">
        清缓存{{ cache.count ? `（${cache.count}）` : '' }}
      </van-button>
      <van-button size="small" plain @click="reset">恢复默认</van-button>
      <span class="wb-sp" />
      <van-button size="small" type="primary" @click="save">保存</van-button>
    </div>

    <p class="tip">
      手机端走原生网络（WebView 里的 fetch 会被 CORS 拦）；桌面开发把地址填
      <code>/ai</code>，走 vite 代理。
    </p>
  </section>
</template>

<style scoped>
.ai h3 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}

.ai h3 .wb-dim {
  font-size: 11.5px;
  font-weight: 400;
}

.hint {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--wb-ink-3);
  margin-bottom: 12px;
}

.warnline {
  margin: -4px 0 12px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #fff6e6;
  color: #9a6400;
  font-size: 12.5px;
  line-height: 1.6;
}

.f {
  display: block;
  margin-bottom: 10px;
}

.f span {
  display: block;
  font-size: 12px;
  color: var(--wb-ink-3);
  margin-bottom: 5px;
}

.f input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--wb-line);
  border-radius: 10px;
  padding: 9px 10px;
  font: inherit;
  font-size: 14px;
  background: var(--wb-bg);
  color: var(--wb-ink);
}

.two {
  display: flex;
  gap: 10px;
}

.two .f {
  flex: 1 1 0;
}

.acts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.tip {
  margin-top: 10px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--wb-ink-3);
}

.tip code {
  font-family: ui-monospace, monospace;
}
</style>
