/** 提示词注册表 —— 能改的那几块文本，以及每块「用在哪」。
 *
 *  ★ 为什么要有 where：提示词管理最难的不是编辑，是**认得出这是哪个按钮发的**。
 *    「SYSTEM」「SHAPE」这种名字对写代码的人有意义，对改文案的人等于没说。
 *    所以每一块都写清「哪个页面 → 哪个按钮/弹窗」，这一行是给界面看的索引。
 *
 *  ★ 为什么文本里用 `{{变量}}` 而不是直接拼字符串：文本要能被**存下来改**，
 *    而上下文（词条、义项、例句）是代码现算的。变量是那些「不能改」的部分，
 *    写死在模板里不行、留给用户填也不行。保存时校验变量名，漏了就存不进去。
 *
 *  ★ 这里的 text 是**默认值**，不是唯一副本。用户改过的版本在 prompt-store 里，
 *    恢复默认 = 删掉覆盖层，所以默认值永远是最新的（改代码就生效）。
 */
import { MIN_SENTENCES_PER_SENSE } from '../sentence-health'

export interface PromptVar {
  name: string
  desc: string
}

export interface PromptBlock {
  id: string
  title: string
  /** 用在哪：页面 → 按钮/弹窗。管理页直接展示这一行。 */
  where: string
  /** 模板里能写的 {{变量}}；不在这里的名字保存时会报错（防手滑打错） */
  vars: PromptVar[]
  /** 必需变量：删掉它这条提示词就废了 */
  required: string[]
  /** 高危提醒：改坏了不会报错，只会让 AI 给出坏内容 */
  risk?: string
  text: string
}

const SHAPE = `输出 JSON：
{"note":"整体判断一句话；全部没问题就写 ok","proposals":[
 {"kind":"sense.update","slot":1,"gloss":"……","pos":"v.","note":"……","glossEn":"……","trap":0,"why":"为什么要改"},
 {"kind":"word.update","ipa":"ˈaːmi","why":"为什么要补/改音标"},
 {"kind":"sentence.replace","sentenceId":12,"en":"新英文（含目标词或屈折形式）","zh":"中文","highlights":["went"],"why":"为什么要换"},
  {"kind":"sentence.add","slot":2,"en":"……","zh":"……","highlights":["goes","went"],"why":"为什么要补"},
  {"kind":"sense.add","gloss":"……","pos":"n.","why":"为什么要加这个义项","sentences":[{"en":"……","zh":"……","highlights":["……"]}]}
]}
字段都可以省略（只写你要改的那个）；slot / sentenceId 必须来自下面给出的编号，不要编。
"trap" 是熟词僻义标记：0/1。只在「这个词日常最熟的意思是别的、而这个义项生僻」时才给 1，
它是新卡起始间隔的依据，宁可漏标也不要乱标。`

export const PROMPT_BLOCKS: PromptBlock[] = [
  {
    id: 'system',
    title: '共用审校规则',
    where: '整词审查 / 义项审查 / AI 补全 / 补例句 / 换句 —— 这五处的 system 消息（改一次，五处都变）',
    vars: [],
    required: [],
    risk: '这里的判断标准会影响所有审查类动作。删掉「只输出 JSON」会让所有动作解析失败。',
    text: `你是英语学习词库的内容审校助手。你只输出严格 JSON（不要代码块、不要解释文字）。

判断标准：
- 释义 gloss 要与词性 pos、英文释义 glossEn 一致；中文要能区分同词的其它义项（近义/重复的要指出）。
- 例句必须真的用到「这个词的这个义项」，中文翻译要忠实；例句里不该出现目标词的其它义项。
- 造句/换句前先锁定当前义项：句子的语法角色与搭配必须属于这个义项。义项较生僻时，
  宁可句子简单一点，也不要退回到该词更常见的意思。
- 同一个词的义项各有自己的常见搭配；不要把属于其它义项的搭配硬套到当前义项上，
  集合名词、抽象名词、专业义项尤其容易串义。
- 例句用常见词、自然书面英语，12-20 个词，且必须包含目标词或它的屈折形式。
- 目标词**优先用词典原形**（名词单数、动词原形、形容词原级）：一组例句里约三分之二用原形。
  只有句法必须时才屈折（主语三单、确实需要复数、叙事用过去时），且同一组里不要全是同一种屈折形式 ——
  形式有点变化才像真实语料；也不要为了凑情境硬用复数或过去式。
- 每条例句必须带 highlights 数组：列出句中**所有**属于目标词的词形，包括三单、复数、过去式、过去分词、现在分词，以及 went / made / children 这类不规则变化。每个元素必须逐字出现在 en 里；同一词形只列一次；没有目标词就不要给这句。
- 目标词是一个词条：不同词性/义项挂在同一个词条下，绝不为了词性另建单词；词形变化只出现在例句的 highlights 里，不另建词条。
- 宁缺勿滥：只报告**确实有问题**的条目，没问题的不要列。改一条错的，胜过多改十条对的。
  但如果**同一个错误模式出现在多句里，必须逐句指出**，不能只改一句就当作修好了。
- why 是写给用户看的一句话：**不要出现 sentenceId / slot 这类内部编号**，
  用「原来那句」「第 2 个义项」这样的说法。`,
  },
  {
    id: 'shape',
    title: '输出 JSON 形状',
    where: '整词审查 / 义项审查 / AI 补全 / 补例句 / 换句 —— 拼在每段指令末尾（{{shape}}）',
    vars: [],
    required: [],
    risk: '这一段就是解析器的输入契约。字段名（kind / slot / sentenceId / proposals…）改了会让 AI 的回复全部作废。',
    text: SHAPE,
  },
  {
    id: 'reviewWord',
    title: '审查一个词',
    where: '词条页 → AI 审查；AI 体检 → 逐个词',
    vars: [
      { name: 'context', desc: '词条当前内容：词、音标、义项（带 slot）、例句（带 sentenceId）' },
      { name: 'shape', desc: '上面那块「输出 JSON 形状」的全文' },
    ],
    required: ['context', 'shape'],
    risk: '这是 AI 审查的全部指令。删掉对某个问题的描述，AI 就不再检查那一项。',
    text: `{{context}}

请审查：哪些释义与词性/英文不一致、哪些中文近义到分不开、哪些例句没有真正用到它该教的义项、
有没有明显缺的常用义项（最多补 1 条）、**音标缺失或明显错**、**哪个义项是熟词僻义**（trap=1，谨慎）。
判断例句时以它挂的那个义项为准：不要因为另一个义项更常见，就觉得这句没问题。
例句要逐句看：有问题就用 kind="sentence.replace" 指出来；同一个错误模式出现在多句里，就逐句替换，
不要只补一句新的当作修好了。只有例句不足（少于 2 句）或明显缺某种常见用法时，才用 kind="sentence.add"。
最多 12 条 proposal；多句同错时优先把错句换完，不要为了压条数只改一句。
{{shape}}`,
  },
  {
    id: 'reviewSense',
    title: '审查一个义项',
    where: '义项页 → AI 审查',
    vars: [
      { name: 'context', desc: '词条当前内容；目标义项的例句会全部列出，其它义项只给释义' },
      { name: 'slot', desc: '要审查的义项编号' },
      { name: 'noteLine', desc: '用户临时补充要求，形如「用户补充要求：……」；没填时为空串' },
      { name: 'shape', desc: '上面那块「输出 JSON 形状」的全文' },
    ],
    required: ['context', 'slot', 'shape'],
    risk: '只影响义项页的审查按钮。这里要求逐句替换；删掉后 AI 会退回「只补一句」。',
    text: `{{context}}

请只审查 slot={{slot}} 这个义项，重点是它的**全部例句**：
1. 逐句检查：有没有没真正用到这个义项（被更常见的义项带跑了也算）、中文翻译不忠实、句子不自然/太短/太长、或和同义项其它句重复的；
2. 有问题的句子用 kind="sentence.replace" **逐句**返回，sentenceId 必须是上下文里已有的编号；
3. 同一个错误模式出现在多句里，就全部替换，不要只补一句新的了事；
4. 只有例句少于 2 句、或某个常见用法明显没有例句覆盖时，才用 kind="sentence.add" 补；已有可用例句不要重复补；
5. 这个义项的释义/词性/英文释义/熟词僻义确实有问题时也可以改，但不要顺手重写没问题的内容。
{{noteLine}}
没问题的不要列。
{{shape}}`,
  },
  {
    id: 'addSentence',
    title: '给一个义项补例句',
    where: '义项页 → 补例句',
    vars: [
      { name: 'context', desc: '词条当前内容；会标出【当前义项】并列出它的全部例句' },
      { name: 'slot', desc: '要补例句的那个义项编号' },
      { name: 'howMany', desc: '要几条候选' },
      { name: 'shape', desc: '上面那块「输出 JSON 形状」的全文' },
    ],
    required: ['context', 'slot', 'howMany', 'shape'],
    risk: '只影响「补例句」这一个按钮，改坏了不影响审查。',
    text: `{{context}}

只给 slot={{slot}} 这个义项（上下文里的【当前义项】）补例句：
1. 只能用当前义项造句，不能切到该词的其它义项；如果它比较生僻，宁可句子简单，也不要退回更常见的意思；
2. 目标词在句中的语法角色/搭配必须属于当前义项，不要把其它义项的常见句型套过来
   （集合名词、抽象名词、专业义项尤其容易串义）；
3. 生成 {{howMany}} 条候选，场景和句式各不相同，且不要和已有例句相似；
4. 全部用 kind="sentence.add"，slot={{slot}}；每条都要给 highlights
   （句中实际出现的所有目标词词形，含不规则变化）。
{{shape}}`,
  },
  {
    id: 'replaceSentence',
    title: '换掉一条例句',
    where: '义项页 → 换句；训练页 → 当场换句；首页卡片 → 换句',
    vars: [
      { name: 'context', desc: '词条当前内容；会标出【当前义项】和目标句，并列出该义项全部例句' },
      { name: 'sentenceId', desc: '要换掉的那句例句编号' },
      { name: 'whyNote', desc: '用户填的问题说明，形如「（问题：……）」；没填时为空串' },
      { name: 'shape', desc: '上面那块「输出 JSON 形状」的全文' },
    ],
    required: ['context', 'sentenceId', 'shape'],
    risk: '三个入口共用这一段。改坏了三处一起坏。',
    text: `{{context}}

请**替换** sentenceId={{sentenceId}} 这一句{{whyNote}}：
1. 只能用上下文里的【当前义项】造句，不能切到该词的其它义项；如果义项较生僻，
   宁可句子简单，也不要退回更常见的意思；
2. 目标词在句中的语法角色/搭配必须属于当前义项，不要把其它义项的常见句型套过来
   （集合名词、抽象名词、专业义项尤其容易串义）；
3. 只给 1 句，场景、句式和措辞都要和原句以及同义项其它句不同；
4. kind="sentence.replace"，sentenceId={{sentenceId}}；必须给 highlights
   （句中实际出现的所有目标词词形，含不规则变化）。
{{shape}}`,
  },
  {
    id: 'fillWord',
    title: '补全空壳词',
    where: '加词弹窗（首页/训练页的「生成」）→ AI 生成',
    vars: [
      { name: 'context', desc: '词条当前内容（空壳词时基本只有词和音标）' },
      { name: 'senseCount', desc: '最多补几个义项' },
      { name: 'minSentences', desc: '每个义项至少几句例句（当前为 ' + MIN_SENTENCES_PER_SENSE + '）' },
      { name: 'shape', desc: '上面那块「输出 JSON 形状」的全文' },
    ],
    required: ['context', 'senseCount', 'minSentences', 'shape'],
    risk: '这里的「全有或全无」条款（每个义项都要配够例句）被代码硬检查；删掉它只会让 AI 更容易交出半成品。',
    text: `{{context}}

这个词在词库里是**空壳**（没有释义，或只有占位义项）。请把它补成能背的卡：
1. 给 {{senseCount}} 个以内最常用的义项（按常用度排序）；如果已有占位义项（slot 有编号但 gloss 为空或明显不对），
   用 kind="sense.update" + 那个 slot 直接改写它，不要重复新建；
2. **每个义项都必须带 {{minSentences}} 条例句**，写在同一条提案的
   "sentences":[{"en":"……","zh":"……","highlights":["……"]}, …] 里。
   kind="sense.add" 和 kind="sense.update" 都一样：新义项还没有编号，占位义项也要一次补全；
3. 不要只给其中一个义项配例句。**要么所有义项都配齐 {{minSentences}} 句，要么整份 proposals 返回空数组**，
   只补一半的结果不会被采用；
4. 每条例句都必须真的用上这个词（多数用原形，句法需要时才屈折），12-20 个词，场景各不相同，自然书面英语，并给 highlights
   （句中实际出现的所有目标词词形，含 went / made 这类不规则变化）；
5. 所有词性都作为**同一个词条**下的不同义项，不要按词性另造词条；词条没有音标时，
   用 kind="word.update" 给一个（英式或美式都可，只写音标本身）。

{{shape}}
kind="sense.add" 和 kind="sense.update" 的例句都写在提案的 "sentences" 数组里。例如：
{"kind":"sense.update","slot":1,"gloss":"……","sentences":[{"en":"……","zh":"……","highlights":["……"]},{"en":"……","zh":"……","highlights":["……"]}]}`,
  },
  {
    id: 'lemma',
    title: '判原形',
    where: '首页/训练页 → 点句子里的生词 → 「加入词库」（只在未入库时问一次）',
    vars: [
      { name: 'token', desc: '句子里点到的那个词形（可能是复数/过去式）' },
      { name: 'sentenceLine', desc: '所在句子那一行，形如「所在句子：……」；没有句子时为空串' },
    ],
    required: ['token'],
    risk: '它只决定「入库存成哪个词形」，不改已有内容；返回空串时程序会退回按句中形式入库。',
    text: `你是英语词典编辑。只输出严格 JSON（不要代码块、不要解释文字）。

句中的词：{{token}}{{sentenceLine}}

请给出它在词典里的**原形**（lemma）：
- 名词用单数，动词用原形（不定式），形容词/副词用原级；
- 不规则变化也要还原（went → go、children → child、mice → mouse）；
- 它本来就是原形就原样返回；
- 只写小写单词本身，不要音标、词性、释义；
- 如果它不是普通的英语单词（人名、地名、缩写、拼错的串），word 返回空字符串。

输出：{"word":"army"}`,
  },
  {
    id: 'copyTemplate',
    title: '复制给 AI 的模板',
    where: '词条页 / 义项页 → 「复制给 AI」（粘到豆包/DeepSeek，回来的 JSON 再导入）',
    vars: [
      { name: 'word', desc: '单词' },
      { name: 'ipaLine', desc: '音标文字；没有时是「（无）」' },
      { name: 'senses', desc: '现有义项列表（每个意思的编号、中文释义、英文释义、备注）' },
      { name: 'sensesJson', desc: '按现有义项生成的输出 JSON 骨架' },
    ],
    required: ['word', 'senses', 'sensesJson'],
    risk: '这不是自动调用，是复制给人粘贴的文本。改了它只影响「复制」出来的内容。',
    text: `单词: {{word}}
音标: {{ipaLine}}

{{senses}}
请核验并补全：
1. 上述中文释义是否准确？不准确请给出更好的。
2. 为每个意思造 5 个英文例句 + 中文翻译，每句必须能体现该义项的独特用法（能与同词其他义项区分开）。
   例句里的目标词**优先用原形**（约三分之二）：名词单数、动词原形、形容词原级；句法必须时才屈折，
   且 5 句里不要全是同一种屈折形式，也不要为了凑情境硬用复数或过去式。
3. 只输出下面这个 JSON，不要任何其他文字。sentences[].highlights 填句中**所有**目标词词形
   （如 goes / went / gone，数组可多项；每个词形都要逐字出现在句子里），
   translation 填整句中文翻译，clue 填句子里能体现该义项的语境线索（clue 要能在句中找到）。
   不同词性都放在同一个 word 下的不同 sense 里，不要按词性另造单词。

{"word":"{{word}}","senses":[
{{sensesJson}}
]}`,
  },
]

export const BLOCK_BY_ID = new Map(PROMPT_BLOCKS.map((b) => [b.id, b]))
