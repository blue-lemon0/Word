<script setup lang="ts">
/** 单词页 —— 这一层是**导航**，不是编辑界面。
 *  列全部意思，每个意思带熟练度/次数/下次复习，因为熟练度是按意思独立算的：
 *  只说「crime 我会了」，用户并不知道哪个意思还是生的。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmSheet from '../components/ConfirmSheet.vue'
import ImportSheet from '../components/ImportSheet.vue'
import AddWordSheet from '../components/AddWordSheet.vue'
import PromptSheet from '../components/PromptSheet.vue'
import { dueText, loadWord, masteryOf, repsText } from '../composables'
import {
  allSentences,
  db,
  progressNow,
  sentenceCountsNow,
  sensesOfWordNow,
  wordNow,
} from '../db'
import { addSense, purgeWord } from '../edit'
import { useDragReorder } from '../draglist'
import { aiPrompt } from '../import'
import { goBack } from '../nav'
import { toast } from '../toast'
import { describeAiError, type AiResult } from '../ai/types'
import { reviewWord } from '../ai/actions'
import { isConfigured } from '../ai/config'
import AiSheet from '../components/AiSheet.vue'
import type { Progress, Sense, Word } from '../types'
import { masteryPercent } from '../types'

const props = defineProps<{ word: string }>()
const router = useRouter()

const word = ref<Word | undefined>()
const senses = ref<Sense[]>([])
const prog = ref(new Map<string, Progress>())
const sentCount = ref(new Map<string, number>())

const showImport = ref(false)
const showPrompt = ref(false)
/** 「加进词库」弹层（搜到的生词） */
const showAdd = ref(false)

/* ── AI 审查（可选，配了才出现）──
 *  ★ 审查是**整词一次请求**：义项、例句一起带上，一次看全（省钱也看得准）。
 *  ★ 结果只是提议：AiSheet 里逐条看，点应用才落库（AI 没有写库的权限）。 */
const aiOn = ref(isConfigured())
const aiOpen = ref(false)
const aiBusy = ref(false)
const aiResult = ref<AiResult | null>(null)
const aiError = ref('')

async function runReview(): Promise<void> {
  aiError.value = ''
  aiResult.value = null
  aiOpen.value = true
  aiBusy.value = true
  try {
    aiResult.value = await reviewWord(props.word)
  } catch (e) {
    aiError.value = describeAiError(e)
  } finally {
    aiBusy.value = false
  }
}
/** 词条在不在库里。它和「有没有释义」是两件事，空态要分开说 */
const inLibrary = computed(() => word.value != null)

const promptText = computed(() =>
  aiPrompt(
    props.word,
    word.value?.ipa ?? '',
    senses.value.map((s) => ({
      slot: s.slot,
      gloss: s.gloss,
      glossEn: s.glossEn,
      note: s.note,
    })),
  ),
)

/**
 * 首帧同步读 —— 理由见 SensePage 顶部的注释（跳转那一帧不管渲染什么都是跳变）。
 *
 * 「例句条数」是**次要信息**：缓存没热时先画界面、随后补上，而不是整页退化成
 * 骨架屏（那正是原来闪一下的原因）。启动时会预热四张表，这里只是兜底。
 */
const countsReady = ref(false)

function readyFromMemory(name: string): boolean {
  const sens = sensesOfWordNow(name)
  if (!sens) return false
  const pg = progressNow(sens.map((s) => s.id))
  if (!pg) return false
  word.value = wordNow(name) ?? undefined
  senses.value = sens
  prog.value = pg
  const counts = sentenceCountsNow(sens.map((s) => s.id))
  if (counts) {
    sentCount.value = counts
    countsReady.value = true
  }
  return true
}

/** 例句条数没热时：等表读进来再算，期间界面上不写「0 句」（写了就是闪一下假数） */
async function fillCounts(ids: string[]): Promise<void> {
  if (countsReady.value || !ids.length) return
  await allSentences()
  const counts = sentenceCountsNow(ids)
  if (!counts) return
  sentCount.value = counts
  countsReady.value = true
}

/** 还在读库。内存里有就首帧直接给完整界面（没有那一帧的空白）。 */
const loading = ref(!readyFromMemory(props.word))

async function load(): Promise<void> {
  if (readyFromMemory(props.word)) {
    void fillCounts(senses.value.map((s) => s.id))
    return
  }
  loading.value = true
  try {
    const r = await loadWord(props.word)
    word.value = r.word
    senses.value = r.senses
    prog.value = r.prog
    // 只查这个词的义项，别扫全库例句表
    const ids = r.senses.map((s) => s.id)
    const m = new Map<string, number>()
    if (ids.length) {
      for (const s of await db.sentences.where('senseId').anyOf(ids).toArray()) {
        m.set(s.senseId, (m.get(s.senseId) ?? 0) + 1)
      }
    }
    sentCount.value = m
    countsReady.value = true
  } finally {
    loading.value = false
  }
}

watch(() => props.word, load, { immediate: true })

const MASTERY_TEXT = { mastered: '已掌握', learning: '学习中', new: '未学' } as const
const MASTERY_TYPE = { mastered: 'success', learning: 'warning', new: 'default' } as const

function mastery(s: Sense): keyof typeof MASTERY_TEXT {
  return masteryOf(prog.value.get(s.id))
}

async function onAddSense(): Promise<void> {
  const id = await addSense(props.word)
  toast('已加一个空义项，点进去填释义')
  router.push(`/sense/${id}`)
}

/**
 * 拖动排序落定。
 *
 *  ★ 同样是「先同步换本地顺序，再落库」。
 *    原因见 draglist 的 onUp 注释：清 transform 与数据更新必须落在同一个
 *    渲染批次，否则中间会出现「行已弹回、内容还是旧顺序」的错位帧。
 *
 *  只改显示编号 slot，**id 不动** —— 学习进度锚在 id 上，
 *  所以排序永远不会让熟练度错位（这是 UUID 锚点唯一的理由所在）。
 */
async function onReorder(from: number, to: number): Promise<void> {
  const sorted = [...senses.value].sort((a, b) => a.slot - b.slot)
  if (from === to || from < 0 || to < 0 || from >= sorted.length || to >= sorted.length) return
  // 同步换序
  const next = [...sorted]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  senses.value = next
// 接着才落库 + 以库为准校对
  await db.senses.bulkUpdate(next.map((s, i) => ({ key: s.id, changes: { slot: i + 1 } })))
  await db.words.update(props.word, { updatedAt: Date.now() })
  await load()
  // 这里原来弹过一句「顺序已换，进度没动」。已删：顺序变了界面自己就变了，
  // 而「进度没动」是在解释一件用户没问、也感知不到的事 —— 一句话白占屏幕。
}

/** 义项列表容器：拖动排序靠它量每一行的位置 */
const senseBox = ref<HTMLElement | null>(null)
const drag = useDragReorder(senseBox, onReorder)

/** 删除这个词：走确认弹层，不用原生 confirm()
 *  （WebView 里弹出来的是系统对话框，顶着 "The page at ..." 一行、
 *   按钮写着 CANCEL / OK，和这个 app 像是两套东西，见 ConfirmSheet）。 */
function onDeleteWord(): void {
  const word = props.word
  ask.value = {
    title: `删除「${word}」？`,
    text: '这个词的全部意思、例句和学习进度都会没，回收站里也不留。',
    okText: '删除',
    danger: true,
    run: async () => {
      await purgeWord(word)
      toast('已删除')
      router.push('/library')
    },
  }
}

const ask = ref<null | {
  title: string
  text: string
  okText: string
  danger?: boolean
  run: () => Promise<void>
}>(null)

function onAsk(): void {
  const a = ask.value
  if (!a) return
  ask.value = null
  void a.run()
}
</script>

<template>
  <div class="wb-page">
    <header class="wb-topbar">
      <div class="in">
        <van-icon name="arrow-left" size="18" @click="goBack(router, '/library')" />
        <h1>{{ props.word }}</h1>
        <van-button
          v-if="aiOn"
          size="mini"
          plain
          type="primary"
          :disabled="!senses.length"
          @click="runReview"
        >
          AI 审查
        </van-button>
        <van-button size="mini" plain type="primary" :disabled="!senses.length" @click="showPrompt = true">
          复制模板
        </van-button>
      </div>
    </header>

    <div class="wb-wrap">
      <!-- 读库中：骨架屏。顶栏已经画好了（标题就是路径里的词，本来就知道），
           所以这里只是把内容区占住，不闪「还没有释义」那句假话。 -->
      <template v-if="loading && !senses.length">
        <section class="wb-card skel">
          <div class="l w90" />
          <div class="l w40" />
        </section>
        <section class="wb-card skel">
          <div class="l w60" />
          <div class="l w90" />
        </section>
      </template>

      <template v-else>
      <section class="wb-card head">
        <div class="big">{{ props.word }}</div>
        <div v-if="word?.ipa" class="ipa">{{ word.ipa }}</div>
        <div class="tags">
          <van-tag v-if="senses.length" plain round type="primary">{{ senses.length }} 个意思</van-tag>
          <van-tag v-if="senses.some((s) => s.needsRefine)" plain round type="warning">需精修</van-tag>
          <van-tag v-if="senses.some((s) => s.trap)" plain round type="danger">易错</van-tag>
        </div>
      </section>

      <p class="lead">
        点任意意思进去 —— <b>每个意思是独立的学习单元和独立的记忆曲线</b>
      </p>

      <!-- 两句空态不是一回事，必须分开说：
       · 词条**根本不在库里**（从搜索框搜出来的生词）—— 要先加进来
       · 词条在、只是还没写释义 —— 直接补释义就行
       过去两种都显示「这个词还没有释义」，而第一种点「新增意思」会去
       更新一个不存在的词条（静默 no-op），留下一条没有词条的孤儿意思。 -->
      <van-empty
        v-if="!senses.length"
        :description="inLibrary ? '这个词还没有释义' : '这个词还不在词库里'"
      >
        <template #description>
          <div v-if="!inLibrary" class="wb-dim">
            搜到了但库里没有。加进词库之后就能给它写释义、加例句、一起背。
          </div>
          <div v-else class="wb-dim">还没有释义。加一个自己写，或从 AI 导入。</div>
        </template>
        <template v-if="!inLibrary" #default>
          <div class="addwrap2">
            <van-button type="primary" size="small" round @click="showAdd = true">
              加进词库
            </van-button>
          </div>
        </template>
      </van-empty>

      <AddWordSheet
        :open="showAdd"
        @close="showAdd = false"
        @added="(id) => { showAdd = false; router.push(`/sense/${id}`) }"
      />

      <div ref="senseBox" class="slist">
        <div
          v-for="(s, i) in senses"
          :key="s.id"
          class="sense"
          :data-drag-key="s.id"
          :style="drag.styleFor(String(s.id), i)"
          @click="router.push(`/sense/${s.id}`)"
        >
          <!-- 序号就是「第几个意思」。原来是 `s1`：那个 s 是数据字段 senseId
             的前缀，用户完全无从理解，而它同时又是拖动把手 ——
             用户看到的是一块看不懂的灰色标签，还要按住它拖。
             去掉 s 之后它才真的是「序号」。视觉上补了一枚浅底序号牌，
             让它读起来是「第 1 个」而不是「漏了个前缀」。 -->
          <span
            class="slot wb-drag-handle"
            title="长按拖动排序"
            @pointerdown="drag.startDrag($event, String(s.id))"
            @click.stop
            @contextmenu.prevent
            ><i>{{ s.slot }}</i></span
          >
          <div class="b">
            <div class="g">{{ s.gloss || '（空释义）' }}</div>
            <div class="m">
              <van-tag v-if="s.pos" plain round>{{ s.pos }}</van-tag>
              <van-tag plain round :type="MASTERY_TYPE[mastery(s)]">
                {{ MASTERY_TEXT[mastery(s)] }}
              </van-tag>
              <span>{{ repsText(prog.get(s.id)) }}</span>
              <span class="dot">·</span>
              <span>{{ dueText(prog.get(s.id)) }}</span>
              <!-- 例句条数没算出来之前不写「0 句」：那是个假数，
                   显示一帧再变成真数，又是一次可见的跳变 -->
              <template v-if="countsReady">
                <span class="dot">·</span>
                <span>{{ sentCount.get(s.id) ?? 0 }} 句</span>
              </template>
            </div>
          </div>
          <van-progress
            class="bar"
            :percentage="masteryPercent(prog.get(s.id))"
            :show-pivot="false"
            stroke-width="4"
            :color="
              mastery(s) === 'mastered'
                ? '#12a05c'
                : mastery(s) === 'learning'
                  ? '#f5a524'
                  : '#d5d8e0'
            "
          />
        </div>
      </div>
      <p v-if="senses.length > 1" class="tip">按住左边序号可拖动排序。</p>

      <div class="acts">
        <van-button size="small" plain icon="plus" @click="onAddSense">新增意思</van-button>
        <van-button size="small" plain icon="upgrade" @click="showImport = true">导入 JSON</van-button>
        <van-button size="small" plain type="danger" icon="delete-o" @click="onDeleteWord">
          删除这个词
        </van-button>
      </div>
      </template>
    </div>

    <ImportSheet :open="showImport" :word="props.word" @close="showImport = false" @done="load" />

    <!-- AI 提议：只摆「想改什么」，应用才落库 -->
    <AiSheet
      :show="aiOpen"
      :result="aiResult"
      :busy="aiBusy"
      :error="aiError"
      @close="aiOpen = false"
      @applied="load"
    />
    <ConfirmSheet
      :open="!!ask"
      :title="ask?.title ?? ''"
      :text="ask?.text"
      :ok-text="ask?.okText"
      :danger="ask?.danger"
      @close="ask = null"
      @confirm="onAsk()"
    />
    <PromptSheet
      :open="showPrompt"
      :title="`复制模板 · ${props.word}`"
      :text="promptText"
      @close="showPrompt = false"
    />
  </div>
</template>

<style scoped>
.head .big {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.5px;
}

.head .ipa {
  color: var(--wb-ink-3);
  font-size: 13px;
  margin-top: 2px;
}

.head .tags {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.lead {
  font-size: 12.5px;
  color: var(--wb-ink-2);
  margin: 4px 4px 10px;
}

.sense {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  padding: 12px 13px;
  margin-bottom: 8px;
  cursor: pointer;
}

.sense:active {
  background: var(--van-background);
}

.slot {
  flex: 0 0 auto;
  align-self: stretch;
  justify-content: center;
  /* 触摸目标撑到 44px 以上：11px 的编号直接当把手按不准。
     padding 扩大热区，负 margin 收回排版，视觉大小不变。 */
  padding: 12px 8px;
  margin: -12px -8px;
  border-radius: 8px;
}

/* 序号牌：圆形浅底 + 等宽数字，读起来是「第几个意思」。
   之前是 `s1` 加一个灰底圆角标签 —— 那个 s 是数据字段的前缀，
   不是任何缩写。去掉它之后这块地方必须看起来是**有意的序号**，
   否则会退化成光秃秃一个数字，用户更不知道按它干什么。
   圆形而不是方角：它是个编号牌，不是标签。 */
.slot i {
  font-style: normal;
  font-size: 12px;
  font-weight: 600;
  font-family: ui-monospace, monospace;
  color: var(--wb-ink-2);
  background: var(--wb-line);
  border-radius: 50%;
  width: 22px;
  height: 22px;
  line-height: 22px;
  text-align: center;
}

.sense .b {
  flex: 1;
  min-width: 0;
}

.sense .g {
  font-size: 15px;
  font-weight: 600;
}

.sense .m {
  font-size: 11.5px;
  color: var(--wb-ink-2);
  margin-top: 5px;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.dot {
  color: var(--wb-line);
}

.bar {
  width: 42px;
  flex: 0 0 auto;
}

.ord {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--wb-ink-3);
  padding: 2px;
}

.ord .off {
  opacity: 0.25;
  pointer-events: none;
}

.acts {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}
</style>