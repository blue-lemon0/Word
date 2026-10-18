<script setup lang="ts">
/** 首页 —— 只做三件事：搜索、随机词 + 它的一句例句、跳去训练。
 *  不放进度条、不放统计、不放「缺例句的词」：那些是词表和看板的事。
 *  尤其**不显示中文释义** —— 首页是「打开就想学」，不是查阅工具。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import InstallPrompt from '../components/InstallPrompt.vue'
import MarkedText from '../components/MarkedText.vue'
import {
  loadStats,
  loadStatsNow,
  randomCardNow,
  randomCardWithSentence,
  useSearch,
  type Card,
  type Stats,
} from '../composables'
import { db } from '../db'
import { toast } from '../toast'

const router = useRouter()
const { q, hits, open, close } = useSearch()

/**
 * 首帧**同步**取，内存里没有才是 undefined。
 *
 * ★ `undefined` 和 `null` 是两件事，模板必须分开渲染：
 *   undefined = 还在读库（表没热），null = 读完了，确实没有。
 *   之前只有 `null`，于是第一帧无条件落进「词库还是空的」——
 *   真机 screencast 抓到过那一帧：一个有 2998 词的用户，开 app 看到的是
 *   「词库还是空的 / 先去词库导入一份词库」，6ms 后才长出卡片。
 *   数据没到就说「没有」等于闪一下假话（坑 32），而且是最坏的一种：
 *   它把「加载中」说成了「你的数据没了」，会让人真去导入一遍。
 */
const card = ref<Card | null | undefined>(randomCardNow())
const stats = ref<Stats | undefined>(loadStatsNow())

async function roll(): Promise<void> {
  card.value = await randomCardWithSentence()
  stats.value = await loadStats()
  refreshHint()
}

/** 「去训练」按钮上的副标题：告诉用户点了会发生什么，
 *  而不是干巴巴一个「去训练」—— 让人愿意点的是「今天有多少要复习」。 */
const trainHint = ref('')

function goWord(word: string): void {
  close()
  q.value = ''
  router.push(`/word/${encodeURIComponent(word)}`)
}

function onEnter(): void {
  const s = q.value.trim().toLowerCase()
  if (s) goWord(hits.value[0]?.word ?? s)
}

/** 顺藤摸瓜：例句里的任意词 → 它的单词页。词库里没有就直说，不假装。 */
async function pick(word: string): Promise<void> {
  if (card.value && word === card.value.word.toLowerCase()) return
  if (await db.words.get(word)) goWord(word)
  else toast(`词库里还没有 "${word}"`)
}

function refreshHint(): void {
  const s = stats.value
  if (!s) return // 还没热就不写 —— 「去训练」配一句空的副标题，跳一下
  if (s.senses === 0) {
    trainHint.value = '先去词库导入'
    return
  }
  if (s.due > 0) trainHint.value = `${s.due} 题到期`
  else trainHint.value = '今天没有到期的'
}

// 首帧就有统计时，副标题也首帧就有（别让按钮上方晚一拍）
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

      <van-search
        v-model="q"
        placeholder="搜索单词"
        shape="round"
        class="sbox"
        @search="onEnter"
        @clear="close()"
      >
        <template #action>
          <div class="act" @click="onEnter">搜索</div>
        </template>
      </van-search>

      <!-- 候选词：搜索框下拉。放在搜索框外面，不用它的 dropdown 插槽，
           因为要整块可点、还要显示命中数量 -->
      <div v-if="open" class="sug">
        <div v-for="h in hits" :key="h.word" class="i" @click="goWord(h.word)">
          <b>{{ h.word }}</b>
          <span class="ipa">{{ h.ipa }}</span>
        </div>
      </div>

      <!-- 可点范围只给单词本身。
           之前 @click 挂在整个 .stage 上 —— 词 + 音标 + 例句 + 提示那一大块
           （真机上约 280px 高）全都能触发跳转。结果是想点搜索框、想点句子里的
           某个词顺藤摸瓜，都可能一碰就跳进详情页，非常容易误触。
           现在：.stage 不再可点，只有单词这个元素本身能点，
           另外右上角给一个小箭头作为明确的入口提示。 -->
      <div v-if="card" class="stage">
        <div class="wbox">
          <button class="w" @click="goWord(card.word)">{{ card.word }}</button>
          <button
            class="open"
            :aria-label="`打开 ${card.word} 的单词页`"
            @click="goWord(card.word)"
          >
            <van-icon name="arrow" size="13" />
          </button>
        </div>
        <div v-if="card.ipa" class="ipa">/{{ card.ipa }}/</div>
        <div class="sn">
          <MarkedText
            :text="card.sentence.en"
            :form="card.sentence.form"
            :span-start="card.sentence.spanStart"
            :span-len="card.sentence.spanLen"
            pickable
            @pick="pick"
          />
        </div>
        <div class="tap">{{ card.nSenses }} 个意思</div>
      </div>
      <div v-else-if="card === undefined" class="stage skel">
        <!-- 还在读库：给骨架，不给结论。
             「词库还是空的」是一句关于用户数据的话，不能在还不知道的时候说 -->
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

      <!-- 原来这块空白是靠 .stage{flex:1} 把一个词居中撑出来的。
           没有背景图撑着，它就是「打开 app 但什么都没发生」的第一印象。
           换成今天的实际状态：打开就能知道要练多少、练得怎么样，
           顺便给一个进训练的入口 —— 空白换成了有用的信息。 -->
      <section v-if="stats && stats.senses > 0" class="today" @click="router.push('/train')">
        <div class="trow">
          <div class="cell">
            <b>{{ stats.due }}</b>
            <span>今天到期</span>
          </div>
          <div class="cell">
            <b>{{ stats.mastered }}</b>
            <span>已掌握</span>
          </div>
          <div class="cell">
            <b>{{ stats.words }}</b>
            <span>总词数</span>
          </div>
        </div>
        <div class="go">
          {{ stats.due > 0 ? '开始今天的复习' : '没有到期的，去练新卡' }}
          <van-icon name="arrow" size="14" />
        </div>
      </section>

      <!-- 主行动独占一整行大按钮。之前三个 size="small" 按钮挤在一行，
           视觉权重完全相等 —— 用户不知道该点哪个，于是随手点「换一个」，
           「去训练」这个真正想做的事反而被当成第三选项。
           主/次分开之后，拇指区第一眼看到的就是它。 -->
      <div class="acts">
        <button class="big" @click="router.push('/train')">
          <b>去训练</b>
          <span>{{ trainHint }}</span>
        </button>
        <div class="minor">
          <button class="mbtn" @click="roll">
            <van-icon name="replay" size="17" />
            换一个
          </button>
          <button class="mbtn" @click="router.push('/library')">
            <van-icon name="apps-o" size="17" />
            词库
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 首页背景：原本是一块纯色 + 大片留白。
   留白不是设计，是「没有内容可填」的副作用 —— 在手机上占了整屏，
   看起来像没加载出来。
   这里用纯 CSS 画一个渐变 + 两团柔光，不需要图片资源：
   APK 离线可用，塞一张 jpg 只会让安装包变大还得处理解码。 */
.home {
  min-height: calc(100dvh - var(--wb-tabbar-h));
  display: flex;
  flex-direction: column;
  position: relative;
  /* 首页没有 topbar，顶部让位由页面自己出。
     （其他页面的让位在 .wb-topbar 里算 —— 两边都算就会叠加成两倍，
       标题被推到很下面。） */
  padding-top: var(--wb-sb-h);
  /* ★ 横向溢出在这里夹。
     下面两团装饰光斑故意出血到屏幕外（right:-80px / left:-90px），
     配合 blur 才有弥散感 —— 但元素一超出视口，页面就真的比屏幕宽、
     还能横向拖（真机实测 scrollWidth 440 vs innerWidth 360，
     横向溢出正好 80px，就是那个 -80px），表现为「背景比屏幕宽」。

     为什么非得用 clip 而不是 hidden：
     hidden 会把另一轴的 visible 强制变成 auto，于是 .home 自己
     变成滚动容器 —— 页面高度超过视口时会变成「在 .home 内部滚」，
     底部 tabbar 和安全区的计算全乱。
     clip 只夹横向、不建立滚动容器，竖向照常由文档流滚。

     （在 html/body 上写 overflow-x 试过了，都不生效：
      根元素的 overflow 会传播给视口而自身计算值恒为 visible，
      这个 WebView 里视口也不采用 body 的 overflow。
      实测 scrollX 仍能滚到 80。） */
  overflow-x: clip;
  background:
    radial-gradient(120% 60% at 50% 0%, #eef1ff 0%, rgba(238, 241, 255, 0) 62%),
    linear-gradient(180deg, #fbfbfe 0%, var(--wb-bg) 46%);
}

/* 柔光圆点：纯装饰，压在内容下面。
   z-index:0 + 内容 z-index:1 是必须的 —— 不然这个伪元素会盖住
   下面所有可点区域（它没有 pointer-events:none 的话连字都点不动）。 */
.home::before,
.home::after {
  content: '';
  position: absolute;
  border-radius: 50%;
  filter: blur(46px);
  pointer-events: none;
  z-index: 0;
}

.home::before {
  width: 250px;
  height: 250px;
  top: -70px;
  right: -80px;
  background: rgba(99, 102, 241, 0.16);
}

.home::after {
  width: 210px;
  height: 210px;
  bottom: 12%;
  left: -90px;
  background: rgba(14, 165, 233, 0.11);
}

.home :deep(.wb-wrap) {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  flex: 1;
}

/* 首页的搜索框：home 背景是渐变浅色，Vant 默认的浅灰输入框叠在上面
   就是「灰底灰字」，几乎看不清。这里给白底 + 边框 + 深色占位符。
   顶部再留 6px：搜索框不要顶着状态栏，与其他页面的标题之间留点呼吸。 */
.sbox {
  margin: 6px 0 0;
  padding: 0;
  background: transparent;
  --van-search-background: transparent;
  --van-search-content-background: #fff;
  --van-search-content-height: 42px;
  --van-field-input-text-color: var(--wb-ink);
  --van-field-placeholder-text-color: #6f7688;
  --van-search-content-border-radius: 21px;
}

.sbox :deep(.van-field__control) {
  color: var(--wb-ink);
  font-size: 16px;
}

.sbox :deep(.van-field__control::placeholder) {
  color: #6f7688;
  -webkit-text-fill-color: #6f7688;
}

.act {
  color: var(--wb-primary);
  font-size: 14px;
  padding: 0 4px;
}

.sug {
  background: var(--wb-card);
  border-radius: 12px;
  box-shadow: 0 6px 24px rgba(31, 35, 51, 0.12);
  overflow: hidden;
  margin-top: 6px;
}

.sug .i {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 11px 14px;
}

.sug .i + .i {
  border-top: 1px solid var(--wb-line);
}

.sug .i:active {
  background: var(--van-background);
}

.sug .i b {
  font-size: 15px;
  font-weight: 600;
}

.sug .i .ipa {
  color: var(--wb-ink-3);
  font-size: 12px;
}

/* 词卡：占满剩余高度并居中。
   之前改成 flex:0 以为「不再撑满」就是省空间，结果多出来的空间全部
   堆到了最底下 —— 截图里「词库」按钮下面空出一大块，看起来像没加载完。
   真正的问题是**空白被堆在一处**，而不是空白本身。
   flex:1 让词卡吃掉剩余高度，空白就均匀分到词卡上下，像一张居中的大卡片。 */
.stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 10px 0 14px;
  text-align: center;
}

/* 单词 + 右上角入口箭头。只有这一小块可点。 */
.wbox {
  position: relative;
  display: inline-block;
  align-self: center;
}

.w {
  /* 用 button 而不是 div：要的是「只有这行字可点」的语义与焦点可达性。
     透明背景去掉原生按钮皮，字号字重与原来的 .w 保持一致。 */
  display: block;
  border: 0;
  background: none;
  padding: 4px 10px;
  border-radius: 10px;
  color: var(--wb-ink);
  font-family: inherit;
  font-size: clamp(34px, 11vw, 50px);
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1.15;
  cursor: pointer;
}

.w:active {
  background: rgba(99, 102, 241, 0.08);
}

/* 右上角小箭头：给一个明确的「这里能进详情」提示。
   单独做一个 28px 的小按钮 —— 够点（低于 44px 手指会点偏），
   但绝不会跟搜索框抢点击。 */
.open {
  position: absolute;
  top: -6px;
  right: -22px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--wb-line);
  border-radius: 50%;
  background: #fff;
  color: var(--wb-ink-3);
  cursor: pointer;
}

.open:active {
  background: var(--van-background);
}

.stage .empty {
  font-size: 17px;
  color: var(--wb-ink-2);
  margin-bottom: 6px;
}

.stage .w {
  font-size: clamp(34px, 11vw, 50px);
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1.15;
}

.stage .ipa {
  color: var(--wb-ink-3);
  font-size: 14px;
  margin-top: 4px;
}

.stage .sn {
  font-size: clamp(16px, 4.4vw, 20px);
  line-height: 1.8;
  margin-top: 24px;
  max-width: 560px;
  margin-left: auto;
  margin-right: auto;
}

.stage .tap {
  font-size: 12.5px;
  color: var(--wb-ink-3);
  margin-top: 18px;
}

/* ── 今日状态：把首页那块空白换成有用的信息 ── */
.today {
  background: var(--wb-card);
  border-radius: 14px;
  padding: 14px 14px 11px;
  margin-bottom: 12px;
  cursor: pointer;
  border: 1px solid var(--wb-line);
}

.today:active {
  background: #f5f6fb;
}

.trow {
  display: flex;
}

.today .cell {
  flex: 1;
  text-align: center;
}

.today .cell b {
  display: block;
  font-size: 22px;
  font-weight: 700;
  color: var(--wb-primary);
  line-height: 1.2;
}

.today .cell span {
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.today .go {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px solid var(--wb-line);
  font-size: 13px;
  color: var(--wb-ink-2);
  font-weight: 600;
}

/* ── 主/次操作 ──
   手机上拇指够得到的只有屏幕下半部分，所以主按钮放在最下面一整行，
   高度 56px —— 低于这个数在手机上就容易点偏。 */
.acts {
  padding-bottom: 14px;
}

.big {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 100%;
  min-height: 56px;
  padding: 8px 16px;
  border: 0;
  border-radius: 14px;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: #fff;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(79, 70, 229, 0.28);
}

.big b {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.big span {
  font-size: 12.5px;
  opacity: 0.88;
}

.big:active {
  transform: translateY(1px);
}

.minor {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.mbtn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 46px;
  border: 1px solid var(--wb-line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.9);
  color: var(--wb-ink-2);
  font-family: inherit;
  font-size: 14.5px;
  cursor: pointer;
}

.mbtn:active {
  background: var(--van-background);
}
</style>