<script setup lang="ts">
/** 导入对比屏 —— 粘贴 JSON → 逐条决策 → 写库。
 *  每个冲突单独决策，没有「全部用导入的」：批量覆盖就是丢数据的开始。
 */
import { ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import {
  applyPlan,
  defaultDecisions,
  planImport,
  type Decisions,
  type ImportPlan,
} from '../importer'
import { toast } from '../toast'

const props = defineProps<{ open: boolean; word: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const text = ref('')
const plan = ref<ImportPlan | null>(null)
const d = ref<Decisions | null>(null)
const busy = ref(false)

watch(
  () => props.open,
  (v) => {
    if (!v) {
      text.value = ''
      plan.value = null
      d.value = null
    }
  },
)

async function preview(): Promise<void> {
  let json: unknown
  try {
    json = JSON.parse(text.value)
  } catch (e) {
    plan.value = null
    toast(`JSON 解析失败：${(e as Error).message}`)
    return
  }
  busy.value = true
  const p = await planImport(json)
  busy.value = false
  plan.value = p
  d.value = p.errors.length ? null : defaultDecisions(p)
}

/** 按用户勾选的决策真正写库。
 *  叫 apply，不叫 confirm —— 一个叫 confirm 的局部函数会把全局 confirm() 遮住，
 *  守卫（scripts/verify_docs.py：全站不许有原生 confirm/prompt）也就永远查不出
 *  真的漏网的那个。 */
async function apply(): Promise<void> {
  if (!plan.value || !d.value) return
  busy.value = true
  try {
    const msg = await applyPlan(plan.value, d.value)
    toast(msg)
    emit('done')
    emit('close')
  } catch (e) {
    toast(`导入失败：${(e as Error).message}`)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Sheet :open="open" :title="`导入 ${word}`" badge="逐条决策" @close="emit('close')">
    <p class="hint">
      粘内容包（word-bundle JSON），或 AI 按「复制给 AI」模板返回的 JSON。粘完点「看差异」，
      <b>不会</b>直接写库。
    </p>
    <van-field
      v-model="text"
      type="textarea"
      rows="7"
      autosize
      label=""
      placeholder='{ "word": "crime", "senses": [ … ] }'
    />

    <van-space class="row">
      <van-button size="small" type="primary" :disabled="!text.trim() || busy" @click="preview">
        看差异
      </van-button>
    </van-space>

    <template v-if="plan">
      <div v-if="plan.errors.length" class="bad">
        <b>这份导入没过校验，整份拒绝：</b>
        <div v-for="(e, i) in plan.errors" :key="i">· {{ e }}</div>
      </div>

      <template v-else>
        <p class="hint">
          AI 给的和你现有的不一致，<b>每个冲突单独选</b>。不提供「全部用导入的」——
          批量覆盖就是丢数据的开始。
        </p>

        <div v-for="p in plan.senses" :key="p.key" class="diff">
          <div class="dh">
            <b>{{ p.slot }}</b>
            <span class="wb-sp" />
            <van-tag plain round :type="p.kind === 'new' ? 'warning' : 'default'">
              {{
                p.kind === 'new'
                  ? '新增'
                  : `本地 ${p.localSentences.length} / 导入 ${p.incoming.sentences.length}`
              }}
            </van-tag>
          </div>

          <template v-if="p.kind === 'new'">
            <div class="side new">
              <b>{{ p.incoming.gloss }}</b>
              <div v-if="p.incoming.glossEn" class="en">{{ p.incoming.glossEn }}</div>
              <div class="meta">
                {{ p.incoming.sentences.length }} 句{{ p.incoming.pos ? ' · ' + p.incoming.pos : '' }}
              </div>
            </div>
            <div class="choices">
              <van-button
                size="small"
                :type="d!.adopt[p.key] ? 'primary' : 'default'"
                @click="d!.adopt[p.key] = true"
              >
                采纳
              </van-button>
              <van-button
                size="small"
                :type="d!.adopt[p.key] ? 'default' : 'warning'"
                @click="d!.adopt[p.key] = false"
              >
                丢弃
              </van-button>
            </div>
          </template>

          <template v-else>
            <div class="side loc">
              <span class="lb">本地</span>
              {{ p.local!.gloss }}
              <span v-if="p.newSentences.length" class="delta">+{{ p.newSentences.length }} 句新的</span>
              <span v-else class="delta none">句子没有新增</span>
            </div>
            <div class="side imp">
              <span class="lb">导入</span>
              {{ p.incoming.gloss }}
              <span v-if="p.glossConflict" class="delta warn">释义冲突</span>
              <span v-else class="delta none">释义一致</span>
            </div>

            <div class="choices">
              <van-button
                size="small"
                :type="d!.gloss[p.key] === 'keep' ? 'primary' : 'default'"
                @click="d!.gloss[p.key] = 'keep'"
              >
                保留本地释义
              </van-button>
              <van-button
                size="small"
                :type="d!.gloss[p.key] === 'take' ? 'primary' : 'default'"
                :disabled="!p.glossConflict"
                @click="d!.gloss[p.key] = 'take'"
              >
                用导入的
              </van-button>
            </div>

            <div class="choices">
              <van-button
                size="small"
                :type="d!.sentences[p.key] === 'append' ? 'primary' : 'default'"
                :disabled="!p.newSentences.length"
                @click="d!.sentences[p.key] = 'append'"
              >
                追加缺的 {{ p.newSentences.length }} 句
              </van-button>
              <van-button
                size="small"
                :type="d!.sentences[p.key] === 'keep' ? 'primary' : 'default'"
                @click="d!.sentences[p.key] = 'keep'"
              >
                只保留本地
              </van-button>
              <van-button
                size="small"
                :type="d!.sentences[p.key] === 'take' ? 'primary' : 'default'"
                @click="d!.sentences[p.key] = 'take'"
              >
                用导入的 {{ p.incoming.sentences.length }} 句
              </van-button>
            </div>
            <p v-if="p.localOnlySentences.length" class="warnline">
              本地有 {{ p.localOnlySentences.length }} 句导入没提：用「用导入的」会丢掉它们。
            </p>
          </template>
        </div>

        <div v-for="s in plan.localOnly" :key="`lo-${s.id}`" class="diff">
          <div class="dh">
            <b>{{ s.slot }}</b>
            <span class="wb-sp" />
            <van-tag plain round>本地有 · 导入没有</van-tag>
          </div>
          <div class="side loc"><span class="lb">保留</span>{{ s.gloss }}</div>
          <div class="choices">
            <van-button
              size="small"
              :type="d!.drop[`${s.word}#s${s.slot}`] ? 'default' : 'primary'"
              @click="d!.drop[`${s.word}#s${s.slot}`] = false"
            >
              保留
            </van-button>
            <van-button
              size="small"
              :type="d!.drop[`${s.word}#s${s.slot}`] ? 'danger' : 'default'"
              @click="d!.drop[`${s.word}#s${s.slot}`] = true"
            >
              删除（进回收站）
            </van-button>
          </div>
        </div>
      </template>
    </template>

    <template #footer>
      <van-button size="small" @click="emit('close')">取消</van-button>
      <van-button
        size="small"
        type="primary"
        :disabled="!plan || !!plan.errors.length || busy"
        @click="apply"
      >
        确认导入
      </van-button>
    </template>
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
  line-height: 1.65;
}

.row {
  margin: 10px 0 4px;
}

:deep(.van-field) {
  background: var(--wb-bg);
  border-radius: 10px;
  padding: 9px 11px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12.5px;
}

.bad {
  background: #fdeced;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--van-danger-color);
  margin-top: 12px;
  line-height: 1.7;
}

.diff {
  border-radius: 11px;
  background: var(--wb-card);
  margin-bottom: 10px;
  overflow: hidden;
}

.dh {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  background: var(--wb-bg);
  border-bottom: 1px solid var(--wb-line);
  font-size: 13.5px;
}

.side {
  padding: 10px 12px;
  font-size: 13px;
  position: relative;
}

.loc {
  border-bottom: 1px solid var(--wb-line);
}

.imp,
.new {
  background: #f2fbf6;
}

.new b {
  font-size: 14px;
}

.new .en {
  font-size: 12.5px;
  color: var(--wb-ink-2);
  margin-top: 4px;
}

.new .meta {
  font-size: 11.5px;
  color: var(--wb-ink-3);
  margin-top: 4px;
}

.lb {
  color: var(--wb-ink-3);
  font-size: 11px;
  font-weight: 600;
  margin-right: 6px;
}

.delta {
  float: right;
  font-size: 11.5px;
  color: var(--van-success-color);
}

.delta.warn {
  color: var(--van-warning-color);
}

.delta.none {
  color: var(--wb-ink-3);
}

.choices {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  padding: 9px 12px;
  border-top: 1px solid var(--wb-line);
}

.warnline {
  font-size: 12px;
  color: var(--van-danger-color);
  margin: 0;
  padding: 0 12px 10px;
}
</style>