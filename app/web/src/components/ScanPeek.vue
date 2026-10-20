<script setup lang="ts">
/** 扫读里点一行 —— 先给你「这句话什么意思」，再问你要不要练。
 *
 *  ★ 为什么不再直接跳进答题：扫读的动机是**看懂这一句**。
 *    原来点一行 = 立刻进单题（选项、判对错、SRS 全走一遍），
 *    想「只看一眼翻译」的人被迫先做一道题。现在先摊开：
 *    英文 + 中文 + 这句里那个词的意思，然后才是「练这一句」。
 *
 *  ★ 为什么用浮层而不是页面：它是一个「看一眼」，看完就回列表继续扫；
 *    跳页会把扫读的节奏打断（而且每跳一次，路由栈就多一格）。
 */
import { computed } from 'vue'
import MarkedText from './MarkedText.vue'
import type { ScanItem } from '../quiz'

const props = defineProps<{
  item: ScanItem | null
  /** 这个义项一共几条例句 —— 让人知道「练这一句」之后还有没有别的 */
  total: number
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'drill', item: ScanItem): void
  (e: 'word', w: string): void
}>()

const sense = computed(() => props.item?.sense)
const sentence = computed(() => props.item?.sentence)
</script>

<template>
  <van-popup
    :show="!!item"
    position="bottom"
    round
    close-on-popstate
    :style="{ maxHeight: '76vh' }"
    @close="emit('close')"
  >
    <div v-if="item && sense && sentence" class="sk">
      <header class="hd">
        <b>{{ sense.word }}</b>
        <span v-if="sense.pos" class="pos">{{ sense.pos }}</span>
        <span class="wb-sp" />
        <span class="n">{{ total }} 句</span>
      </header>

      <!-- 这句：英文高亮目标词 + 中文翻译 -->
      <div class="s-en">
        <MarkedText
          :text="sentence.en"
          :marks="sentence.marks"
          :form="sentence.form"
          :span-start="sentence.spanStart"
          :span-len="sentence.spanLen"
          pickable
          @pick="emit('word', $event)"
        />
      </div>
      <p v-if="sentence.zh" class="s-zh">{{ sentence.zh }}</p>

      <!-- 这句里它的意思：直接给答案 —— 这里是「查」，不是「考」 -->
      <div class="gloss">
        <span class="g-pos">{{ sense.pos || '—' }}</span>
        <span class="g-t">{{ sense.gloss || '（还没有释义）' }}</span>
      </div>
      <p v-if="sense.note" class="note">{{ sense.note }}</p>

      <!-- ★ 这里原来有「练这一句」：既然答案就摆在上面，再让人去猜一遍是多余的。
           想练就回首页点「复习 / 学习」，那里才是一轮。 -->
      <div class="acts">
        <van-button block round @click="emit('close')">知道了</van-button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.sk {
  padding: 16px 16px calc(14px + env(safe-area-inset-bottom, 0px));
  overflow: auto;
  max-height: calc(76vh - 8px);
}

.hd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}

.hd b {
  font-size: 21px;
  font-weight: 650;
}

.hd .pos {
  font-size: 12px;
  color: var(--wb-ink-3);
}

.hd .n {
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.s-en {
  font-size: 16.5px;
  line-height: 1.65;
  color: var(--wb-ink);
}

.s-zh {
  margin-top: 6px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--wb-ink-2);
}

.gloss {
  margin-top: 14px;
  background: var(--wb-bg);
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.g-pos {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.g-t {
  font-size: 15px;
  line-height: 1.55;
  color: var(--wb-ink);
}

.note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-ink-3);
}

.acts {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

.hint {
  margin-top: 10px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}
</style>
