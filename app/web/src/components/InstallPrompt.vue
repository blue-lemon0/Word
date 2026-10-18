<script setup lang="ts">
/** 安装到手机 —— 「加到主屏幕之后就是个 app」。
 *
 *  两条路径，不能只做一条：
 *   · Android / 桌面 Chrome：浏览器给 beforeinstallprompt，我们直接弹原生安装框
 *   · iOS Safari：浏览器**不给**这个事件，只能教用户点「分享 → 添加到主屏幕」
 *
 *  已经装成 app（standalone）就不再提示 —— 已经装过的人天天看它最烦。
 */
import { computed, onMounted, ref } from 'vue'
import { isIos, isStandalone, isWebView, onInstallable, promptInstall } from '../pwa'
import { toast } from '../toast'

const props = withDefaults(defineProps<{ variant?: 'bar' | 'full' }>(), { variant: 'bar' })

const installable = ref(false)
const dismissed = ref(localStorage.getItem('wb-install-dismissed') === '1')
/** APK 里不提示安装：WebView 的 display-mode 不是 standalone，
 *  只看它会在已经装成 app 的用户眼前弹「装到手机上」。 */
const standalone = isStandalone() || isWebView()
const ios = isIos()

onMounted(() => onInstallable(() => (installable.value = true)))

/** 能不能显示提示：没装 + 浏览器说能装 或 是 iOS + 没被用户关掉 */
const visible = computed(() => !standalone && !dismissed.value && (installable.value || ios))

const hint = computed(() => {
  if (installable.value) return '装到主屏幕：打开快、断网能背、没有地址栏'
  return 'iPhone 上要用 Safari 打开，点底部「分享」→「添加到主屏幕」'
})

async function onInstall(): Promise<void> {
  const ok = await promptInstall()
  if (ok) toast('装好了 —— 从主屏幕图标进来')
}

function onDismiss(): void {
  dismissed.value = true
  localStorage.setItem('wb-install-dismissed', '1')
}
</script>

<template>
  <div v-if="visible" class="inst" :class="props.variant">
    <div class="txt">
      <b>装到手机上</b>
      <span>{{ hint }}</span>
    </div>
    <button v-if="installable" class="btn primary sm" @click="onInstall">安装</button>
    <button class="btn sm ghost" title="不再提示" @click="onDismiss">✕</button>
  </div>
</template>

<style scoped>
.inst {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 13px;
  border-radius: var(--radius);
  background: linear-gradient(135deg, #eef1ff, #f3e8ff);
  border: 1px solid #dcd9fb;
  margin-bottom: 12px;
}

.inst.full {
  flex-direction: column;
  align-items: flex-start;
  gap: 11px;
  padding: 16px;
}

.txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.txt b {
  font-size: 14px;
  color: #3730a3;
}

.txt span {
  font-size: 12.5px;
  color: #4c4a8a;
  line-height: 1.5;
}

.ghost {
  border-color: transparent;
  background: none;
  color: var(--ink-3);
  padding: 4px 7px;
}
</style>