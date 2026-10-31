<script setup lang="ts">
/** 首启欢迎层 —— 让用户自己决定从哪开始。
 *
 *  ★ 为什么不是「一上来就灌种子」：示例只是用来走一遍流程的，
 *    不是用户的词库。先问一句，比事后解释「这些词你不想要可以删」
 *    便宜得多，也不会把一堆半成品义项变成他的「已学内容」。
 *  ★ 为什么三条路都不跳页：首次打开还没有任何内容，
 *    多一次跳转就多一次「我是不是点错了」。三张卡原地解决。
 */
import { ref } from 'vue'
import { restoreBackup } from '../backup'
import { pickJsonFile } from '../fileio'
import { classifyImport, importBundle, unknownFormatText } from '../import'
import { importSampleSeed, skipSampleSeed } from '../seed'
import { toast } from '../toast'

const emit = defineEmits<{ (e: 'done'): void }>()
const logoUrl = new URL('../../public/icon-192.png', import.meta.url).href

const busy = ref<'' | 'sample' | 'import'>('')

async function useSample(): Promise<void> {
  if (busy.value) return
  busy.value = 'sample'
  try {
    await importSampleSeed()
    location.reload()
  } catch (e) {
    busy.value = ''
    toast(`示例词库载入失败：${(e as Error).message}`)
  }
}

async function importMine(): Promise<void> {
  if (busy.value) return
  busy.value = 'import'
  try {
    const picked = await pickJsonFile()
    if (!picked) {
      busy.value = ''
      return
    }
    const { kind, format } = classifyImport(picked.json)
    if (kind === 'bundle') {
      const rep = await importBundle(picked.json)
      toast(`已导入：词+${rep.wordsAdded} 义+${rep.sensesAdded} 句+${rep.sentencesAdded}`)
      location.reload()
      return
    }
    if (kind === 'backup') {
      const r = await restoreBackup(picked.json)
      toast(`恢复 ${r.words} 个词 / ${r.senses} 个意思 / ${r.sentences} 句`)
      location.reload()
      return
    }
    toast(
      kind === 'wordImport'
        ? '这是单个词的 JSON，请到那个词的意思页用「导入 JSON」贴进去'
        : unknownFormatText(format),
    )
    busy.value = ''
  } catch (e) {
    busy.value = ''
    toast((e as Error).message)
  }
}

function skip(): void {
  skipSampleSeed()
  emit('done')
}
</script>

<template>
  <div class="wl">
    <header class="hero">
      <img class="logo" :src="logoUrl" alt="" width="76" height="76" />
      <h1>极简单词</h1>
      <p class="tag">先选一个开始方式。之后随时能在「更多」里换。</p>
    </header>

    <main class="opts">
      <button
        type="button"
        class="opt primary"
        :disabled="!!busy"
        @click="useSample"
      >
        <span class="ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5z" />
            <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19" />
            <path d="M8.5 7.5h6" stroke-linecap="round" />
          </svg>
        </span>
        <span class="txt">
          <b>{{ busy === 'sample' ? '正在放进来…' : '用示例词开始' }}</b>
          <em>3 个词 · 7 个义项 · 14 句例句，先走一遍完整流程。</em>
          <small>之后可在「更多 → 示例词库」清掉没学过的。</small>
        </span>
        <span class="arrow" aria-hidden="true">›</span>
      </button>

      <button
        type="button"
        class="opt"
        :disabled="!!busy"
        @click="importMine"
      >
        <span class="ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 3v11" stroke-linecap="round" />
            <path d="m8 10 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke-linecap="round" />
          </svg>
        </span>
        <span class="txt">
          <b>{{ busy === 'import' ? '正在导入…' : '导入我的词库' }}</b>
          <em>已有的 JSON 内容包或备份，直接导进来。</em>
        </span>
        <span class="arrow" aria-hidden="true">›</span>
      </button>

      <button type="button" class="later" :disabled="!!busy" @click="skip">
        先空着，自己加词
      </button>
    </main>

    <footer class="foot">学习进度只存在这台手机上，换机前记得在「更多」里导出。</footer>
  </div>
</template>

<style scoped>
.wl {
  position: fixed;
  inset: 0;
  z-index: 600;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: calc(var(--wb-sb-h) + 28px) 20px calc(var(--wb-safe-bottom) + 24px);
  background:
    radial-gradient(120% 60% at 50% -10%, #eef2ff 0%, rgba(238, 242, 255, 0) 70%),
    var(--wb-bg);
}

.hero {
  text-align: center;
  padding: 8px 0 22px;
}

.logo {
  border-radius: 18px;
  box-shadow:
    0 2px 4px rgba(31, 35, 51, 0.06),
    0 14px 34px rgba(79, 70, 229, 0.16);
}

.hero h1 {
  margin: 14px 0 0;
  font-size: 24px;
  letter-spacing: 0.02em;
  color: var(--wb-ink);
}

.tag {
  margin: 8px auto 0;
  max-width: 17em;
  font-size: 13px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}

.opts {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.opt {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 16px 14px;
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  background: var(--wb-card);
  text-align: left;
  color: var(--wb-ink);
  box-shadow: 0 1px 2px rgba(31, 35, 51, 0.04);
}

.opt:disabled {
  opacity: 0.65;
}

.opt.primary {
  border-color: rgba(79, 70, 229, 0.35);
  background: linear-gradient(135deg, #f5f6ff 0%, #ffffff 60%);
  box-shadow:
    0 1px 2px rgba(31, 35, 51, 0.05),
    0 10px 26px rgba(79, 70, 229, 0.12);
}

.ico {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 13px;
  background: #eef1ff;
  color: var(--wb-primary);
}

.opt:not(.primary) .ico {
  background: var(--wb-bg);
  color: var(--wb-ink-2);
}

.ico svg {
  width: 24px;
  height: 24px;
}

.txt {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}

.txt b {
  font-size: 15px;
  font-weight: 650;
}

.txt em {
  font-style: normal;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--wb-ink-2);
}

.txt small {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--wb-ink-3);
}

.arrow {
  flex: 0 0 auto;
  font-size: 22px;
  color: var(--wb-ink-3);
}

.later {
  margin-top: 6px;
  align-self: center;
  border: 0;
  background: none;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--wb-ink-3);
  text-decoration: underline;
  text-decoration-color: var(--wb-line);
  text-underline-offset: 4px;
}

.later:disabled {
  opacity: 0.5;
}

.foot {
  margin-top: auto;
  padding-top: 28px;
  text-align: center;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}
</style>
