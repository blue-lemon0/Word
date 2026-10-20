<script setup lang="ts">
/**
 * 错题板 —— **只是一份清单**。
 *
 * ★ 原来这里挂着「单挑这个意思」：可现在列表上明写着词和释义，等于先给答案再让猜，
 *   和句子浮层里那句「练这一句」是同一个毛病。练错题就去首页「复习」，
 *   那里抽到哪个意思是未知的，才有意义。
 *  理由：错题板上你不知道会抽到哪个意思，练它才有意义；
 *  在意思页点「练这个意思」是送分（那句提示在意思页也写着）。
 *
 *  第三个 tab 是「有问题句」：那是内容侧的下一步工作清单，所以要能整份导出。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { dueText, repsText } from '../composables'
import { allProgress, allSentences, liveSenses } from '../db'
import BackBtn from '../components/BackBtn.vue'
import { goBack } from '../nav'
import { speakEn, speechOn, ttsWaiting } from '../speech'
import { clearFlags, downloadFlags, listFlags, type FlagRow } from '../flags'
import { toast } from '../toast'
import type { Progress, Sense, Sentence } from '../types'
import { masteryOf } from '../types'

const router = useRouter()

interface Row {
  sense: Sense
  prog: Progress | undefined
  sentences: number
  sample: string
}

const rows = ref<Row[]>([])
const flags = ref<FlagRow[]>([])
const tab = ref<'wrong' | 'pending' | 'flagged'>('wrong')

const MASTERY_TEXT = { mastered: '已掌握', learning: '学习中', new: '未学' } as const
const MASTERY_TYPE = { mastered: 'success', learning: 'warning', new: 'default' } as const

async function load(): Promise<void> {
  const [senses, sents, progs] = await Promise.all([
    liveSenses(),
    allSentences(),
    allProgress(),
  ])
  const pmap = new Map(progs.map((p) => [p.senseId, p]))
  const bySense = new Map<string, Sentence[]>()
  for (const s of sents) {
    const arr = bySense.get(s.senseId)
    if (arr) arr.push(s)
    else bySense.set(s.senseId, [s])
  }
  const list: Row[] = []
  for (const s of senses) {
    const p = pmap.get(s.id)
    const mine = bySense.get(s.id) ?? []
    const wrong = (p?.wrongN ?? 0) > 0
    const pending = (p?.pendingN ?? 0) > 0
    if (!wrong && !pending && !mine.some((x) => x.flagged)) continue
    list.push({
      sense: s,
      prog: p,
      sentences: mine.length,
      sample: mine[0]?.en ?? '',
    })
  }
  list.sort((a, b) => (b.prog?.wrongN ?? 0) - (a.prog?.wrongN ?? 0))
  rows.value = list
  flags.value = await listFlags()
}

const counts = computed(() => ({
  wrong: rows.value.filter((r) => (r.prog?.wrongN ?? 0) > 0).length,
  pending: rows.value.filter((r) => (r.prog?.pendingN ?? 0) > 0).length,
  flagged: flags.value.length,
}))

const shown = computed(() =>
  rows.value.filter((r) => {
    if (tab.value === 'wrong') return (r.prog?.wrongN ?? 0) > 0
    if (tab.value === 'pending') return (r.prog?.pendingN ?? 0) > 0
    return true
  }),
)

function mastery(p: Progress | undefined): keyof typeof MASTERY_TEXT {
  return masteryOf(p)
}

/** 导出问题句清单，交人工或 AI 修。 */
async function onExportFlags(): Promise<void> {
  if (!flags.value.length) {
    toast('没有标记过任何句子')
    return
  }
  toast(`已导出 ${await downloadFlags()}，交人工或 AI 修`)
}

/** 关单：内容侧确认修好后清标记。标记长在句子行上，所以只清标记不动例句。 */
async function onResolve(f: FlagRow): Promise<void> {
  await clearFlags([f.sentenceId])
  toast('已关单，这句回到出题池')
  await load()
}

onMounted(load)
</script>

<template>
  <div class="wb-page">
    <header class="wb-topbar">
      <div class="in">
        <BackBtn @click="goBack(router, '/library')" />
        <h1>错题板</h1>
      </div>
    </header>

    <div class="wb-wrap">
      <van-notice-bar
        left-icon="info-o"
        color="#4f46e5"
        background="#eef2ff"
        wrapable
        :scrollable="false"
      >
        这里是<b>清单</b>：哪几个意思老错、哪几句有问题。练它们去首页「复习」，别在这儿再猜一遍。
      </van-notice-bar>

      <van-tabs
        v-model:active="tab"
        sticky
        color="#4f46e5"
        title-active-color="#4f46e5"
        title-inactive-color="#969baa"
        line-width="16"
        class="tabs"
      >
        <van-tab name="wrong" :title="`答错 ${counts.wrong}`" />
        <van-tab name="pending" :title="`说不会 ${counts.pending}`" />
        <van-tab name="flagged" :title="`有问题句 ${counts.flagged}`" />
      </van-tabs>

      <!-- 有问题句：整份导出待修清单 -->
      <template v-if="tab === 'flagged' && flags.length">
        <div class="exp-row">
          <van-button size="small" plain type="primary" @click="onExportFlags">导出清单</van-button>
          <span class="wb-dim">交人工或 AI 修</span>
        </div>
        <div v-for="f in flags" :key="f.sentenceId" class="wb-card flag">
          <div class="fh">
            <b>{{ f.word }}</b><span class="g">{{ f.gloss }}</span>
          </div>
          <div class="en">{{ f.sentence }}</div>
          <div v-if="f.note" class="note">备注：{{ f.note }}</div>
          <van-space class="acts" wrap>
            <van-button size="mini" plain :to="`/sense/${f.senseId}`">去编辑</van-button>
            <van-button size="mini" type="primary" @click="onResolve(f)">已修好</van-button>
          </van-space>
        </div>
      </template>

      <van-empty
        v-else-if="!shown.length"
        description="这里空着 —— 没有答错、没有说不会、也没有被标记的句子"
      />

      <div v-for="r in shown" v-else :key="r.sense.id" class="wb-card item" @click="router.push(`/sense/${r.sense.id}`)">
        <div class="fh">
          <b class="w">{{ r.sense.word }}</b>
          <button
            v-if="speechOn"
            class="wb-say"
            :class="{ waiting: ttsWaiting }"
            type="button"
            aria-label="朗读单词"
            @click.stop="speakEn(r.sense.word)"
          >
            <van-icon name="volume-o" />
          </button>

          <van-tag v-if="r.sense.pos" plain round>{{ r.sense.pos }}</van-tag>
          <span class="wb-sp" />
          <van-tag plain round :type="MASTERY_TYPE[mastery(r.prog)]">
            {{ repsText(r.prog) }} · {{ dueText(r.prog) }}
          </van-tag>
        </div>
        <div class="g">{{ r.sense.gloss }}</div>
        <div class="m">
          <span v-if="r.prog?.wrongN">错 {{ r.prog.wrongN }} 次</span>
          <span v-if="r.prog?.pendingN">不会 {{ r.prog.pendingN }} 次</span>
          <span>{{ r.sentences }} 句</span>
          <span v-if="!r.sample" class="warn">没有可用例句</span>
        </div>
        <van-space class="acts" wrap>
          <van-button size="mini" plain @click.stop="router.push(`/sense/${r.sense.id}`)">去编辑</van-button>
        </van-space>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  margin: 0 -12px 4px;
  --van-tabs-line-height: 42px;
  --van-tabs-nav-background: var(--wb-bg);
}

.exp-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 10px 4px 12px;
}

.item,
.flag {
  cursor: pointer;
}

.fh {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.fh .w,
.fh b {
  font-size: 16px;
  font-weight: 700;
}

.fh .g {
  font-size: 12.5px;
  color: var(--wb-ink-2);
  min-width: 0;
}

.item .g {
  font-size: 15px;
  margin-top: 6px;
}

.item .m {
  font-size: 11.5px;
  color: var(--wb-ink-2);
  margin-top: 5px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.item .m .warn {
  color: var(--van-danger-color);
}

.flag .en {
  font-size: 14.5px;
  margin: 8px 0 4px;
  line-height: 1.6;
}

.flag .note {
  font-size: 12.5px;
  color: var(--van-warning-color);
}

.acts {
  margin-top: 11px;
}
</style>