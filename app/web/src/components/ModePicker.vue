<script setup lang="ts">
/**
 * 练法选择 —— 进训练页的第一屏，回答「今天怎么练」。
 *
 *  为什么单独抽出来：这三项不是「一个按钮的三个文案」，而是三种不同的
 *  排期口径（按到期 / 全库随机 / 不出题只浏览），用户要靠下面那行说明
 *  才判断得出选哪个。原先把它们塞在训练页模板里，和答题界面挤在一起，
 *  1113 行的文件里这一段既难找、又是最近才加的。
 *
 *  纯展示：**所有动作都由父组件决定**（choose 抛出一个 key）。
 *  这里不放任何逻辑，也不改任何状态 —— 这样它可以被单独读、单独改，
 *  改动不会碰到训练页里最贵的那些逻辑（回看 / 跳题 / 连对 / 快照）。
 */
export interface Mode {
  key: string
  label: string
  hint: string
  primary?: boolean
  /** 没有得练时置灰，并把原因写在 hint 里 ——
   *  比「点进去才发现是空的、再弹一句看不清的提示」好得多。 */
  disabled?: boolean
}

defineProps<{ modes: Mode[]; soloTitle?: string; sub?: string }>()
const emit = defineEmits<{ (e: 'choose', key: string): void }>()
</script>

<template>
  <section class="wb-card center">
    <h2>{{ soloTitle ?? '怎么练' }}</h2>
    <p v-if="sub" class="sub">{{ sub }}</p>
    <div class="mlist">
      <button
        v-for="m in modes"
        :key="m.key"
        class="mitem"
        :class="{ pri: m.primary, off: m.disabled }"
        type="button"
        :disabled="m.disabled"
        @click="emit('choose', m.key)"
      >
        <b>{{ m.label }}</b><span>{{ m.hint }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.center {
  text-align: center;
  padding: 30px 16px;
  margin-top: 24px;
}

.center h2 {
  margin: 6px 0;
  font-size: 17px;
}

.sub {
  color: var(--wb-ink-3);
  font-size: 13px;
  margin: 4px 0 16px;
}

/* 三种练法：竖排整宽的行，每行 = 一个标题 + 一句「它到底怎么练」。
   不做成三张小卡并排 —— 手机上并排每张只有 100px 宽，那行说明必须缩成两行，
   而「按计划 / 随便 / 扫读」这三个词本身不足以让人判断选哪个。 */
.mlist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}

.mitem {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  border: 1px solid var(--wb-line);
  background: var(--wb-bg);
  border-radius: var(--wb-radius);
  padding: 12px 14px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.mitem b {
  font-size: 15px;
  color: var(--wb-ink);
}

.mitem span {
  font-size: 12px;
  color: var(--wb-ink-2);
}

.mitem.pri {
  border-color: var(--wb-primary);
  background: rgba(79, 70, 229, 0.06);
}

.mitem:active {
  background: var(--wb-line);
}

/* 没有得练：置灰、点不动，原因就写在 hint 里。
   这比「点进去 → 组出空队列 → 跳去另一种练法 → 弹一句看不懂的提示」
   好在**代价前置**：用户不点就不会被丢到别处。 */
.mitem.off {
  opacity: 0.5;
  cursor: default;
}

.mitem.off:active {
  background: var(--wb-bg);
}
</style>