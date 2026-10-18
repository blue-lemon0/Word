<script setup lang="ts">
/**
 * 当场改内容 —— 例句或某个意思的释义不对时，在**背单词的那一屏**里改掉。
 *
 * ★ 为什么一定要在这里，而不是把人送去「词库 → 意思」页：
 *   发现内容有问题的那一瞬间，正是你**手里有这个具体句子/选项**的那一瞬间。
 *   送到另一个页面去改，等于让人自己重新把这个句子找回来 —— 找不回来，
 *   于是就只写一句「有问题」然后继续背，坏内容就一直坏下去。
 *   「能当场改」和「能记录问题」差的就是这一段路。
 *
 * 它只做两件事：改文本、保存后写库。不做别的（不删、不排序、不跳页）。
 * 改完立刻回到原来那道题 —— 改动的效果要马上看得见，
 * 否则用户会怀疑「到底存没存上」。
 */
import { computed, ref, watch } from 'vue'
import { toast } from '../toast'
import { updateSentence, updateSense } from '../edit'
import type { Sentence, Sense } from '../types'

const props = defineProps<{
  /** 例句模式：改这一句 */
  sentence?: Sentence | null
  /** 释义模式：改这个意思 */
  sense?: Sense | null
}>()

const emit = defineEmits<{ (e: 'saved'): void }>()

const en = ref('')
const zh = ref('')
const gloss = ref('')

const isSentence = computed(() => !!props.sentence)

/** 改过的字段才写库：没动过的字段留着原值，
 *  免得「只改中文」却把英文清空 —— 那是最容易犯也最亏的错。 */
watch(
  () => [props.sentence?.id, props.sense?.id],
  () => {
    en.value = props.sentence?.en ?? ''
    zh.value = props.sentence?.zh ?? ''
    gloss.value = props.sense?.gloss ?? ''
  },
  { immediate: true },
)

async function save(): Promise<void> {
  if (props.sentence) {
    const patch: Partial<Sentence> = {}
    if (en.value.trim() !== props.sentence.en) patch.en = en.value.trim()
    if (zh.value.trim() !== props.sentence.zh) patch.zh = zh.value.trim()
    if (Object.keys(patch).length) await updateSentence(props.sentence.id!, patch)
  }
  if (props.sense) {
    const g = gloss.value.trim()
    if (g && g !== props.sense.gloss) await updateSense(props.sense.id, { gloss: g })
  }
  toast('改好了，这一题已经用上新内容')
  emit('saved')
}
</script>

<template>
  <van-popup
    :show="!!sentence || !!sense"
    position="bottom"
    round
    :style="{ maxHeight: '86vh' }"
    @close="$emit('saved')"
  >
    <div class="ed">
      <h3>{{ isSentence ? '改掉这句' : '改掉这个意思' }}</h3>

      <template v-if="isSentence">
        <label class="f">
          <span>英文</span>
          <textarea v-model="en" rows="3" autocapitalize="off" autocorrect="off" />
        </label>
        <label class="f">
          <span>中文</span>
          <textarea v-model="zh" rows="2" />
        </label>
      </template>

      <label v-else class="f">
        <span>释义</span>
        <textarea v-model="gloss" rows="2" />
      </label>

      <div class="acts">
        <van-button block @click="$emit('saved')">取消</van-button>
        <van-button block type="primary" @click="save">保存</van-button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.ed {
  padding: 18px 16px calc(14px + env(safe-area-inset-bottom, 0px));
}

h3 {
  font-size: 16.5px;
  font-weight: 600;
  margin-bottom: 14px;
}

.f {
  display: block;
  margin-bottom: 12px;
}

.f span {
  display: block;
  font-size: 12.5px;
  color: var(--wb-ink-3);
  margin-bottom: 6px;
}

.f textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--wb-line);
  border-radius: 10px;
  padding: 10px;
  font: inherit;
  font-size: 15px;
  line-height: 1.55;
  resize: none;
  background: var(--wb-bg);
  color: var(--wb-ink);
}

.acts {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}
</style>