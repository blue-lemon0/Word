<script setup lang="ts">
/** 更多 —— 低频功能收在这里，不占 tab：统计、备份、快照、导入历史、回收站。
 *  分层原则在备份屏最明显：**导出 = 内容 + 进度**，「仅词库」= 只导内容；
 *  回滚只回内容，学习记录不动 —— 导入翻车不该把人背过的也退回去。
 */
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmSheet from '../components/ConfirmSheet.vue'
import InstallPrompt from '../components/InstallPrompt.vue'
import SwipePanels from '../components/SwipePanels.vue'
import AiSettings from '../components/AiSettings.vue'
import { incomingFile, nativeBridge } from '../bridge'
import { APP_NAME, APP_NAME_EN, APP_VERSION } from '../app-info'
import { downloadBackup, importLine, listSnapshots, restoreBackup, rollback } from '../backup'
import { classifyImport, importBundle, unknownFormatText } from '../import'
import { pickJsonFile } from '../fileio'
import { db, emptyTrash, restoreSense, trashedSenses } from '../db'
import { toast } from '../toast'
import type { ImportLog, Sense, Snapshot } from '../types'

const router = useRouter()
const logoUrl = new URL('../../public/icon-192.png', import.meta.url).href
const snaps = ref<Snapshot[]>([])
const imports = ref<ImportLog[]>([])
const trash = ref<Sense[]>([])

/** 确认弹层 —— 见 ConfirmSheet：原生 confirm() 在 WebView 里是系统对话框，
 *  顶着 "The page at ..." 一行、按钮写着 CANCEL / OK，和这个 app 毫无关系。
 *  这里四个危险/覆盖性操作共用一个弹层，谁点谁先填内容，确认时再执行。 */
const ask = ref<null | {
  title: string
  text: string
  okText: string
  danger?: boolean
  run: () => Promise<void>
}>(null)

function onAsk(): void {
  const a = ask.value
  if (!a) return
  ask.value = null
  void a.run()
}

async function load(): Promise<void> {
  snaps.value = await listSnapshots()
  imports.value = (await db.importLog.orderBy('ts').reverse().limit(10).toArray()).filter(
    (r) => r.id != null,
  ) as ImportLog[]
  trash.value = await trashedSenses()
}

function fmt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function onExport(withProgress: boolean): Promise<void> {
  const name = await downloadBackup(withProgress)
  // 装了 APK 会直接弹系统分享面板（微信/QQ/保存都在里面），
  // 说清「已经给你面板了」，不然用户会以为点了没反应。
  toast(nativeBridge ? `已生成 ${name}，选个地方存或发出去` : `已导出 ${name}`)
}

/**
 * 收到一个 JSON 文件（文件选择器选的，或从微信/QQ 直接点开的），按格式分派。
 *
 *  这是**一个**入口而不是三个：用户手上只有「一个 .json」，
 *  他不该需要先知道它是内容包还是备份 —— 文件里的 `format` 字段本来就说清了。
 *  分派规则见 `classifyImport`。
 *
 *  覆盖性操作（恢复备份）要先确认；只加不改的（内容包）直接做，因为
 *  导入前会自动快照、错了能回滚，多问一次反而是多余的阻力。
 */
async function applyIncoming(name: string, text: string): Promise<void> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    toast(`「${name}」不是合法 JSON：${(e as Error).message}`)
    return
  }
  const { kind, format } = classifyImport(json)

  if (kind === 'backup') {
    ask.value = {
      title: '恢复这份备份？',
      text: `收到「${name}」。\n\n恢复会覆盖现在的词库与进度（导入前会自动快照，可回滚）。`,
      okText: '恢复',
      danger: true,
      run: () => applyBackup(text),
    }
    return
  }

  if (kind === 'bundle') {
    const rep = await importBundle(json)
    if (rep.errors.length) toast(`导入完成，但有 ${rep.errors.length} 处跳过：${rep.errors[0]}`)
    else toast(`已导入：词+${rep.wordsAdded} 义+${rep.sensesAdded} 句+${rep.sentencesAdded}`)
    if (rep.conflicts.length) {
      // 只报不改（importBundle 的 A 方案），要说清「本地一个字都没动」
      toast(
        `另有 ${rep.conflicts.length} 处本地释义与内容包不同，已保留你写的：${rep.conflicts[0].word} 第${rep.conflicts[0].slot}个意思`,
      )
    }
    await load()
    return
  }

  if (kind === 'wordImport') {
    const w = (json as { word?: string }).word ?? '那个词'
    toast(`这是 AI 的单词增量「${w}」，要到那个词的意思页用「导入 JSON」贴进去、逐条确认`)
    return
  }

  toast(unknownFormatText(format))
}

/** 真去恢复（确认之后才走这里） */
async function applyBackup(text: string): Promise<void> {
  try {
    const r = await restoreBackup(JSON.parse(text))
    toast(
      r.skipped.length
        ? `恢复完成，${r.skipped.length} 处跳过：${r.skipped[0]}`
        : `恢复 ${r.words} 个词 / ${r.senses} 个意思 / ${r.sentences} 句`,
    )
  } catch (err) {
    toast((err as Error).message)
  }
  await load()
}

/** 文件选择器：选一个 JSON 就进来（两种格式都吃） */
async function onImport(): Promise<void> {
  let picked: { name: string; json: unknown } | null
  try {
    picked = await pickJsonFile()
  } catch (e) {
    toast((e as Error).message)
    return
  }
  if (!picked) return // 用户取消选择，不算错误
  await applyIncoming(picked.name, JSON.stringify(picked.json))
}

// 从微信/QQ/文件管理器里直接点开的文件由 App.vue 接住写进 bridge.incomingFile，
// 这里只管处理 —— 监听方必须常驻，否则事件在别的路由上派发就没人收（坑 49）
watch(incomingFile, async (f) => {
  if (!f) return
  incomingFile.value = null
  await applyIncoming(f.name, f.text)
})

/** 记录区（快照 / 导入历史 / 回收站）左右滑动切换 —— 三个平级，不需要同时看见。
 *  条数直接写在分段标题上：滑动容器里没有别的位置能说清「这边还剩多少」。 */
const panels = [
  { key: 'snap', label: '快照', count: snaps.value.length },
  { key: 'import', label: '导入历史', count: imports.value.length },
  { key: 'trash', label: '回收站', count: trash.value.length },
]
watch([snaps, imports, trash], () => {
  panels[0].count = snaps.value.length
  panels[1].count = imports.value.length
  panels[2].count = trash.value.length
})

onMounted(load)

function onRollback(id: number | undefined): void {
  if (id == null) return
  ask.value = {
    title: '回滚到这次快照？',
    text: '词库与例句回到那时的样子，学习进度保留。',
    okText: '回滚',
    danger: true,
    run: async () => {
      await rollback(id)
      toast('已回滚')
      await load()
    },
  }
}

async function onRestoreSense(id: string): Promise<void> {
  await restoreSense(id)
  toast('已还原')
  await load()
}

function onEmptyTrash(): void {
  const n = trash.value.length
  ask.value = {
    title: `彻底删掉 ${n} 个意思？`,
    text: '例句和熟练度一起没，不能还原。',
    okText: '彻底删除',
    danger: true,
    run: async () => {
      toast(`已清空 ${await emptyTrash()} 个意思`)
      await load()
    },
  }
}

/** 「已删 2 天」这种说法：30 天内可还原，所以要说清楚还剩几天 */
function ageOf(ts: number | null): string {
  if (!ts) return ''
  const days = Math.floor((Date.now() - ts) / 86400000)
  if (days <= 0) return '今天删的'
  return `已删 ${days} 天，还剩 ${Math.max(0, 30 - days)} 天`
}

/**
 * 一条导入记录压成一行。
 *
 *  实现与两种 summary 格式的识别在 `backup.ts` 的 importLine —— 放在那里是因为
 *  它是纯函数、有两种输入格式，很容易悄悄少说一句话（坑 47），
 *  该被 flow_smoke 那种测试直接盯住，而不是留在一个 .vue 里没人测。
 */
function oneLine(r: ImportLog): string {
  return `${fmt(r.ts)} · ${importLine(r)}`
}

onMounted(load)
</script>

<template>
  <div class="wb-page more-page">
    <header class="wb-topbar">
      <div class="in"><h1>更多</h1></div>
    </header>

    <!-- 应用信息固定在顶部，不参与滚动；下面的功能视图放进独立滚动区。 -->
    <section class="brand">
      <img class="logo" :src="logoUrl" alt="" width="52" height="52" />
      <div class="meta">
        <p class="nm">{{ APP_NAME }}</p>
        <p class="ver">v{{ APP_VERSION }} · {{ APP_NAME_EN }}</p>
        <p class="note">进度只在这台手机上，换机前记得导出。</p>
      </div>
    </section>

    <div class="more-scroll">
      <div class="wb-wrap">
        <InstallPrompt variant="full" />


      <!-- 备份区：导出两种 + 导入一个（导入会自动认出文件是哪一种，见 applyIncoming）
           原来这里是「导入备份」，而内容包另在词库页有个「导入内容包」——
           两个入口吃两种格式，用户得先知道自己拿到的是哪种文件。
           合成一个之后：文件里有 `format` 字段替用户回答这个问题。 -->
      <van-cell-group inset class="grp">
        <template #title><b>备份与导入</b></template>
        <div class="acts">
          <van-button size="small" type="primary" @click="onExport(true)">导出</van-button>
          <van-button size="small" @click="onExport(false)">仅词库</van-button>
          <van-button size="small" @click="onImport">导入</van-button>
        </div>
        <!-- 这段说明原本写的是「content-kit 的 cards.json / word-bundle v1」——
             那是**开发者之间**的话，出现在用户界面上只会让人一头雾水
             （「content-kit 是什么」「覆盖会先问是什么意思」）。
             现在只说「这是什么文件 + 进来会怎样」，具体格式归 CONTRACT.md。 -->
        <van-cell
          class="note"
          title="导入不用挑按钮，它自己认：词库内容包（只加不改已有的）、本应用导出的备份（会覆盖，先问你）、AI 按「复制给 AI」回来的单词（请到那个词的意思页粘贴）。从微信/QQ 里直接点开这个文件也可以。"
        />
      </van-cell-group>

      <!-- AI 助手（可选）：配置只存本机，不进备份。
           放在「备份与导入」下面、记录区上面 —— 它属于「设置这台设备怎么工作」，
           不属于「已经发生过的记录」。 -->
      <AiSettings />

      <!-- AI 体检：整库过一遍的入口。它是一次**维护动作**，
           所以是个二级页（从这儿进去、有返回、没有底栏），不在底栏里占一格。 -->
      <van-cell-group inset class="grp">
        <template #title>
          <b>AI 体检</b><span class="sub">逐个词过一遍，结果由你定</span>
        </template>
        <div class="acts">
          <van-button size="small" plain type="primary" @click="router.push('/audit')">
            打开体检
          </van-button>
        </div>
        <van-cell
          class="note"
          title="跑一个词、看一个词：AI 只提建议，点「应用」才改。跑过的词结果会缓存，内容没变再跑不花钱。"
        />
      </van-cell-group>

      <!-- 快照 / 导入历史 / 回收站：三个平级的列表，同一个盒子，左右滑动切换。
           它们本来就是一类东西 —— 都是「已经发生过的、会留痕的记录」，
           合成一栏之后页面少两块标题、列表框从 4 个变 1 个，
           而且三者的操作强度其实一样：回滚 / 看 / 还原，每一条都无害。
           唯一带破坏性的「清空回收站」本来就走确认弹层（见 ConfirmSheet），
           滑动阈值是三成屏宽，误触切屏和误触删除不会同时发生。

           三个面板**同时渲染**（不做懒加载）：坑 42 说过「第一帧渲染什么都是跳变」，
           空面板先出来再被填上，正是那种跳变。 -->
      <van-cell-group inset class="grp">
        <template #title>
          <b>记录与回收站</b><span class="sub">左右滑动切换；回收站 30 天自动清</span>
        </template>
        <SwipePanels :panels="panels">
          <template #snap>
            <div class="cap-list">
              <van-cell v-if="!snaps.length" title="还没有快照" label="第一次导入内容时会自动存一份" />
              <van-cell
                v-for="s in snaps"
                :key="s.id"
                :title="`${fmt(s.ts)} · ${s.label}`"
                is-link
                clickable
                @click="onRollback(s.id)"
              >
                <template #right-icon><span class="wb-dim">回滚</span></template>
              </van-cell>
            </div>
          </template>
          <template #import>
            <div class="cap-list">
              <van-cell v-if="!imports.length" title="还没有导入记录" />
              <van-cell v-for="r in imports" :key="r.id" :title="oneLine(r)" />
            </div>
          </template>
          <template #trash>
            <div class="cap-list">
              <van-cell
                v-if="!trash.length"
                title="空的"
                label="删除的意思会连熟练度一起进这里，可以还原"
              />
              <van-cell
                v-for="s in trash"
                :key="s.id"
                :title="`${s.word} · ${s.gloss}`"
                :label="ageOf(s.deletedAt)"
              >
                <template #right-icon>
                  <van-button size="mini" plain @click.stop="onRestoreSense(s.id)">还原</van-button>
                </template>
              </van-cell>
            </div>
            <van-cell v-if="trash.length" is-link clickable @click="onEmptyTrash">
              <template #title><span class="danger">清空回收站</span></template>
            </van-cell>
          </template>
        </SwipePanels>
      </van-cell-group>

      <!-- 原来这里写的是「内容真相源在 content-kit 的 TSV 里，这里是它的可编辑副本」。
           那是写给**开发者**看的：用户看到 content-kit / TSV 只会一脸茫然
           （这两个词不在这个 app 的任何一个界面里出现过）。
           改成用户语言：该做的还是那件事（改完导出备份），只是不再解释给谁看的。 -->
      <p class="foot wb-dim">
        在这里改过的内容只在这台设备上。记得定期「导出」存一份 ——
        换手机或者重装时，用那份文件就能恢复。
      </p>
      </div>
    </div>

    <ConfirmSheet
      :open="!!ask"
      :title="ask?.title ?? ''"
      :text="ask?.text"
      :ok-text="ask?.okText"
      :danger="ask?.danger"
      @close="ask = null"
      @confirm="onAsk()"
    />
  </div>
</template>

<style scoped>
/* Vant 把分组标题渲染成卡片外的兄弟节点；这里把它接回白色卡片顶部，
   让「标题 + 内容」看起来是同一个圆角功能区。 */
.more-page :deep(.van-cell-group__title--inset) {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 16px 0 0;
  padding: 12px 16px 0;
  background: var(--wb-card);
  border-radius: var(--wb-radius) var(--wb-radius) 0 0;
}

.grp {
  margin: 0 0 16px;
  border-radius: 0 0 var(--wb-radius) var(--wb-radius);
}

.more-page :deep(.van-cell-group__title--inset b) {
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-ink);
}

/* 标题后面的说明：并进标题而不是单独占一行。
   单独一行在这页要花 48~72px，而这一页的高度八成是被文字吃掉的。 */
.sub {
  flex: 1 1 auto;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--wb-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 滚动框外面的「一共几条」—— 被裁掉多少是看不见的（坑 46） */
.cnt {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--wb-ink-3);
}

/* 备份区的三个动作横排一行（照 prototype-v4）：原来三行各带 label，占 262px */
.acts {
  display: flex;
  gap: 8px;
  padding: 12px 16px 4px;
}

.acts :deep(.van-button) {
  flex: 1 1 0;
  min-width: 0;
}

/* 三行 label 说的是同一件事，压成一行小字 */
.note {
  padding-top: 2px;
  padding-bottom: 10px;
}

.note :deep(.van-cell__title) {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--wb-ink-3);
  line-height: 1.5;
}

/**
 * 有上限高度、自己会滚的清单框。
 *
 * 为什么要框：这三个清单的长度不由界面决定 —— 快照封顶 10 条，
 * 导入历史**只增不减**，回收站要等 30 天才清。平铺下去这一页会越来越长，
 * 而「更多」页是低频页：用户为了看第 8 条快照要滚过整页。
 *
 * 为什么高度按固定像素而不是 calc(...vh)：这个框在页面中间，
 * 按视口算会随状态栏、键盘、软键盘高度全变，页面长度就不可预期了。
 *
 * ★ overscroll-behavior-y 为什么是 auto 而不是 none：
 *   none 会把「滚动传递」一起禁掉，于是清单滑到头再拖，**页面也不动了** ——
 *   用户被卡在一个 236px 的小框里，一屏只能滚 50px 就撞墙。
 *   这里要 auto（允许传递到页面）；橡皮筋仍然不会来，因为**文档**那边是
 *   `none`（见 style.css 与 D34）—— 传递 ≠ 橡皮筋，两件事。
 *   Sheet.vue 的 `.sh-b` 则相反：弹层里的框下面隔着一层遮罩，
 *   传递过去会拖动背后的页面，所以那里必须 none。
 *   实测：清单从 0 滑到 52（它的全部余量）之后继续拖，页面接着滚。
 */
.cap-list {
  max-height: 236px;
  overflow-y: auto;
  overscroll-behavior-y: auto;
  -webkit-overflow-scrolling: touch;
  /* 底部一条淡影：还有内容被裁掉时，它暗示「下面还有」 */
  background:
    linear-gradient(var(--wb-card) 30%, rgba(255, 255, 255, 0)) top / 100% 18px no-repeat,
    linear-gradient(rgba(255, 255, 255, 0), var(--wb-card) 70%) bottom / 100% 18px no-repeat;
  background-attachment: local, local;
}

/* 这一页不滚动文档，只有下方功能视图滚动：
   应用信息固定在顶栏下面，避免 sticky 在 WebView 里反复重排产生抖动。 */
.more-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  padding-bottom: 0;
  overflow: hidden;
}

.more-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
  padding-bottom: calc(
    var(--wb-tabbar-h) + var(--wb-safe-bottom) + 16px + var(--kb, 0px)
  );
}

.brand {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex: 0 0 auto;
  width: 100%;
  margin: 0;
  padding: 10px max(26px, calc((100vw - 680px) / 2 + 26px));
  background: var(--wb-card);
  border: 0;
  border-bottom: 1px solid var(--wb-line);
  border-radius: 0 0 16px 16px;
  box-shadow: 0 8px 16px rgba(20, 24, 40, 0.06);
}

.brand .logo {
  margin-top: 2px;
  width: 52px;
  height: 52px;
  border-radius: 12px;
  flex: 0 0 auto;
}

.brand .nm {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--wb-ink);
}

.brand .ver {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--wb-ink-3);
  font-variant-numeric: tabular-nums;
}

.brand .note {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--wb-ink-3);
}

.stat {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin: 12px 0 0;
}

.stat > div {
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  padding: 12px 6px;
  text-align: center;
}

.stat b {
  display: block;
  font-size: 19px;
  line-height: 1.2;
}

.stat span {
  font-size: 11.5px;
  color: var(--wb-ink-2);
}

.danger {
  color: var(--van-danger-color);
}

.foot {
  margin: 20px 6px 8px;
  line-height: 1.7;
}
</style>