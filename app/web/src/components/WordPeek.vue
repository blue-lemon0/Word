<script setup lang="ts">
/** 点词查义 —— 训练页答完题之后，句子里任何一个词都能点开看它是什么意思。
 *
 *  ★ 为什么必须「答完之后」才给（这是本组件存在的边界，不是实现细节）：
 *    这道题问的就是「这个词在这句话里是什么意思」。答之前把词义摊开，
 *    测的就不再是记忆，而是「你能不能忍住不看」—— 与「训练页里不放错题板」
 *    是同一条规矩（D36）。
 *
 *  ★ 为什么是浮层，而不是直接跳词条页：
 *    点一个词多半只是想「扫一眼」，跳页会把人从这一题上带走，
 *    回来还得重新找回这道题。浮层留在原地，看完点一下就回到题上；
 *    真想细看再点「看词条」跳过去（跳转由调用方保证能原样回来）。
 *
 *  ★ 为什么未入库的词也值得给一个「加入词库」：
 *    遇到生词、它又不在库里，这是**最想记下它的那一瞬间**。
 *    让人先退出训练、去词库页新建、再回来 —— 实际结果就是不加。
 *    加进来的是占位义项（`needsRefine`），义项与例句可以之后补，
 *    也可以让 AI 一次补齐（见 ai/reviewWord）。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { peekWord, type PeekResult } from '../lookup'
import { addPendingWord, pinSense, tomorrowStart, unpinSense } from '../edit'
import { allProgress } from '../db'
import { aiReady } from '../ai/config'
import { resolveLemma } from '../ai/actions'
import { toast } from '../toast'

const props = defineProps<{
  show: boolean
  /** 用户点的那个词（原样传进来，规范化在这一层做） */
  token: string
  /** 点这个词时它所在的句子 —— 判原形时给 AI 消歧用（left / saw 这类靠语境才准） */
  context?: string
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const router = useRouter()
const peek = ref<PeekResult | null>(null)
const busy = ref(false)
/** 刚加入词库的那个词 —— 用来把按钮换成「去补义项」 */
const justAdded = ref('')
/** 配了 AI 才承诺「AI 补全」，否则只让人去手改 */
const aiOn = aiReady

const hasContent = computed(() => !!peek.value?.senses.some((s) => s.gloss.trim()))
const title = computed(() => peek.value?.word?.word ?? peek.value?.lemma ?? '')

watch(
  [() => props.show, () => props.token],
  async ([show]) => {
    if (!show || !props.token) return
    justAdded.value = ''
    peek.value = await peekWord(props.token)
    pinned.value = await pinnedSense()
  },
  { immediate: true },
)

/* ── 排进明天练（D41 §6）──
 *
 *  ★ 为什么这一格值得做：看到生词的那一瞬间，人心里说的是「明天练这个词」。
 *    没有这条通道，它只能混在一堆新卡里等随机抽到，或者干脆被忘掉。
 *  ★ 只排**有例句**的义项：没例句的义项进不了出题池，排了也练不到，
 *    那等于给一个假承诺。没有就如实说「还没法练」。
 */
const pinned = ref<string>('')

async function pinnedSense(): Promise<string> {
  const p = peek.value
  if (!p?.senses.length) return ''
  const rows = await allProgress()
  const now = Math.floor(Date.now() / 1000)
  const hit = rows.find(
    (r) => p.senses.some((s) => s.id === r.senseId) && r.pinAt && r.pinAt > now,
  )
  return hit?.senseId ?? ''
}

/** 能练的那个义项：有例句、且没被标记为「有问题」 */
const practisable = computed(() => {
  const p = peek.value
  if (!p) return ''
  const hit = p.senses.find((s) => (p.sentenceCounts.get(s.id) ?? 0) > 0)
  return hit?.id ?? ''
})

async function togglePin(): Promise<void> {
  const id = pinned.value || practisable.value
  if (!id) {
    toast('这个词还没有例句，暂时没法练 —— 先进词条补一句')
    return
  }
  if (pinned.value) {
    await unpinSense(id)
    pinned.value = ''
    toast('已取消「明天练」')
    return
  }
  await pinSense(id, tomorrowStart())
  pinned.value = id
  toast('已排进明天 —— 明天第一组里就有它')
}

function close(): void {
  emit('close')
}

function goSense(id: string): void {
  close()
  void router.push(`/sense/${id}`)
}

function goWord(): void {
  if (!title.value) return
  close()
  void router.push(`/word/${encodeURIComponent(title.value)}`)
}

/** 刚加入的生词：直接去词条页，并让那边**当场**开始补全（?fill=1）。
 *  少一次「到了之后再找一个按钮」—— 那个按钮的形状和这一屏的完全不一样。 */
function goWordAndFill(): void {
  if (!title.value) return
  close()
  void router.push({ path: `/word/${encodeURIComponent(title.value)}`, query: { fill: '1' } })
}

async function add(): Promise<void> {
  const p = peek.value
  if (!p || busy.value || p.stop) return
  busy.value = true
  try {
    /* 句子里点到的词常常是屈折形式（armies / went），而它不在库时
       lookup 只能把原样当 lemma。这里让 AI 判一次原形，按原形建词条 ——
       否则词条、AI 补的义项和例句会一路都以复数/过去时的样子存在。 */
    let target = p.lemma
    if (!p.word && aiOn.value) {
      const base = await resolveLemma(p.token, props.context ?? '')
      if (base) target = base
    }
    const r = await addPendingWord(target)
    toast(
      r.existed
        ? `「${r.word}」本来就在词库里`
        : target !== p.token
          ? `已加入词库：${r.word}（原形；句中是 ${p.token}）`
          : `已加入词库：${r.word}`,
    )
    justAdded.value = r.word
    peek.value = await peekWord(target)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <van-popup
    :show="show"
    position="bottom"
    round
    close-on-popstate
    :style="{ maxHeight: '80vh' }"
    @close="close"
  >
    <div v-if="peek" class="pk">
      <header class="hd">
        <div class="w">
          <b>{{ title }}</b>
          <span v-if="peek.word?.ipa" class="ipa">/{{ peek.word.ipa }}/</span>
        </div>
        <span class="badge" :class="{ off: !peek.word }">
          {{ peek.word ? '在词库里' : '还没入库' }}
        </span>
      </header>

      <!-- 屈折形式说明：让人知道查的是哪个词，也顺手教一眼形态 -->
      <p v-if="!peek.exact && peek.token !== title" class="form">
        句子里是 <code>{{ peek.token }}</code> · 原形是 <code>{{ title }}</code>
      </p>

      <!-- 在库里：列出义项，点哪个进哪个。
           ★ 刚加进来的那一刻（justAdded）必须留在下面的确认态：
             add() 之后重新 peek 会带回刚建的占位义项，senses 变成 1 条，
             若只看 senses.length，「已加入 + 去补全」这层确认就永远渲染不出来，
             用户只剩一闪而过的 toast 和一行「还没有释义」。 -->
      <template v-if="peek.senses.length && !justAdded">
        <button
          v-for="s in peek.senses"
          :key="s.id"
          class="row"
          type="button"
          @click="goSense(s.id)"
        >
          <span class="gl">
            <template v-if="s.pos"><i>{{ s.pos }}</i></template>
            <template v-if="s.gloss">{{ s.gloss }}</template>
            <em v-else class="empty">还没有释义</em>
          </span>
          <span class="n">{{ peek.sentenceCounts.get(s.id) ? peek.sentenceCounts.get(s.id) + ' 句' : '暂无例句' }}</span>
          <span class="go">›</span>
        </button>
        <button class="btn ghost" type="button" @click="goWord">看这个词的整页</button>
        <!-- 排进明天：库里已有的词也能「我要练它」。 -->
        <button class="btn ghost" type="button" :disabled="!practisable && !pinned" @click="togglePin">
          {{ pinned ? '取消「明天练」' : '排进明天练' }}
        </button>
      </template>

      <!-- 不在库里 -->
      <template v-else>
        <p class="lead">
          <template v-if="peek.stop">
            「{{ title }}」是虚词，一般不用单独记。
          </template>
          <template v-else-if="justAdded">
            已加入词库。义项和例句可以现在补，也可以之后再说。
          </template>
          <template v-else>
            词库里还没有「{{ title }}」。加进来之后，义项和例句可以逐步补。
          </template>
        </p>
        <button
          v-if="!peek.stop && !justAdded"
          class="btn"
          type="button"
          :disabled="busy"
          @click="add"
        >
          {{ busy ? '加入中…' : `加入词库：${title}` }}
        </button>
        <button v-if="justAdded" class="btn" type="button" @click="goWordAndFill">
          {{ aiOn ? '让 AI 补全义项与例句' : '去补义项与例句' }}
        </button>
      </template>

      <p v-if="peek.word && hasContent" class="hint">
        点某一义项进它的详情；这一屏看过就回题上，不会丢掉这一轮。
      </p>
    </div>
  </van-popup>
</template>

<style scoped>
.pk {
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  overflow: auto;
  max-height: calc(80vh - 8px);
}

.hd {
  display: flex;
  align-items: baseline;
  gap: 10px;
  justify-content: space-between;
}

.hd .w {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.hd b {
  font-size: 21px;
  font-weight: 650;
}

.hd .ipa {
  font-size: 13px;
  color: var(--wb-ink-3);
}

.badge {
  flex: 0 0 auto;
  font-size: 11.5px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
}

.badge.off {
  background: var(--wb-line);
  color: var(--wb-ink-3);
}

.form {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.form code {
  font-family: ui-monospace, monospace;
  color: var(--wb-ink-2);
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--wb-line);
  background: transparent;
  padding: 12px 0;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
}

.row:last-of-type {
  border-bottom: 0;
}

.row:active {
  background: var(--wb-bg);
}

.row .gl {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  line-height: 1.5;
  color: var(--wb-ink);
}

.row .gl i {
  font-style: normal;
  font-size: 12px;
  color: var(--wb-ink-3);
  margin-right: 6px;
}

.row .gl .empty {
  font-style: normal;
  color: var(--wb-ink-3);
}

.row .n {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.row .go {
  flex: 0 0 auto;
  color: var(--wb-ink-3);
}

.lead {
  margin: 12px 0 14px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--wb-ink-2);
}

.btn {
  width: 100%;
  border: 0;
  border-radius: 12px;
  background: var(--primary);
  color: #fff;
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  padding: 12px;
  cursor: pointer;
}

.btn:active {
  filter: brightness(0.94);
}

.btn.ghost {
  margin-top: 12px;
  background: var(--wb-bg);
  color: var(--wb-ink-2);
  font-weight: 500;
  font-size: 14px;
}

.hint {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-ink-3);
}
</style>
