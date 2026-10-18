<script setup lang="ts">
/** 意思页 —— 编辑都在这一层。
 *
 *  三条交互准则：
 *   · 义项本身的字段就地编辑：点字即改，失焦才落库，不跳页
 *   · **例句反过来要显式进编辑态**：手指一碰就改的代价太高（见 editingId）
 *   · 不给「练这个意思」按钮：知道要练哪个意思，选题就成了送分
 *   · 义项操作（合并/拆分/删除）直接摆在卡片上，不藏进二级菜单
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmSheet from '../components/ConfirmSheet.vue'
import ImportSheet from '../components/ImportSheet.vue'
import BackBtn from '../components/BackBtn.vue'
import MarkedText from '../components/MarkedText.vue'
import PromptSheet from '../components/PromptSheet.vue'
import Sheet from '../components/Sheet.vue'
import { loadWord, repsText, dueText } from '../composables'
import {
  db,
  progressNow,
  restoreSense,
  sentencesNow,
  senseNow,
  sensesOfWordNow,
  softDeleteSense,
} from '../db'
import {
  addSentence,
  deleteSentence,
  mergeSenses,
  reorderSentences,
  resetProgress,
  splitSense,
  updateSentence,
  updateSense,
} from '../edit'
import { aiPrompt } from '../import'
import { useDragReorder } from '../draglist'
import { setAvoidTarget } from '../keyboard'
import { goBack } from '../nav'
import { toast } from '../toast'
import { addSentence as aiAddSentence, replaceSentence as aiReplaceSentence } from '../ai/actions'
import { aiReady } from '../ai/config'
import { describeAiError, type AiResult } from '../ai/types'
import AiSheet from '../components/AiSheet.vue'
import type { Progress, Sense, Sentence } from '../types'

/** 每个义项的例句目标数，与 content-kit/spec.yaml 的 sentences_per_sense 对齐。
 *  app 不读那份 YAML（那是内容产线的规格），改这里只改显示口径。 */
const TARGET = 5

const POS_LIST = ['', 'n.', 'v.', 'a.', 'adj.', 'adv.', 'vi.', 'vt.', 'prep.', 'conj.', 'pron.', 'num.']
const TIERS = [
  { text: '未分级', value: '' },
  { text: 'T1', value: 'T1' },
  { text: 'T2', value: 'T2' },
  { text: 'T3', value: 'T3' },
  { text: 'T4', value: 'T4' },
]

const props = defineProps<{ id: string }>()
const router = useRouter()

/**
 * 首帧就用内存里的表把界面填满。
 *
 * 跳转时的时序是：mount → 渲染**第一帧** → await 读库 → 第二帧。
 * 中间那一帧不管渲染什么都是一次可见的跳变 —— 渲染「找不到这个意思」是
 * 说假话（真机逐帧采样量到 37ms），渲染骨架屏是「页面空一下再突然长出来」
 * （CDP screencast 抓到的那一帧：只剩一张灰条卡片，标题栏都是空的）。
 *
 * 而这四张表本来就常驻内存（搜索/统计/训练队列都在用），写入钩子保证它们
 * 永远是新的 —— 所以没有理由不在首帧就用它。见 db.ts 的 cachedNow。
 */
const hit0 = senseNow(props.id)
const sense = ref<Sense | null>(hit0 ?? null)
const word = ref(hit0?.word ?? '')
const prog = ref<Progress | undefined>()
const sents = ref<Sentence[]>(hit0 ? (sentencesNow(hit0.id) ?? []) : [])
/** 同词的其他义项 —— 宽屏上做左侧切换栏（省掉来回跳页） */
const siblings = ref<Sense[]>(hit0 ? (sensesOfWordNow(hit0.word) ?? []) : [])
/** 诊断用：加载失败时把真实原因显示出来，而不是只说「不在了」 */
const err = ref('')

const showImport = ref(false)
const showPrompt = ref(false)
const showMerge = ref(false)
const showSplit = ref(false)
/** 词性 / 分级的选择弹层（替代 van-dropdown-menu，见模板注释） */
const showPos = ref(false)
const showTier = ref(false)
const others = ref<Sense[]>([])
/** 拆分时勾走哪些句子 */
const moveIds = ref<number[]>([])

/** 确认弹层（删例句 / 删义项 / 拆分填释义）共用一个。
 *  原来用的是 confirm() / prompt() —— 在 WebView 里弹出来的是系统对话框，
 *  顶上压着 "The page at https://appassets.androidplatform.net" 一行、
 *  按钮写着 CANCEL / OK，和这个 app 像是两套东西，见 ConfirmSheet。 */
interface Ask {
  title: string
  text: string
  okText: string
  danger?: boolean
  input?: boolean
  placeholder?: string
  run: (value: string) => Promise<void>
}
const ask = ref<Ask | null>(null)

function onAsk(v: string): void {
  const a = ask.value
  if (!a) return
  ask.value = null // 先收弹层，再干活 —— 不想让操作卡在弹层关不掉的状态
  void a.run(v)
}

const promptText = computed(() =>
  sense.value
    ? aiPrompt(word.value, '', [
        {
          slot: sense.value.slot,
          gloss: sense.value.gloss,
          glossEn: sense.value.glossEn,
          note: sense.value.note,
        },
      ])
    : '',
)

/** 词性/分级：下拉选中即落库，但**不**直接 v-model 到 sense 上——
 *  那样只改了内存里的对象，刷新就没了。走 @change 显式写库。 */
const pos = ref(hit0?.pos ?? '')
const tier = ref(hit0?.tier ?? '')

/** 还在读库。首帧已经从内存拿到数据时它是 false —— 于是**没有骨架屏那一帧**。
 *  只有冷启动直接进这个页面（表还没读进内存）才会退化到骨架屏。 */
const loading = ref(!hit0)

/** 内存里有没有这一页要用的全部数据。有就直接用，一次 IndexedDB 都不用查。 */
function readyFromMemory(id: string): boolean {
  const s = senseNow(id)
  if (!s) return false
  const sens = sensesOfWordNow(s.word)
  const sentList = sentencesNow(s.id)
  const pg = progressNow([s.id])
  if (!sens || !sentList || !pg) return false
  sense.value = s
  word.value = s.word
  pos.value = s.pos
  tier.value = s.tier
  prog.value = pg.get(s.id)
  sents.value = sentList
  others.value = sens.filter((x) => x.id !== s.id && x.deletedAt == null)
  siblings.value = sens.filter((x) => x.deletedAt == null || x.id === s.id)
  loading.value = false
  return true
}

async function load(): Promise<void> {
  if (readyFromMemory(props.id)) return
  loading.value = true
  // 先清掉上一个义项留下的痕迹：换了 id 再读失败时，「XX 的这个意思不在了」
  // 里那个 XX 会是**上一个**词的，读起来像是另一个意思出了问题。
  word.value = ''
  try {
    const s = await db.senses.get(props.id)
    if (!s) {
      // 真的不存在（合并掉的旧链接 / 从没有过）。不要在这里查库做诊断：
      // 万一 schema 不一致，count() 会再抛一次，把真正的错误掩盖掉。
      sense.value = null
      loading.value = false
      return
    }
    err.value = ''
  // 软删除的义项也照常显示，只是顶部挂一条横幅 + 就地还原。
  // 直接跳走等于「误删之后什么都找不回来」，而数据明明还在。
  sense.value = s
  word.value = s.word
  pos.value = s.pos
  tier.value = s.tier
  const r = await loadWord(s.word)
  prog.value = r.prog.get(s.id)
  sents.value = (await db.sentences.where('senseId').equals(s.id).toArray()).sort(
    (a, b) => a.idx - b.idx,
  )
  others.value = r.senses.filter((x) => x.id !== s.id && x.deletedAt == null)
  siblings.value = r.senses.filter((x) => x.deletedAt == null || x.id === s.id)
  } catch (e) {
    // 读失败与「不存在」是两回事：前者是环境坏了，必须说出来，
    // 否则用户只看到「不在了」，会去回收站里找一个根本没删过的义项。
    sense.value = null
    err.value = `读取出错：${String(e).slice(0, 120)}`
  }
  loading.value = false
}

/** 软删除的意思就地还原 */
async function onRestore(): Promise<void> {
  if (!sense.value) return
  await restoreSense(sense.value.id)
  toast('已还原')
  await load()
}

watch(() => props.id, load, { immediate: true })

/* ── 就地编辑：失焦才落库 ── */

function blurTo(s: Sense, field: keyof Sense, ev: Event): void {
  const val = (ev.target as HTMLElement).innerText.trim()
  if (val !== s[field]) updateSense(s.id, { [field]: val } as Partial<Sense>)
}

async function pick(field: 'pos' | 'tier', val: string): Promise<void> {
  if (!sense.value) return
  await updateSense(sense.value.id, { [field]: val } as Partial<Sense>)
  sense.value[field] = val as never
}

async function toggleTrap(): Promise<void> {
  if (!sense.value) return
  const v = sense.value.trap ? 0 : 1
  await updateSense(sense.value.id, { trap: v as 0 | 1 })
  sense.value.trap = v as 0 | 1
}

/* ── 例句 ── */

const newEn = ref('')
const newZh = ref('')
/** 添加例句的弹层。固定在底栏上的按钮打开它，
 *  这样不管下面有多少条例句，「添加」都不会被顶出屏幕。 */
const showAdd = ref(false)

/** 正在编辑的例句 id（同一时刻只有一句）。
 *
 *  ★ 例句**不能**像释义那样「点字即改」。
 *    之前每句都直接挂 contenteditable，于是：手指划过列表想滑一下、
 *    指尖恰好落在句子上，键盘就弹了；而例句是背单词的核心内容，
 *    手一抖多一个空格、删掉一个词，用户当场看不出来，等下次复习才发现。
 *    手机上没有 hover，「看着能不能改」这件事必须由**显式按钮**说清楚。
 *
 *  同理「删除」加确认（下面 onDelSentence）：删例句是硬删，没有回收站。
 */
const editingId = ref<number | null>(null)

async function onAddSentence(): Promise<void> {
  if (!sense.value || !newEn.value.trim()) return
  await addSentence(sense.value.id, word.value, newEn.value, newZh.value)
  newEn.value = ''
  newZh.value = ''
  // 加完就收起：连着加几句时重新打开的成本，比留着一个空表单低
  showAdd.value = false
  toast('已添加')
  await load()
}

/* ── AI（可选）：补一句 / 换一句 ──
 *  ★ 两个动作都只发**一次请求**，而且只带这个义项与它已有的例句 ——
 *    审查整词才需要整词上下文，换/补一句不需要，多带就是多花钱。
 *  ★ 结果只进 AiSheet（提议），点应用才落库；应用前自动存内容快照。 */
const aiOn = aiReady
const aiOpen = ref(false)
const aiBusy = ref(false)
const aiResult = ref<AiResult | null>(null)
const aiError = ref('')

async function runAi(fn: () => Promise<AiResult>): Promise<void> {
  aiError.value = ''
  aiResult.value = null
  aiOpen.value = true
  aiBusy.value = true
  try {
    aiResult.value = await fn()
  } catch (e) {
    aiError.value = describeAiError(e)
  } finally {
    aiBusy.value = false
  }
}

function onAiAdd(): void {
  const s = sense.value
  if (!s) return
  void runAi(() => aiAddSentence(s.id, 3))
}

function onAiReplace(sen: Sentence): void {
  if (sen.id == null) return
  void runAi(() => aiReplaceSentence(sen.id as number, ''))
}

/** 应用之后：收起浮层并刷新这一页 */
function onAiDone(): void {
  aiOpen.value = false
  void load()
}

/** 进编辑态。
 *
 *  两件事都要做，缺一个就会「点了没反应」：
 *   · 等 contenteditable 变成 true 再 focus —— 在还不可编辑的节点上
 *     focus 不会拉起键盘；
 *   · 把光标放到**句末**。focus() 默认落在开头，用户接着打字会插到句子
 *     最前面，得先往回拖一下才行。
 *  另外把「避让对象」换成整行：只保证英文那行露出来的话，它下面的译文
 *  和「改好了」按钮正好被键盘压住（见 keyboard.ts 的 setAvoidTarget）。 */
function onEdit(s: Sentence): void {
  editingId.value = s.id!
  void nextTick(() => {
    const row = sentBox.value?.querySelector<HTMLElement>(`.sent[data-sid="${s.id}"]`)
    const en = row?.querySelector<HTMLElement>('.en')
    en?.focus()
    if (en) {
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(en)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    setAvoidTarget(row ?? null)
  })
}

/** 退出编辑态。改动在 blur 里已经落库，这里只负责收回状态。 */
function onEditDone(): void {
  editingId.value = null
  setAvoidTarget(null)
}

/** 只有这一句现在能改。切换到别的例句时由 blur 先把上一句存掉，
 *  不需要在这里额外收尾。 */
function isEditing(s: Sentence): boolean {
  return editingId.value === s.id
}

/** 编辑中的例句不让拖动：拖一下会整表重排，光标和刚打的内容全丢 */
function onDragStart(s: Sentence, ev: PointerEvent): void {
  if (isEditing(s)) return
  drag.startDrag(ev, String(s.id))
}

/** 离开页面时收回避让目标：它是模块级状态，留着会让别的输入框
 *  去顶一个已经不在这一页的元素。 */
onBeforeUnmount(() => setAvoidTarget(null))

function blurSentence(s: Sentence, field: 'en' | 'zh', ev: Event): void {
  // 不在编辑态的失焦一律不写库：否则长按选词时随手点一下页面就能改内容
  if (!isEditing(s)) return
  const val = (ev.target as HTMLElement).innerText.trim()
  if (val !== s[field]) updateSentence(s.id!, { [field]: val })
}

function onDelSentence(s: Sentence): void {
  const brief = s.en.length > 40 ? `${s.en.slice(0, 40)}…` : s.en
  ask.value = {
    title: '删掉这句？',
    text: `${brief}\n\n删了就没了 —— 例句不进回收站，找不回来。`,
    okText: '删除',
    danger: true,
    run: async () => {
      if (isEditing(s)) onEditDone()
      await deleteSentence(s.id!)
      await load()
    },
  }
}

/**
 * 拖动排序落定。
 *
 *  ★ 第一步必须是**同步**换掉本地数组，然后再落库。
 *    原因在 draglist 的 onUp 里说了：清 transform 与数据更新必须落在
 *    同一个渲染批次，否则中间会出现「行已弹回、内容还是旧顺序」的错位帧
 *    （真机逐帧采样量到过 50ms 的空窗，快速拖动时整列看起来在闪）。
 *    先同步换序 → reset 去掉位移时底层顺序已经是对的 → 视觉上零跳动。
 *
 *  落库放在后面，且失败不阻塞界面：本地已经是新顺序了，
 *  大不了下次进来再被 load() 校回真实顺序。
 */
async function onReorder(from: number, to: number): Promise<void> {
  const list = sents.value
  if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return
  // 同步换序（不 await）
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  sents.value = next
  // 接着才落库 + 以库为准校对
  await reorderSentences(list, from, to)
  await load()
}

/** 例句列表容器：拖动排序要靠它量每一行的位置 */
const sentBox = ref<HTMLElement | null>(null)
const drag = useDragReorder(sentBox, onReorder)

async function onFlag(s: Sentence): Promise<void> {
  await updateSentence(s.id!, { flagged: s.flagged ? 0 : 1 })
  toast(s.flagged ? '已取消标记' : '已标记「这句有问题」，训练时不再出现')
  await load()
}

/* ── 义项操作 ── */

/** 合并 / 删除之后回单词页 —— 这里**必须** replace。
 *
 *  这两种操作之后当前义项已经不存在了（合并掉的删了、删掉的进回收站），
 *  再往回退只会退到一个「找不到这个意思」的页面上。用 replace 把这一格
 *  历史直接换成单词页，返回箭头随后退到真正的上一层（见 nav.ts 的同页判断）。
 *  普通返回不走这里，走 goBack —— 那是「回上一屏」，语义不同。
 */
function toWordPage(): void {
  router.replace(`/word/${word.value}`)
}

async function onMerge(targetId: string): Promise<void> {
  if (!sense.value) return
  const keep = sense.value.id
  await mergeSenses(keep, targetId)
  toast('已合并：两边的例句和熟练度都并进来了')
  showMerge.value = false
  toWordPage()
}

/** 拆分：新义项的释义在这里填（原来是一个 prompt() 弹窗）。 */
function onSplit(): void {
  if (!sense.value) return
  if (!moveIds.value.length) return
  ask.value = {
    title: '新义项的中文释义',
    text: '填一句能把它和原来那个意思区分开的话。',
    okText: '拆出去',
    input: true,
    placeholder: '例如：坏事、不幸的那一面',
    run: async (gloss) => {
      const id = await splitSense(sense.value!.id, gloss, moveIds.value)
      if (!id) return
      moveIds.value = []
      showSplit.value = false
      toast('已拆成两条，新义项的熟练度从零开始')
      router.push(`/sense/${id}`)
    },
  }
}

/**
 * 重新学这个意思：清零学习记录，例句和释义留着。
 *
 *  走确认弹层而不是直接清 —— 它把「已经记住的东西」推回零，
 *  而学习进度是用户最不该被误触清掉的数据（D33 的同一条原则）。
 */
function onResetProgress(): void {
  const s = sense.value
  if (!s) return
  const wasMastered = prog.value?.mastered === 1
  ask.value = {
    title: '从头再学一遍？',
    text: wasMastered
      ? '这个词现在算「已掌握」。清零之后它会重新排期，你背过的记录不再生效，但例句和释义都在。'
      : '清掉这个词的复习次数、熟练度和到期时间。它会重新排期，例句和释义都在。',
    okText: '清零重学',
    danger: true,
    run: async () => {
      await resetProgress(s.id)
      toast('已清零，重新排期了')
      await load()
    },
  }
}

function onDelete(): void {
  if (!sense.value) return
  ask.value = {
    title: '删掉这个意思？',
    text: '例句和熟练度都留着，30 天内可以从「更多 → 回收站」还原。',
    okText: '删除',
    danger: true,
    run: async () => {
      await softDeleteSense(sense.value!.id)
      toast('已进回收站')
      toWordPage()
    },
  }
}
</script>

<template>
  <div v-if="sense" class="wb-page two-col">
    <!-- 宽屏：左边列出这个词的其它意思，点一下就切过去。
         移动端这块是空的 —— 单列布局不需要它，也挤不下。 -->
    <nav class="side">
      <div class="side-h">{{ word }}</div>
      <router-link
        v-for="o in siblings"
        :key="o.id"
        class="side-i"
        :class="{ on: o.id === sense.id }"
        :to="`/sense/${o.id}`"
      >
        <span class="slot">{{ o.slot }}</span>
        <span class="g">{{ o.gloss || '（空释义）' }}</span>
      </router-link>
      <van-button class="back-all" size="small" plain block :to="`/word/${word}`">
        看这个词的全部意思
      </van-button>
    </nav>

    <div>
      <header class="wb-topbar">
        <div class="in">
          <BackBtn @click="goBack(router, `/word/${word}`)" />
          <h1>{{ word }}</h1>
          <van-tag plain round type="primary">{{ repsText(prog) }} · {{ dueText(prog) }}</van-tag>
        </div>
      </header>

      <div class="wb-wrap">
        <van-notice-bar
          v-if="sense.deletedAt != null"
          color="#92400e"
          background="#fff7e8"
          wrapable
          :scrollable="false"
          left-icon="warning-o"
        >
          这个意思已进回收站（不会出题了）。
          <van-button size="mini" plain type="warning" @click="onRestore">就地还原</van-button>
        </van-notice-bar>

        <section class="wb-card">
          <div class="meta">
            <!-- ★ 不用 van-dropdown-menu：在部分 Android WebView 上它会让渲染进程
                 崩溃（Vant 里最重的组件，popup + 滚动监听）。移动端本来也是
                 「点一下弹出来选」更好，两个按钮 + 一个弹层就够了。 -->
            <van-button size="small" plain @click="showPos = true">
              {{ pos || '词性' }}
            </van-button>
            <van-button size="small" plain @click="showTier = true">
              {{ tier || '分级' }}
            </van-button>
            <van-tag :type="sense.trap ? 'warning' : 'default'" plain round @click="toggleTrap">
              {{ sense.trap ? '★ 易错' : '☆ 易错' }}
            </van-tag>
          </div>

          <div
            class="gloss wb-edit"
            contenteditable="true"
            spellcheck="false"
            data-ph="中文释义"
            @blur="blurTo(sense, 'gloss', $event)"
          >
            {{ sense.gloss }}
          </div>
          <div
            class="glossEn wb-edit"
            contenteditable="true"
            spellcheck="false"
            data-ph="英文释义（可空）"
            @blur="blurTo(sense, 'glossEn', $event)"
          >
            {{ sense.glossEn }}
          </div>
          <div
            class="note wb-edit"
            contenteditable="true"
            spellcheck="false"
            data-ph="备注：这个意思的区分线索（可空）"
            @blur="blurTo(sense, 'note', $event)"
          >
            {{ sense.note }}
          </div>

          <van-space class="acts" wrap>
            <van-button size="small" plain :disabled="!others.length" @click="showMerge = true">
              合并
            </van-button>
            <van-button size="small" plain @click="showSplit = true">拆分</van-button>
            <van-button size="small" plain @click="onResetProgress">重新学</van-button>
            <van-button size="small" plain type="danger" @click="onDelete">删除</van-button>
          </van-space>
        </section>

        <div class="shead">
          <b>例句 {{ sents.length }}/{{ TARGET }}</b>
          <span class="wb-sp" />
          <van-button size="mini" plain @click="showPrompt = true">复制给 AI</van-button>
          <van-button size="mini" plain type="primary" @click="showImport = true">导入</van-button>
        </div>

        <div ref="sentBox" class="sentlist">
          <div
            v-for="(s, i) in sents"
            :key="s.id"
            class="sent"
            :class="{ on: isEditing(s) }"
            :data-drag-key="s.id"
            :data-sid="s.id"
            :style="drag.styleFor(String(s.id), i)"
          >
            <span
              class="n wb-drag-handle"
              title="长按拖动排序"
              @pointerdown="onDragStart(s, $event)"
              @contextmenu.prevent
              ><i>{{ i + 1 }}</i></span
            >
            <div class="b">
              <!-- editable + wb-edit 都只在编辑态挂上：
                   非编辑态保留 .wb-edit 的话，:hover 的底色会暗示「这里能改」，
                   而手机上没有 hover —— 用户只能靠这个判断能不能动。 -->
              <div
                class="en"
                :class="{ 'wb-edit': isEditing(s) }"
                :contenteditable="isEditing(s)"
                spellcheck="false"
                @blur="blurSentence(s, 'en', $event)"
              >
                <MarkedText :text="s.en" :form="s.form" :span-start="s.spanStart" :span-len="s.spanLen" />
              </div>
              <div
                class="zh"
                :class="{ 'wb-edit': isEditing(s) }"
                :contenteditable="isEditing(s)"
                spellcheck="false"
                data-ph="中文翻译"
                @blur="blurSentence(s, 'zh', $event)"
              >
                {{ s.zh }}
              </div>
              <div class="ops">
                <van-button size="mini" plain :type="s.flagged ? 'warning' : 'default'" @click="onFlag(s)">
                  {{ s.flagged ? '★ 有问题' : '☆ 标记' }}
                </van-button>
                <van-button v-if="aiOn" size="mini" plain @click="onAiReplace(s)">AI 换一句</van-button>
                <span class="wb-sp" />
                <van-button v-if="!isEditing(s)" size="mini" plain icon="edit" @click="onEdit(s)">
                  改
                </van-button>
                <van-button
                  v-if="isEditing(s)"
                  size="mini"
                  type="primary"
                  plain
                  icon="success"
                  @click="onEditDone()"
                >
                  改好了
                </van-button>
                <van-button size="mini" plain type="danger" @click="onDelSentence(s)">删除</van-button>
              </div>
            </div>
          </div>
        </div>
        <p class="tip">按住左边序号可拖动排序；点「改」才能修改这句。</p>

        <div class="addwrap">
          <button class="addtrigger" @click="showAdd = true">
            <van-icon name="plus" size="16" />
            添加例句
            <span class="cnt">{{ sents.length }}/{{ TARGET }}</span>
          </button>
        </div>
        <!-- AI 补例句：和「添加例句」并列，但它是**生成**而不是手写 -->
        <div v-if="aiOn" class="aiadd">
          <van-button size="small" plain block :loading="aiBusy" @click="onAiAdd">
            让 AI 补 3 条候选例句
          </van-button>
        </div>
      </div>

      <!-- 添加例句：放在底部弹层里，不随列表长度漂走。
         之前是列表末尾的常驻表单：没有例句时它正好在屏幕底部，
         看着挺好；一旦有了好几条例句，它就被顶到屏幕外面去了 ——
         每加一句都要先滚到底部、再滚回来，非常折磨。
         改成固定底栏上的一个按钮 + 弹层：不管列表多长，
         「添加」永远在拇指够得到的地方，列表自己滚。 -->
      <Sheet :open="showAdd" title="添加例句" @close="showAdd = false">
        <van-field
          ref="newEnField"
          v-model="newEn"
          placeholder="英文例句"
          rows="2"
          autosize
          label=""
          @keyup.enter="onAddSentence"
        />
        <van-field
          v-model="newZh"
          placeholder="中文翻译（可空）"
          rows="2"
          autosize
          label=""
          @keyup.enter="onAddSentence"
        />
        <template #footer>
          <div class="addfoot">
            <van-button size="small" plain @click="showAdd = false">取消</van-button>
            <van-button size="small" type="primary" :disabled="!newEn.trim()" @click="onAddSentence">
              添加
            </van-button>
          </div>
        </template>
      </Sheet>
      <Sheet :open="showMerge" title="合并到哪一条？" @close="showMerge = false">
        <p class="hint">
          被合并的那条会消失，它的例句追加到保留项后面，熟练度两边相加取高。
        </p>
        <div v-for="o in others" :key="o.id" class="pick" @click="onMerge(o.id)">
          <span class="slot">{{ o.slot }}</span>
          <span class="g">{{ o.gloss }}</span>
        </div>
        <van-empty v-if="!others.length" description="这个词只有这一个意思，没得合并" />
      </Sheet>

      <!-- 拆分：勾走要挪过去的句子 -->
      <Sheet :open="showSplit" title="拆成两条" @close="showSplit = false">
        <p class="hint">
          新义项要有自己的释义，也要有自己的句子。<br />
          勾上要<b>挪走</b>的句子，剩下的留在原义项。熟练度不复制 —— 新义项从零开始。
        </p>
        <van-checkbox-group v-model="moveIds">
          <div v-for="(s, i) in sents" :key="s.id" class="pick">
            <van-checkbox :name="s.id!" shape="square" />
            <span class="n">{{ i + 1 }}</span>
            <span class="g">{{ s.en }}</span>
          </div>
        </van-checkbox-group>
        <template #footer>
          <van-button size="small" @click="showSplit = false">取消</van-button>
          <van-button size="small" type="primary" :disabled="!moveIds.length" @click="onSplit">
            拆出去
          </van-button>
        </template>
      </Sheet>

      <!-- 词性 / 分级：点按钮弹出来选 -->
      <Sheet :open="showPos" title="词性" @close="showPos = false">
        <div class="chips">
          <button
            v-for="p in POS_LIST"
            :key="p"
            class="chip"
            :class="{ on: pos === p }"
            @click="pick('pos', p); showPos = false"
          >
            {{ p || '未标' }}
          </button>
        </div>
      </Sheet>

      <Sheet :open="showTier" title="分级（决定起始间隔）" @close="showTier = false">
        <div class="chips">
          <button
            v-for="t in TIERS"
            :key="t.value"
            class="chip"
            :class="{ on: tier === t.value }"
            @click="pick('tier', t.value); showTier = false"
          >
            {{ t.text }}
          </button>
        </div>
      </Sheet>

      <ImportSheet :open="showImport" :word="word" @close="showImport = false" @done="load" />
      <ConfirmSheet
        :open="!!ask"
        :title="ask?.title ?? ''"
        :text="ask?.text"
        :ok-text="ask?.okText"
        :danger="ask?.danger"
        :input="ask?.input"
        :placeholder="ask?.placeholder"
        @close="ask = null"
        @confirm="onAsk"
      />
      <PromptSheet
        :open="showPrompt"
        :title="`复制给 AI · ${word}`"
        :text="promptText"
        @close="showPrompt = false"
      />
      <!-- AI 提议：补一句 / 换一句都走这张浮层（同一种「提议」，不分两套 UI） -->
      <AiSheet
        :show="aiOpen"
        :result="aiResult"
        :busy="aiBusy"
        :error="aiError"
        @close="aiOpen = false"
        @applied="onAiDone"
      />
    </div>
  </div>

  <!-- ★ 读库中：骨架屏。
       不是「什么都没显示」，也不是「找不到这个意思」——
       后者在跳转的一瞬间闪出来（真机逐帧采样量到 37ms），用户会以为刚点的
       义项被删了。顶部同样留一条等高的空标题栏，否则内容会先顶到状态栏下面、
       真页出来时再整体下移一下，那一下跳动比闪文案更明显。 -->
  <div v-else-if="loading" class="wb-page">
    <header class="wb-topbar">
      <div class="in"><h1>&nbsp;</h1></div>
    </header>
    <div class="wb-wrap">
      <section class="wb-card skel">
        <div class="l w40" />
        <div class="l w90" />
        <div class="l w60" />
      </section>
    </div>
  </div>

  <!-- ★ 找不到义项（软删除后直接访问、或合并后旧链接）也必须留在 .wb-page 里。
       漏了底部内边距的话，内容会被固定 tabbar 盖住，点什么都落在 tabbar 上，
       表现成「整页卡死、所有按钮都没反应」—— 很难联想到是少了个 class。 -->
  <div v-else class="wb-page gone">
    <van-empty description="找不到这个意思（可能已删）">
      <template #description>
        <div class="wb-dim">
          {{ word ? `${word} 的这个意思不在了` : '这个意思不在了' }}<br />
          可能已删进回收站，或合并到了别的意思上。
        </div>
        <div v-if="err" class="dbg">{{ err }}</div>
      </template>
      <van-space justify="center">
        <van-button size="small" plain to="/library">回词库</van-button>
        <van-button
          v-if="word"
          size="small"
          plain
          type="primary"
          :to="`/word/${word}`"
        >
          看 {{ word }} 的其它意思
        </van-button>
      </van-space>
    </van-empty>
  </div>
</template>

<style scoped>
/* 给底部固定的「添加例句」条让位。
   要的是**底部**留白。之前用一个空的 <div> 来占位，结果把它插在了
   .wb-wrap 的**最上面** —— 顶部凭空多出 56px 空块（真机实测 topbar 下沿
   81px，第一张卡片却在 137px 开始），正是「顶部浪费一段空白」。
   直接用 padding-bottom，不留任何多余元素。 */
.wb-wrap {
  padding-bottom: 56px;
}
.gone {
  padding-top: 40px;
}

.dbg {
  margin-top: 10px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--van-danger-color);
  word-break: break-all;
}
.two-col {
  display: block;
}

.side {
  display: none;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.chip {
  font-family: inherit;
  font-size: 15px;
  padding: 9px 16px;
  border-radius: 10px;
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  color: var(--wb-ink);
  cursor: pointer;
}

.chip.on {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
  background: var(--van-primary-color-opacity-1, #eef2ff);
  font-weight: 600;
}

.dd {
  flex: 1;
  min-width: 0;
  height: 32px;
  background: var(--wb-bg);
  border-radius: 8px;
}

.gloss {
  font-size: 19px;
  font-weight: 600;
  line-height: 1.45;
  padding: 4px;
}

.glossEn {
  font-size: 13px;
  color: var(--wb-ink-2);
  margin-top: 8px;
  line-height: 1.55;
  padding: 4px;
}

.note {
  font-size: 12.5px;
  color: #8a5a12;
  background: #fff7e8;
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 10px;
  line-height: 1.6;
}

.acts {
  margin-top: 14px;
}

.tip {
  font-size: 11.5px;
  color: var(--wb-ink-3);
  margin: 10px 2px 0;
  line-height: 1.6;
}

.shead {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 16px 4px 8px;
}

.shead b {
  font-size: 14px;
}

.sent {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  padding: 11px 12px;
  margin-bottom: 8px;
}

/* 正在编辑的例句：整行描边 + 淡蓝底。
   这一点很关键 —— 编辑是「例外状态」，必须一眼看出来现在这一句是能改的、
   别的一句不能。改完点「改好了」边框消失，状态就回到只读。 */
.sent.on {
  border: 1px solid var(--wb-primary);
  background: #f7f7ff;
}

/* 拖动把手：序号本身就是把手（全局视觉在 style.css 的 .wb-drag-handle）。
   为什么不给它加一个陌生图标：序号本来就是「这几行是有序的」的唯一视觉线索，
   把「按住这里能拖」直接挂在它上面，用户一眼就能联想到拖顺序。

   ★ 把手撑满整行、垂直居中。
     之前是 align-self:flex-start + 固定一小段 padding，热区只有顶上二十来 px
     且偏左。例句行是「英文 + 译文 + 操作按钮」两三行高，手指想按住它得瞄着
     左上角那个小数字 —— 行越长越难点准（行高 200px 时热区还在最上面 1/8）。
     撑满之后整列竖向都是热区，瞄行中间就行；长按 350ms 的判定还在，
     不会因为热区变大就误触发。 */
.sent .n {
  flex: 0 0 auto;
  align-self: stretch;
  justify-content: center;
  /* padding 把热区顶出卡片，负 margin 再收回排版：视觉上还是原来那个小数字 */
  padding: 11px 8px;
  margin: -11px -8px;
  border-radius: 10px;
}

/* 数字本身再大一点点：两行高的行里，11px 的数字太不起眼，
   容易被当成「只是个序号」而不是「这里能抓」。 */
.sent .n i {
  font-style: normal;
  font-size: 12px;
  font-weight: 600;
  font-family: ui-monospace, monospace;
  color: var(--wb-ink-3);
}

.sent .b {
  flex: 1;
  min-width: 0;
}

.en {
  font-size: 14.5px;
  line-height: 1.6;
}

.zh {
  font-size: 12.5px;
  color: var(--wb-ink-2);
  margin-top: 4px;
}

.ops {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
  opacity: 0.75;
}

.add {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 添加例句：固定在底部的一条。
   之前表单在列表末尾 —— 列表越长它越靠下，最后完全出屏。 */
.addwrap {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(var(--wb-tabbar-h) + var(--wb-safe-bottom));
  z-index: 90;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--wb-bg) 92%, transparent);
  backdrop-filter: blur(10px);
  border-top: 1px solid var(--wb-line);
}

.addtrigger {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 44px;
  border: 1px dashed var(--wb-line);
  border-radius: 12px;
  background: var(--wb-card);
  color: var(--wb-primary);
  font-family: inherit;
  font-size: 14.5px;
  font-weight: 600;
  cursor: pointer;
}

.addtrigger .cnt {
  color: var(--wb-ink-3);
  font-weight: 400;
  font-size: 12px;
}

/* AI 补例句：和固定的「添加例句」条分开摆 ——
   它是生成（要等、要花钱），不该长得跟「立刻就能写」一样。
   margin-bottom 让出固定条的高度，否则最后这个按钮永远被压在条下面。 */
.aiadd {
  margin: 10px 0 calc(64px + var(--wb-safe-bottom));
}

.addfoot {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.hint {
  background: #eef2ff;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: #3730a3;
  margin: 0 0 12px;
  line-height: 1.65;
}

.pick {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 12px;
  border-radius: 11px;
  background: var(--wb-card);
  margin-bottom: 8px;
  cursor: pointer;
}

/* 序号牌：与单词页同一个样子（圆形浅底 + 等宽数字），
   两页的序号长得不一样会让人以为是两种东西。 */
.slot {
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
  flex: 0 0 auto;
}

.pick .n {
  font-size: 11px;
  color: var(--wb-ink-3);
  flex: 0 0 auto;
}

.pick .g {
  font-size: 13.5px;
  min-width: 0;
}

@media (min-width: 900px) {
  .two-col {
    display: grid;
    grid-template-columns: 250px 1fr;
    gap: 20px;
    max-width: 1060px;
    margin: 0 auto;
    padding: 16px 16px 40px;
    align-items: start;
  }

  .side {
    display: block;
    position: sticky;
    top: 16px;
    background: var(--wb-card);
    border-radius: var(--wb-radius);
    padding: 12px;
  }

  .side-h {
    font-size: 17px;
    font-weight: 600;
    margin-bottom: 8px;
  }

  .side-i {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 9px;
    border-radius: 9px;
    color: inherit;
    text-decoration: none;
    font-size: 13.5px;
  }

  .side-i:hover {
    background: var(--wb-bg);
  }

  .side-i.on {
    background: #eef2ff;
    color: var(--wb-primary);
    font-weight: 600;
  }

  .side-i .slot {
    flex: 0 0 auto;
    margin-top: 2px;
  }

  .side-i .g {
    min-width: 0;
  }

  .back-all {
    margin-top: 8px;
  }

  .wb-topbar {
    position: static;
  }
}
</style>