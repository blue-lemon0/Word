<script setup lang="ts">
/** 应用外壳：顶部由各页面自己画，这里只管底部导航。
 *
 *  「首页 / 词库 / 训练 / 更多」是四个入口，**只有这四页有底栏**；
 *  单词页、意思页、错题板是从某处钻进去的二级页，底栏收起来。
 *  为什么收，见下面 showTabs 的注释。
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { incomingFile } from './bridge'
import { watchKeyboard } from './keyboard'
import { toastMsg } from './toast'

const route = useRoute()
const router = useRouter()

/** 从入口钻进去的二级页：单词页、意思页、错题板 */
function isSubPage(path: string): boolean {
  return (
    path.startsWith('/word/') || path.startsWith('/sense/') || path.startsWith('/board')
  )
}

watchKeyboard()

/* 滚动位置跨页记下来：从词库点进意思页再返回，列表不该弹回顶部 ——
   手机上返回后要重新翻刚才那一行，很烦。
   返回时 afterEach 也会触发（to = 上一页），所以恢复自然就对了。 */
const positions = new Map<string, number>()

router.afterEach((to, from) => {
  if (from?.fullPath) positions.set(from.fullPath, window.scrollY)
  const y = to.fullPath ? positions.get(to.fullPath) : 0
  requestAnimationFrame(() => window.scrollTo(0, y ?? 0))
})

/** 二级页归属的主 tab */
function activeTab(path: string): string {
  if (path.startsWith('/library') || path.startsWith('/word') || path.startsWith('/sense')) return 'library'
  if (path.startsWith('/train') || path.startsWith('/board')) return 'train'
  if (path.startsWith('/more')) return 'more'
  return 'home'
}

/**
 * 只有四个入口页有底栏；从入口钻进去的二级页一律收起来。
 *
 *  为什么不收是混乱的：底栏在手机上天生被读成「**和它同级**的四个地方」。
 *  二级页里也摆着它，就会同时产生两种错误预期 ——
 *   1. 「点一下当前高亮的那项，是回到上一层还是原地不动？」
 *   2. 「在二级页里点另一个 tab，是替换当前页还是压一层历史？」
 *  第 2 条尤其要命：从意思页点「词库」，路由变了、**历史又多了一格**，
 *  于是按返回键会退回意思页 —— 同一个页面来来回回，后退栈越来越长。
 *  这不是实现 bug，是底栏这个控件的语义和「详情页」天生冲突。
 *
 *  ★ 收回底栏必须同时收回**它占的那块留白**，否则内容会忽然多出一截空白。
 *    做法是改 `--wb-tabbar-h` 这一个变量（见 style.css 的 .no-tabs）：
 *    .wb-page 的 padding-bottom、首页的 min-height、toast 的落点
 *    全都是按这个变量算的，改一处就一起对。
 *
 *  flush:'sync' 是为了赶在渲染之前改掉 —— 晚一帧就是坑 42 说的那种跳变。
 */
const showTabs = computed(() => !isSubPage(route.path))
watch(
  () => route.path,
  () => {
    document.documentElement.classList.toggle('no-tabs', !showTabs.value)
  },
  { immediate: true, flush: 'sync' },
)

/**
 * 「从微信/QQ/文件管理器里点开一个 .json」—— 事件的接收方必须常驻。
 *
 *  之前这个监听器挂在「更多」页的 onMounted 上，于是：用户从微信里点开
 *  cards.json，此时应用停在首页 → 事件派发了但没人在听 →
 *  「点了那个文件，什么都没发生」，连日志都没有。
 *  接收方和处理方必须拆开：这里接住写进 bridge.incomingFile，
 *  顺便把用户带到「更多」页（那里才是处理方所在，且会弹确认）。
 */
onMounted(() => {
  window.addEventListener('wb:import-file', (e) => {
    const d = (e as CustomEvent<{ name: string; text: string }>).detail
    if (!d?.text) return
    incomingFile.value = { name: d.name, text: d.text }
    if (route.path !== '/more') void router.push('/more')
  })
})

const active = computed(() => activeTab(route.path))
</script>

<template>
  <RouterView v-slot="{ Component }">
    <component :is="Component" />
  </RouterView>

  <!-- ★ 不用 placeholder：它会往 body 里塞一个占位块，高度由 JS 算。
       一旦占位块高度与实际 tabbar 高度对不上（安全区在 WebView 里常常是 0），
       滚到底时就会出现整条 bar 跳一下 —— 原生底栏是不动的，宁可自己留白。
       留白由 .wb-page 的 padding-bottom 负责，见 style.css。

       ★ v-if 而非 v-show：v-show 留着元素、只改 display，
         切换那一帧页面底部会突然多/少一截空白（一次可见的跳变，坑 42）。
         v-if 是整块出现/消失，与原生「详情页没有底栏」的观感一致。 -->
  <van-tabbar v-if="showTabs" :model-value="active" route safe-area-inset-bottom class="fixed">
    <!-- 图标名必须是 Vant 内置图标表里真实存在的（vant/lib/index.css 的
         .van-icon-xxx），写错不报错、只是渲染成空白 —— tabbar 尤其容易踩，
         因为一个图标不显示时底栏看起来「就是少个图标」，很难联想到是名字错。 -->
    <van-tabbar-item name="home" icon="wap-home-o" to="/">首页</van-tabbar-item>
    <van-tabbar-item name="library" icon="apps-o" to="/library">词库</van-tabbar-item>
    <van-tabbar-item name="train" icon="aim" to="/train">训练</van-tabbar-item>
    <van-tabbar-item name="more" icon="ellipsis" to="/more">更多</van-tabbar-item>
  </van-tabbar>

  <!-- 状态栏实色带。
         Android 15+ 对 targetSdk≥35 强制 edge-to-edge，setStatusBarColor /
         navigationBarColor 已成空操作 —— 状态栏下方画什么它就透出什么。
         所以「不透明的状态栏」只能由页面自己画：一条固定在顶部、高度等于
         安全区的实色带。少了它，页面渐变/内容会从状态栏里透出来（露馅）。 -->
    <div class="sb" aria-hidden="true" />

    <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
</template>

<style scoped>
/* 固定死：原生底栏不随内容滚动，动一像素都算 bug。
   Vant 默认就是 fixed，这里显式写出来并干掉 transition，
   免得某些版本对 fixed 元素做 transform 过渡时跟手晃。 */
.fixed {
  position: fixed !important;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 100;
  transition: none !important;
}

/* 键盘弹出：底栏让位。
   留在原位的话它会压在键盘上面 —— 用户想点「词库」却点到键盘，
   于是表现为「按钮有时候点不动」，比没有底栏更糟。 */
.kb-open .fixed {
  transform: translateY(100%);
}

/* 底部弹层的键盘让位规则放在 style.css（全局）：
   弹层是 van-popup，teleport 到 body，拿不到本组件 scoped 的 data-v 属性，
   写在这里会编译成 `.kb-open[data-v-x] .van-popup[data-v-x]` 而永远匹配不上。 */

/* 状态栏实色带。Android 15+ 强制 edge-to-edge，setStatusBarColor 已是空操作，
   状态栏下方画什么它就透出什么，所以不透明的状态栏只能页面自己画。
   高度用 --wb-sb-h，全站顶部留白都按它算，改一处即可对齐。 */
.sb {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--wb-sb-h);
  background: var(--wb-bg);
  z-index: 999;
  pointer-events: none;
}

:deep(.van-tabbar) {
  border-top: 1px solid var(--wb-line);
}

:deep(.van-tabbar-item--active) {
  color: var(--wb-primary);
}

/* 轻提示。
 *
 *  z-index 必须**压过 Vant 的弹层**，而 Vant 的层号不是常量：
 *  `useGlobalZIndex` 从 2000 起、每挂一个弹层类组件就 ++（vant/lib/composables/
 *  use-global-z-index.js），于是 popup 是 2001、2002 …… 越用越大。
 *  这里原来写死 2000 —— 第一次开弹层就被压住，而且**不报错、不留痕**：
 *  用户点「复制到剪贴板」，toast 确实弹了，只是被弹层盖住看不见，
 *  表现成「复制好像没成功」（提示被挡住的那个现象）。取 9999 留足余量。
 *
 *  配色跟着设计 token 走。原来是 rgba(28,30,42,.92) 一块近黑，
 *  在暖白底 + 靛蓝主色的界面里像一块不属于这里的补丁；
 *  改成和 .wb-card 同源的「白底 + 细边 + 软阴影 + --wb-ink」，
 *  才像是这个 app 自己长出来的东西。 */
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(var(--wb-tabbar-h) + var(--wb-safe-bottom) + 20px);
  transform: translateX(-50%);
  background: var(--wb-card);
  color: var(--wb-ink);
  font-size: 13.5px;
  line-height: 1.45;
  padding: 10px 16px;
  border-radius: var(--wb-radius);
  box-shadow:
    0 1px 2px rgba(31, 35, 51, 0.06),
    0 8px 24px rgba(31, 35, 51, 0.12);
  border: 1px solid var(--wb-line);
  z-index: 9999;
  max-width: 82vw;
  text-align: center;
  pointer-events: none;
  animation: toast-in 0.18s ease;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translate(-50%, 8px);
  }
}
</style>