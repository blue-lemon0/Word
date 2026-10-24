<script setup lang="ts">
/** 训练页 —— 薄壳：顶栏 + TrainSession 本体。
 *
 *  本体在 components/TrainSession.vue，首页的「复习 / 学习」tab 嵌的也是它。
 *  这一页只剩两个职责：
 *    · 从 ?scope= 读出练哪一组（词库页「练这组」的入口），喂给本体；
 *    · 给一个明确的退出路径（顶栏返回箭头）。
 *
 *  ★ 训练中途跳去词条/义项核验时，route.query 会被清空（组件被 keep-alive
 *    停用），回来时才恢复原值 —— 那不是「换了一组」，不能因此重开一轮。
 *    fromDetail 闩住的就是这一次 query 抖动（旧版坑 58 的同款，见 git 历史）。 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BackBtn from '../components/BackBtn.vue'
import TrainSession from '../components/TrainSession.vue'
import { goBack as goBackNav } from '../nav'

/** 名字要显式声明：App.vue 只 keep-alive 这一页（`include` 靠的就是名字）。
 *  不声明的话 keep-alive 静默不生效 —— 跳去核验再回来，
 *  这一轮做了一半的题全没了，而界面上没有任何提示说它丢了。 */
defineOptions({ name: 'TrainPage' })

const route = useRoute()
const router = useRouter()

/** 从词库的分组点进来时带的 scope（due / new / learning）——
 *  词库页那几个「练这组」按钮走的就是它。 */
const scopeQuery = computed<'due' | 'new' | 'learning' | null>(() => {
  const s = route.query.scope
  return s === 'due' || s === 'new' || s === 'learning' ? s : null
})

/** 顶栏标题：练的是哪一组，一眼看得出来 */
const headerTitle = computed(() => {
  switch (scopeProp.value) {
    case 'due':
      return '复习到期'
    case 'new':
      return '学新词'
    case 'learning':
      return '在学的'
    default:
      return '练习'
  }
})

/** 喂给本体的 scope —— 详情页往返期间保持原值（见文件头） */
const scopeProp = ref(scopeQuery.value)
let fromDetail = false
watch(
  () => [route.path, scopeQuery.value] as const,
  ([path]) => {
    if (path.startsWith('/word/') || path.startsWith('/sense/')) {
      fromDetail = true
      return
    }
    if (fromDetail) {
      fromDetail = false
      return
    }
    scopeProp.value = scopeQuery.value
  },
)

/** 裸 /train（不带 scope）：本体已搬进首页 tab，这里不再提供混合队列入口 */
watch(
  scopeQuery,
  (s) => {
    if (!s && route.path === '/train' && !fromDetail) void router.replace('/')
  },
  { immediate: true },
)

const goBack = (): void => goBackNav(router, '/')
</script>

<template>
  <div class="wb-page tpage">
    <header class="wb-topbar">
      <div class="in">
        <BackBtn @click="goBack" />
        <h1>{{ headerTitle }}</h1>
      </div>
    </header>
    <TrainSession :scope="scopeProp" />
  </div>
</template>

<style scoped>
/* 顶栏之外的全部高度交给会话本体 —— 它是自己的滚动容器（.tsess），
   键盘与固定操作条的让位也都在它内部算，这一页不再垫 padding-bottom。 */
.tpage {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  padding-bottom: 0;
  overflow: hidden;
}
</style>
