<script setup lang="ts">
/** 首页 = **随手背一句**（随机背诵）。
 *
 *  ★ 这一页的判据变了三次，现在定在这儿：
 *    1. 最初是「搜索 + 一个随机词 + 去训练」—— 搜索抢了主线（D44 删掉）；
 *    2. 后来是「一个随机词 + 统计 + 去训练」—— 卡片只能看、不能背，
 *       想背还得跳进训练，等于把首页做成了一张海报；
 *    3. 现在：**打开就能背**。卡片上直接「点一下看意思」，看明白了就「换一个」，
 *       想认真练就「练这一句」。统计只剩一句副标题写在按钮上。
 *
 *  ★ 为什么这一页值得这么设计：人打开一个背单词 app 的真实动作是
 *    「碎片时间看一眼」。如果首页只能看、不能背，那它每次都要多一次跳转 ——
 *    跳转三次之后，人就只在「今天有到期」的时候才打开它了。
 *
 *  ★ 首帧同步取（randomCardNow）：`undefined` = 还在读库（给骨架），
 *    `null` = 确实没有（给空态）。两者必须分开 —— 数据没到就说「没有」
 *    是在说用户的词库没了（坑 32）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import InstallPrompt from '../components/InstallPrompt.vue'
import MarkedText from '../components/MarkedText.vue'
import WordPeek from '../components/WordPeek.vue'
import {
  loadStats,
  loadStatsNow,
  randomCardNow,
  randomCardWithSentence,
  type Card,
  type Stats,
} from '../composables'
import { db } from '../db'
import type { Sense } from '../types'

const router = useRouter()

const card = ref<Card | null | undefined>(randomCardNow())
const stats = ref<Stats | undefined>(loadStatsNow())

/* ── 看没看答案 ── */
const revealed = ref(false)
/** 这句要教的那个意思（点开答案才查，省得每次换卡都多一次读库） */
const sense = ref<Sense | null>(null)

async function doReveal(): Promise<void> {
  if (revealed.value) return
  const c = card.value
  if (!c) return
  sense.value = (await db.senses.get(c.senseId)) ?? null
  revealed.value = true
}

async function roll(): Promise<void> {
  card.value = await randomCardWithSentence()
  stats.value = await loadStats()
  revealed.value = false
  sense.value = null
  refreshHint()
}

/** 「去复习」按钮上的副标题：说清点了会发生什么 */
const trainHint = ref('')

function refreshHint(): void {
  const s = stats.value
  if (!s) return
  if (s.senses === 0) {
    trainHint.value = '先去词库导入'
    return
  }
  if (s.due > 0) trainHint.value = `今天 ${s.due} 题到期`
  else if (s.words > 0) trainHint.value = '今天没到期的，可以练新卡'
  else trainHint.value = '先去词库导入'
}

/* ── 「练这一句」：进训练页的单句练（那里有解析、能返回） ── */
const canDrill = computed(() => !!card.value)

function drill(): void {
  const c = card.value
  if (!c) return
  router.push({
    path: '/train',
    query: { solo: c.senseId, sent: String(c.sentence.id) },
  })
}

function goWord(): void {
  const c = card.value
  if (!c) return
  router.push(`/word/${encodeURIComponent(c.word)}`)
}

/* ── 例句里点词：浮层，不跳页 ── */
const peekOpen = ref(false)
const peekToken = ref('')

function pick(word: string): void {
  if (card.value && word === card.value.word.toLowerCase()) return
  peekToken.value = word
  peekOpen.value = true
}

refreshHint()

onMounted(async () => {
  // 冷启动直接进首页（桌面图标、书签）时表还没热，去读一次
  if (card.value === undefined) await roll()
})
</script>

<template>
  <div class="wb-page home">
    <div class="wb-wrap">
      <InstallPrompt />

      <!-- 一张卡：词 + 音标 + 一句例句（例句里的任何词都能点开看） -->
      <div v-if="card" class="stage">
        <div class="wbox">
          <button class="w" @click="goWord">{{ card.word }}</button>
          <span v-if="card.ipa" class="ipa">/{{ card.ipa }}/</span>
        </div>

        <p class="sn">
          <MarkedText
            :text="card.sentence.en"
            :form="card.sentence.form"
            :span-start="card.sentence.spanStart"
            :span-len="card.sentence.spanLen"
            pickable
            @pick="pick"
          />
        </p>

        <!-- 点一下看意思：这是这一页的核心动作 -->
        <button v-if="!revealed" class="reveal" type="button" @click="doReveal">
          点一下看意思
        </button>
        <div v-else class="ans">
          <p class="g">
            <span class="pos">{{ sense?.pos || '—' }}</span>
            <span class="gt">{{ sense?.gloss || '（这个意思还没有释义）' }}</span>
          </p>
          <p v-if="card.sentence.zh" class="zh">{{ card.sentence.zh }}</p>
          <p v-if="sense?.note" class="note">{{ sense.note }}</p>
          <p class="ns">{{ card.nSenses }} 个意思 · 这个意思在练的时候会单独计数</p>
        </div>
      </div>

      <div v-else-if="card === undefined" class="stage skel">
        <div class="wbox">
          <div class="l w40" />
        </div>
        <div class="l w60" />
        <div class="l w90" />
      </div>

      <div v-else class="stage">
        <div class="empty">词库还是空的</div>
        <div class="tap">先去词库导入一份词库</div>
      </div>

      <!-- 三个动作：换一个 / 练这一句 / 去复习 -->
      <div class="acts">
        <div class="row2">
          <button class="mbtn" type="button" @click="roll">
            <van-icon name="replay" size="17" />
            换一个
          </button>
          <button class="mbtn" type="button" :disabled="!canDrill" @click="drill">
            <van-icon name="aim" size="17" />
            练这一句
          </button>
        </div>
        <button class="big" type="button" @click="router.push('/train')">
          <b>去复习</b>
          <span>{{ trainHint }}</span>
        </button>
      </div>
    </div>

    <!-- 例句里点词：浮层，不跳页（和训练页同一个组件、同一套行为） -->
    <WordPeek :show="peekOpen" :token="peekToken" @close="peekOpen = false" />
  </div>
</template>

<style scoped>
/* 背景：纯 CSS 渐变 + 两团柔光（APK 离线可用，不塞图片资源） */
.home {
  min-height: calc(100dvh - var(--wb-tabbar-h));
  display: flex;
  flex-direction: column;
  position: relative;
  overflow-x: clip;
  background:
    radial-gradient(1200px 600px at 10% -10%, #eef2ff 0%, rgba(238, 242, 255, 0) 60%),
    radial-gradient(900px 500px at 100% 0%, #f5f3ff 0%, rgba(245, 243, 255, 0) 55%),
    var(--wb-bg);
}

.wb-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding-top: calc(14px + env(safe-area-inset-top, 0px));
}

/* ── 卡 ── */
.stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 8px 4px 12px;
  min-height: 0;
}

.wbox {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}

.w {
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 40px;
  font-weight: 750;
  letter-spacing: -1px;
  color: var(--wb-ink);
  padding: 0;
  cursor: pointer;
  line-height: 1.15;
}

.ipa {
  font-size: 13px;
  color: var(--wb-ink-3);
}

.sn {
  margin: 16px 0 0;
  font-size: 18px;
  line-height: 1.7;
  text-align: center;
  color: var(--wb-ink);
}

/* 点一下看意思：虚线框，明确是「可以点」 */
.reveal {
  margin: 22px auto 0;
  width: 100%;
  max-width: 320px;
  padding: 12px;
  border: 1px dashed var(--wb-line);
  background: rgba(255, 255, 255, 0.7);
  border-radius: 12px;
  font-family: inherit;
  font-size: 14px;
  color: var(--wb-ink-3);
  cursor: pointer;
}

.reveal:active {
  background: #fff;
}

.ans {
  margin: 18px auto 0;
  width: 100%;
  max-width: 380px;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 14px;
  padding: 12px 14px;
}

.ans .g {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.ans .pos {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.ans .gt {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
}

.ans .zh {
  margin-top: 6px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--wb-ink-2);
}

.ans .note {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-ink-3);
}

.ans .ns {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--wb-line);
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

/* 骨架 / 空态 */
.skel .l {
  height: 14px;
  border-radius: 7px;
  background: linear-gradient(90deg, #ececf3 25%, #f6f6fa 37%, #ececf3 63%);
  background-size: 400% 100%;
  animation: sh 1.4s ease-in-out infinite;
  margin: 10px auto 0;
}

.skel .w40 {
  height: 34px;
  width: 40%;
  border-radius: 10px;
}

.w60 {
  width: 60%;
}

.w90 {
  width: 90%;
}

@keyframes sh {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

.empty {
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  color: var(--wb-ink);
}

.tap {
  text-align: center;
  font-size: 13px;
  color: var(--wb-ink-3);
  margin-top: 6px;
}

/* ── 动作 ── */
.acts {
  flex: 0 0 auto;
  padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
}

.row2 {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}

.mbtn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 11px 10px;
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  border-radius: 14px;
  font-family: inherit;
  font-size: 14px;
  color: var(--wb-ink);
  cursor: pointer;
}

.mbtn:disabled {
  color: var(--wb-ink-3);
  opacity: 0.6;
}

.mbtn:active:not(:disabled) {
  background: var(--wb-bg);
}

.big {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 13px 14px;
  border: 0;
  border-radius: 16px;
  background: var(--wb-primary);
  color: #fff;
  font-family: inherit;
  box-shadow: 0 8px 20px rgba(79, 70, 229, 0.28);
  cursor: pointer;
}

.big b {
  font-size: 16.5px;
  font-weight: 650;
}

.big span {
  font-size: 12px;
  opacity: 0.9;
}

.big:active {
  transform: translateY(1px);
}
</style>
