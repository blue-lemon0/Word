<script setup lang="ts">
/** 提示词管理 —— 不进包的改文案入口。
 *
 *  ★ 为什么需要这一页：提示词是所有 AI 动作里**唯一会随模型/口径变化**的东西。
 *    原来改一句话要改代码、跑构建、重新装机；现在改完点保存就生效。
 *
 *  ★ 为什么每块都写「用在哪」：改提示词的人面对的第一问题不是「怎么写」，
 *    而是「这是哪个按钮发的」。注册表里给每块配了 page → 按钮 的路径，
 *    这一行就是这一页的主索引。
 *
 *  ★ 为什么变量不能删：模板里 `{{context}}` 那一段是代码现算的词条内容。
 *    删掉它 AI 就看不到要审的东西。所以保存时按注册表校验：必需的不能少，
 *    不认识的名字也不许写（防手滑把 {{context}} 打成 {{cotext}} 后静默失效）。
 *
 *  ★ 手机输入的不便用剪贴板兜：可以整段复制出去在电脑上改完再粘回来。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import BackBtn from '../components/BackBtn.vue'
import ConfirmSheet from '../components/ConfirmSheet.vue'
import {
  groupedBlocks,
  isEdited,
  promptOverrides,
  promptText,
  resetAll,
  resetPrompt,
  setPrompt,
  validatePrompt,
} from '../ai/prompt-store'
import { copyText } from '../import'
import { goBack } from '../nav'
import { toast } from '../toast'

const router = useRouter()

const groups = groupedBlocks()
const editedCount = computed(() => Object.keys(promptOverrides.value).length)

const openId = ref('')
const draft = ref('')
const err = ref('')

const savedText = computed(() => (openId.value ? promptText(openId.value) : ''))
const dirty = computed(() => draft.value !== savedText.value)

const askResetAll = ref(false)

/** 模板里不能用 `{{ '{{x}}' }}` 直接写字面量：Vue 的插值分词按 `}}` 截断，
 *  字符串里的 `}}` 会让整页编译失败。所以花括号一律由脚本拼好再插。 */
const VAR_SAMPLE = '{{变量}}'

function braces(name: string): string {
  return `{{${name}}}`
}

function toggle(id: string): void {
  if (openId.value === id) {
    openId.value = ''
    return
  }
  openId.value = id
  draft.value = promptText(id)
  err.value = ''
}

function save(): void {
  const id = openId.value
  if (!id) return
  const bad = validatePrompt(id, draft.value)
  if (bad) {
    err.value = bad
    return
  }
  setPrompt(id, draft.value)
  draft.value = promptText(id)
  err.value = ''
  toast(isEdited(id) ? '已保存，下次调用就用新文本' : '与默认一致，已恢复默认')
}

function revert(): void {
  const id = openId.value
  if (!id) return
  resetPrompt(id)
  draft.value = promptText(id)
  err.value = ''
  toast('已恢复默认')
}

async function copyDraft(): Promise<void> {
  if (await copyText(draft.value)) toast('已复制')
  else toast('复制失败，请手动选中复制')
}

/** 读剪贴板在 WebView 里不总是许可；失败时给出可执行的替代（长按粘贴） */
async function pasteDraft(): Promise<void> {
  try {
    const t = await navigator.clipboard.readText()
    if (!t) {
      toast('剪贴板是空的')
      return
    }
    draft.value = t
    err.value = ''
  } catch {
    toast('读不到剪贴板，请长按输入框粘贴')
  }
}

function doResetAll(): void {
  askResetAll.value = false
  resetAll()
  if (openId.value) draft.value = promptText(openId.value)
  err.value = ''
  toast('全部恢复默认')
}
</script>

<template>
  <div class="wb-page">
    <header class="wb-topbar">
      <div class="in">
        <BackBtn @click="goBack(router, '/more')" />
        <h1>提示词管理</h1>
        <span class="wb-sp" />
        <van-tag v-if="editedCount" type="warning" round>{{ editedCount }} 处已改</van-tag>
      </div>
    </header>

    <div class="wb-wrap">
      <section class="wb-card intro">
        <p class="lead">
          这里改的是问 AI 的<b>原话</b>。保存后<b>立即生效</b>，不用重新打包/装机；
          改过的块旧缓存自动作废，下一次调用就是新文本。
        </p>
        <p class="dim">
          文本里的 <code>{{ VAR_SAMPLE }}</code> 是程序填进去的内容（词条、例句、编号），
          不要删掉必需项，否则 AI 会看不到它要处理的东西。想大改可以在电脑上改好再粘回来。
        </p>
      </section>

      <section v-for="g in groups" :key="g.title" class="grp">
        <h3 class="hd">{{ g.title }}</h3>

        <div v-for="b in g.items" :key="b.id" class="wb-card blk" :class="{ open: openId === b.id }">
          <button class="row" type="button" @click="toggle(b.id)">
            <div class="ttl">
              <b>{{ b.title }}</b>
              <van-tag v-if="isEdited(b.id)" type="warning" round>已改</van-tag>
            </div>
            <p class="where">{{ b.where }}</p>
          </button>

          <div v-if="openId === b.id" class="edit">
            <div v-if="b.vars.length" class="vars">
              <span class="vh">能用的变量：</span>
              <span v-for="v in b.vars" :key="v.name" class="vchip">
                <code>{{ braces(v.name) }}</code>
                <em>{{ v.desc }}</em>
              </span>
            </div>

            <p v-if="b.risk" class="risk">{{ b.risk }}</p>

            <van-field v-model="draft" type="textarea" rows="10" autosize label="" />

            <div class="btns">
              <van-button size="small" @click="pasteDraft">粘贴</van-button>
              <van-button size="small" @click="copyDraft">复制</van-button>
              <van-button size="small" plain @click="revert">恢复默认</van-button>
              <van-button size="small" type="primary" :disabled="!dirty" @click="save">
                保存
              </van-button>
            </div>
            <p v-if="err" class="err">{{ err }}</p>
          </div>
        </div>
      </section>

      <section class="wb-card">
        <h3 class="hd">全部恢复默认</h3>
        <p class="dim">
          清掉本机所有改动，回到代码里的默认文案。这一页的设置只存在这台手机上，
          不进备份、也不影响别的设备。
        </p>
        <van-button
          size="small"
          plain
          type="danger"
          :disabled="!editedCount"
          @click="askResetAll = true"
        >
          全部恢复默认
        </van-button>
      </section>
    </div>

    <ConfirmSheet
      :open="askResetAll"
      title="全部恢复默认？"
      text="本机改过的提示词会全部清掉，回到代码里的默认文案。"
      ok-text="恢复"
      danger
      @close="askResetAll = false"
      @confirm="doResetAll"
    />
  </div>
</template>

<style scoped>
.intro .lead {
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--wb-ink-2);
}

.intro .dim {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-ink-3);
}

code {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
  background: var(--wb-bg);
  border-radius: 4px;
  padding: 0 3px;
}

.grp {
  margin-top: 14px;
}

.hd {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-ink-3);
  margin: 0 4px 8px;
}

.blk {
  padding: 0;
  margin-bottom: 8px;
  overflow: hidden;
}

.blk.open {
  border: 1px solid var(--primary);
}

.row {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 12px 14px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.ttl {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ttl b {
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-ink);
}

.where {
  margin: 5px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}

.edit {
  padding: 0 14px 14px;
}

.vars {
  background: var(--wb-bg);
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 10px;
}

.vh {
  display: block;
  font-size: 11.5px;
  color: var(--wb-ink-3);
  margin-bottom: 6px;
}

.vchip {
  display: block;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--wb-ink-2);
  margin-bottom: 4px;
}

.vchip em {
  font-style: normal;
  color: var(--wb-ink-3);
  margin-left: 4px;
}

.risk {
  font-size: 12px;
  line-height: 1.7;
  color: #9a6400;
  background: #fff6e6;
  border-radius: 10px;
  padding: 8px 10px;
  margin: 0 0 10px;
}

:deep(.van-field) {
  background: var(--wb-bg);
  border-radius: 10px;
  padding: 10px 11px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.6;
}

.btns {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.btns :deep(.van-button) {
  flex: 1 1 0;
  min-width: 64px;
}

.err {
  margin-top: 8px;
  font-size: 12.5px;
  color: #c0392b;
}

.dim {
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-ink-3);
  margin: 0 0 10px;
}
</style>
