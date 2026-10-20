<script setup lang="ts">
/** 新增一个词 —— 从「填一个单词等你自己写释义」改成「一句话给你一张能背的卡」。
 *
 *  ★ 旧流程的问题：输入词 → 建空壳 → 跳去编辑页等你自己写释义和例句。
 *    可「加一个词」的动机通常是**刚遇到它、想马上能背它**；把人丢到一张
 *    空表单前面，等于把内容生产的工作转交给了用户。
 *
 *  ★ 新流程三条路，按「能不能立刻用」排序：
 *    1. 配了 AI：点一下「AI 生成义项和例句」→ 提议浮层里逐条看 → 应用 → 入词条页；
 *    2. 没配 AI：照旧建词条 + 占位义项（标「需精修」），跳编辑页自己写；
 *    3. 已经在库里：不再重复建，直接给一个「去这个词」的入口。
 *
 *  ★ 仍然守 D38 的规矩：AI 只出提议，**应用要人点**。这里的按钮只是
 *    「让 AI 先生成」的同意，不是「替我决定内容」的同意。
 */
import { computed, ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import AiSheet from './AiSheet.vue'
import { db } from '../db'
import { addWord } from '../edit'
import { fillWord } from '../ai/actions'
import { aiReady } from '../ai/config'
import { describeAiError, type AiResult } from '../ai/types'
import { toast } from '../toast'

const props = defineProps<{ open: boolean; initial?: string }>()
const emit = defineEmits<{
  (e: 'close'): void
  /** 手动加：给义项 id，父组件跳编辑页 */
  (e: 'added', senseId: string): void
  /** AI 补齐：给词，父组件跳词条页 */
  (e: 'filled', word: string): void
}>()

const word = ref('')
const ipa = ref('')
const aiOn = aiReady

/** 输入后查一下库里有没有 —— 给「已经在库里」一个明确回应 */
const exists = ref(false)

async function recheck(): Promise<void> {
  const w = word.value.trim().toLowerCase()
  if (!w) {
    exists.value = false
    return
  }
  exists.value = (await db.words.get(w)) != null
}

/* 搜索没搜到直接来加词（initial 带着搜索词）：打开时就填好、查好，
   别让人把刚敲过的词再敲一遍。 */
watch(
  () => props.open,
  (v) => {
    if (v && props.initial) {
      word.value = props.initial
      void recheck()
    }
  },
)

function reset(): void {
  word.value = ''
  ipa.value = ''
  exists.value = false
}

async function submit(): Promise<void> {
  try {
    const r = await addWord(word.value, ipa.value)
    toast(`已加「${r.word}」，去填第一个意思`)
    emit('added', r.senseId)
    emit('close')
    reset()
  } catch (e) {
    toast((e as Error).message)
  }
}

function goExisting(): void {
  const w = word.value.trim().toLowerCase()
  if (!w) return
  emit('filled', w)
  emit('close')
  reset()
}

/* ── AI 生成 ── */
const aiOpen = ref(false)
const aiBusy = ref(false)
const aiResult = ref<AiResult | null>(null)
const aiError = ref('')
const aiWord = ref('')

async function aiGenerate(): Promise<void> {
  const w = word.value.trim().toLowerCase()
  if (!w) {
    toast('先输入一个单词')
    return
  }
  aiWord.value = w
  aiError.value = ''
  aiResult.value = null
  aiOpen.value = true
  aiBusy.value = true
  try {
    aiResult.value = await fillWord(w, 3)
  } catch (e) {
    aiError.value = describeAiError(e)
  } finally {
    aiBusy.value = false
  }
}

/** 应用完：收起两层，去词条页看结果（那里能继续改） */
function onAiApplied(): void {
  aiOpen.value = false
  const w = aiWord.value
  emit('filled', w)
  emit('close')
  reset()
}

const canSubmit = computed(() => !!word.value.trim())
</script>

<template>
  <Sheet :open="props.open" title="加一个词" @close="emit('close')">
    <p class="hint">
      <template v-if="aiOn">
        输入英文，点「AI 生成义项和例句」——它会给出建议，你逐条确认后才入库。
      </template>
      <template v-else>
        填英文单词就行，音标可以先空着。保存后进编辑页补释义 —— 没有释义的意思在练习里等于不存在。
      </template>
    </p>

    <van-field
      v-model="word"
      placeholder="例如 nuance"
      label=""
      autocapitalize="off"
      @blur="recheck"
      @update:model-value="recheck"
      @keyup.enter="aiOn ? aiGenerate() : submit()"
    />
    <van-field v-model="ipa" placeholder="音标可留空：/ˈnuːɑːns/" label="" class="ipa" />

    <!-- 已经在库里：不要重复建，给个明确的下一步 -->
    <p v-if="exists" class="exists">
      「{{ word.trim().toLowerCase() }}」已经在你的词库里了。
      <button type="button" class="lnk" @click="goExisting">去看看 →</button>
    </p>

    <!-- 两个行动竖着排：它们都是「主要决定」，挤在一行里字会折成三行 -->
    <template #footer>
      <div class="fcol">
        <template v-if="exists">
          <van-button type="primary" block round @click="goExisting">去这个词</van-button>
        </template>
        <template v-else>
          <van-button
            v-if="aiOn"
            type="primary"
            block
            round
            :disabled="!canSubmit"
            :loading="aiBusy"
            @click="aiGenerate"
          >
            AI 生成义项和例句
          </van-button>
          <van-button block round :disabled="!canSubmit" @click="submit">
            {{ aiOn ? '只建词条，自己写' : '加进词库' }}
          </van-button>
        </template>
      </div>
    </template>

    <!-- AI 提议：和其它地方同一张浮层 -->
    <AiSheet
      :show="aiOpen"
      :result="aiResult"
      :busy="aiBusy"
      :error="aiError"
      :label="aiWord"
      @close="aiOpen = false"
      @applied="onAiApplied"
    />
  </Sheet>
</template>

<style scoped>
.hint {
  background: #eef2ff;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: #3730a3;
  margin: 0 0 12px;
  line-height: 1.6;
}

.ipa {
  margin-top: 8px;
}

.exists {
  margin-top: 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--wb-ink-2);
  background: var(--wb-bg);
  border-radius: 10px;
  padding: 9px 11px;
}

.lnk {
  border: 0;
  background: transparent;
  color: var(--primary);
  font-family: inherit;
  font-size: 12.5px;
  padding: 0;
  cursor: pointer;
}

.fcol {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

:deep(.van-cell) {
  background: var(--wb-bg);
  border-radius: 10px;
  padding: 10px 11px;
  font-size: 15px;
}
</style>
