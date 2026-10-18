/** 引入 Vant 与它的样式。
 *
 *  引入方式：**按需手动注册**，不用 unplugin-vue-components 之类的自动扫描。
 *  理由是这个应用的组件集是固定的十几个，手写 import 一眼看得见用了什么，
 *  也不会因为某次构建环境差异导致自动注册悄悄漏掉组件（漏一个就是页面白屏）。
 *
 *  样式同样按需：`vant/lib/index.css` 是全量的（216 KB），这里只引用到的
 *  十几个组件的样式（gzip 后 57 KB → 约 12 KB）。多引的样式在手机上
 *  是白下载 + 解析时间，值不上。
 *
 *  主题走 Vant 的 CSS 变量（`--van-*`），不是覆盖它的类名：Vant 4 把设计 token
 *  全部暴露成变量，改颜色/圆角只动 style.css 顶部那一段。
 */
import {
  Button,
  Cell,
  CellGroup,
  Checkbox,
  CheckboxGroup,
  DropdownItem,
  DropdownMenu,
  Empty,
  Field,
  Icon,
  Loading,
  NoticeBar,
  Popup,
  Progress,
  Search,
  Space,
  Tab,
  Tabbar,
  TabbarItem,
  Tag,
  Tabs,
} from 'vant'

import 'vant/es/button/style'
import 'vant/es/cell/style'
import 'vant/es/cell-group/style'
import 'vant/es/checkbox/style'
import 'vant/es/checkbox-group/style'
import 'vant/es/dropdown-menu/style'
import 'vant/es/dropdown-item/style'
import 'vant/es/empty/style'
import 'vant/es/field/style'
import 'vant/es/icon/style'
import 'vant/es/loading/style'
import 'vant/es/notice-bar/style'
import 'vant/es/popup/style'
import 'vant/es/progress/style'
import 'vant/es/search/style'
import 'vant/es/space/style'
import 'vant/es/tab/style'
import 'vant/es/tabbar/style'
import 'vant/es/tabbar-item/style'
import 'vant/es/tag/style'
import 'vant/es/tabs/style'

import './style.css'

/** 全部注册一遍。页面里直接用 <van-button>，不逐页 import。 */
export const VANT_COMPONENTS = [
  Button,
  Cell,
  CellGroup,
  Checkbox,
  CheckboxGroup,
  DropdownItem,
  DropdownMenu,
  Empty,
  Field,
  Icon,
  Loading,
  NoticeBar,
  Popup,
  Progress,
  Search,
  Space,
  Tab,
  Tabbar,
  TabbarItem,
  Tag,
  Tabs,
]