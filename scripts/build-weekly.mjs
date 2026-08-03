/**
 * 生成一期周报。
 *
 * 数据来自 https://dzpk.net/weekly.json —— 主站算好的结构化摘要,包含主题分组、
 * 每条的标题摘要和站内链接。这里只负责排版:哪些帖子值得列、归到哪个主题,都是主站
 * 那边的判断(见主站 src/lib/weekly.ts),这样改版式不会影响选稿,反过来也一样。
 *
 * 输出两处:
 * - weeks/<周编号>.md,这一期的正文,写好就不再改动。
 * - README.md,把最新一期的正文原样嵌进去,再列出往期。仓库首页是搜索引擎最可能收录的
 *   那一页,让它自己就带着内容,而不是只有一堆指向别处的链接。
 *
 * 用法:
 *   node scripts/build-weekly.mjs                     # 本期,定时任务走这条
 *   node scripts/build-weekly.mjs --backfill 3        # 本期 + 往前 3 期,补历史或补漏用
 *   node scripts/build-weekly.mjs --from report.json   # 用本地文件,排版调试时用
 */

import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

const FEED_URL = 'https://dzpk.net/weekly.json'
const WEEKS_DIR = 'weeks'
const README = 'README.md'
/** README 里被整段替换的区间。区间外的介绍文字是手写的,不要动。 */
const LATEST_START = '<!-- latest:start -->'
const LATEST_END = '<!-- latest:end -->'
const ARCHIVE_START = '<!-- archive:start -->'
const ARCHIVE_END = '<!-- archive:end -->'
/** 一期至少要有这么多主题才值得发。低于此数说明那一周没什么内容,或者上游数据出了问题。 */
const MIN_TOPICS = 3
/**
 * 也要够多的条目。主题数拦不住「半截的一周」:回填越过站点内容的起点时,窗口仍然横跨
 * 七天、仍能凑出几个主题,但里面只有最后一两天的东西——实测那样一期是 4 个主题 13 条,
 * 而正常一周是 17 到 21 个主题、77 到 91 条。发出去等于用一个整周的日期范围套一天半的
 * 内容,不如不发。
 */
const MIN_ENTRIES = 20
const WEEK_MS = 7 * 86400000

function parseArgs(argv) {
  const value = flag => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined)
  const from = value('--from')
  const backfill = Number(value('--backfill') ?? 0)

  if (!Number.isInteger(backfill) || backfill < 0) {
    throw new Error('--backfill 要一个非负整数')
  }

  if (from && backfill) {
    throw new Error('--from 是给单期排版调试用的,不能和 --backfill 一起使用')
  }

  return { backfill, from }
}

/**
 * 取一期的数据。`end` 是窗口右端,省略就是「刚过去的七天」。
 *
 * 往期靠主站的 ?end= 参数取(见主站 src/lib/weekly.ts)。步长固定七天,所以每期的窗口
 * 起点都落在同一个星期几上——定时任务在周一跑,回填也在周一跑的话,各期正好对齐 ISO 周。
 */
async function loadReport(from, end) {
  if (from) {
    return JSON.parse(await readFile(from, 'utf8'))
  }

  const url = new URL(FEED_URL)

  if (end) {
    url.searchParams.set('end', end.toISOString())
  }

  // 带一个参数绕开边缘缓存。那个端点缓存一小时,是为了挡住反复请求;而这里一周只来一次,
  // 拿一份现算的结果不值几个钱,却能避免「刚改了上游逻辑,这一期还是按旧规则生成」。
  url.searchParams.set('t', String(Date.now()))

  const response = await fetch(url, { headers: { 'user-agent': 'dzpk-weekly/1' } })

  if (!response.ok) {
    throw new Error(`${url.pathname}${url.search} 返回 ${response.status}`)
  }

  return response.json()
}

/** 2026-08-03T10:00:00+00:00 → 8 月 3 日。按 UTC 读,和主站的时间戳保持一致。 */
function formatDay(iso) {
  const date = new Date(iso)

  return `${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`
}

function formatRange(from, to) {
  const start = new Date(from)
  const end = new Date(to)
  const year = end.getUTCFullYear()

  return `${year} 年 ${formatDay(start)} – ${formatDay(end)}`
}

/**
 * Markdown 里有特殊含义的字符要转义。
 *
 * 标题来自频道正文,里面出现过 `[`、`*`、`_`,不处理会把一行拆成半个链接或者莫名的斜体。
 */
function escapeMarkdown(text) {
  return text.replace(/[\\`*_[\]<>|]/g, char => `\\${char}`)
}

function renderTopic(topic) {
  const lines = [`### [${escapeMarkdown(topic.tag)}](${topic.url})`, '']

  if (topic.total > topic.posts.length) {
    lines.push(`本周 ${topic.total} 篇，摘选 ${topic.posts.length} 篇。`, '')
  }

  for (const post of topic.posts) {
    lines.push(`- **[${escapeMarkdown(post.title)}](${post.url})** · ${formatDay(post.datetime)}`)

    if (post.excerpt) {
      lines.push(`  ${escapeMarkdown(post.excerpt)}`)
    }
  }

  lines.push('')

  return lines
}

/** 一期的正文。不含 h1:嵌进 README 时那一级标题由 README 自己出。 */
function renderBody(report) {
  const lines = [
    `> ${formatRange(report.from, report.to)} · 本周更新 ${report.total} 篇 · 内容来自 [dzpk.net](${report.site})`,
    '',
    '中文德州扑克频道本周的赛事战报、业内动态与策略内容摘选，按主题分组，点标题看原文。',
    '',
  ]

  for (const topic of report.topics) {
    lines.push(...renderTopic(topic))
  }

  lines.push(
    '---',
    '',
    `完整内容在 [dzpk.net](${report.site})：[按月归档](${report.site}archive) · [标签目录](${report.site}tags) · [站内搜索](${report.site}search)`,
    '',
  )

  return lines.join('\n')
}

function renderIssue(report) {
  return `# dzpk.net 周报 ${report.label}\n\n${renderBody(report)}`
}

/** 把 README 里两个标记之间的内容整段换掉。找不到标记就报错,别悄悄什么都不做。 */
function replaceRegion(readme, start, end, content) {
  const from = readme.indexOf(start)
  const to = readme.indexOf(end)

  if (from < 0 || to < 0) {
    throw new Error(`README 里找不到 ${start} … ${end} 标记`)
  }

  return `${readme.slice(0, from + start.length)}\n${content}\n${readme.slice(to)}`
}

async function listIssues(latestLabel) {
  const files = await readdir(WEEKS_DIR).catch(() => [])

  return files
    .filter(name => name.endsWith('.md'))
    .map(name => name.replace(/\.md$/, ''))
    .filter(label => label !== latestLabel)
    .sort()
    .reverse()
}

const { backfill, from } = parseArgs(process.argv.slice(2))
const now = Date.now()
/** 本期在前,往期依次往后。步长七天。 */
const ends = [undefined, ...Array.from({ length: backfill }, (_, index) => new Date(now - (index + 1) * WEEK_MS))]
const built = []

function countEntries(report) {
  return report.topics.reduce((sum, topic) => sum + topic.posts.length, 0)
}

for (const end of ends) {
  const report = await loadReport(from, end)
  const topics = report.topics?.length ?? 0
  const entries = topics ? countEntries(report) : 0

  // 内容不够就跳过这一期、继续往下走:回填时中途 exit 会把已经取到的往期一起丢掉。
  if (topics < MIN_TOPICS || entries < MIN_ENTRIES) {
    console.info(`${report.label} 只有 ${topics} 个主题 ${entries} 条,不够 ${MIN_TOPICS} 个主题 ${MIN_ENTRIES} 条,跳过`)
    continue
  }

  await writeFile(`${WEEKS_DIR}/${report.label}.md`, renderIssue(report), 'utf8')
  built.push(report)
  console.info(`已生成 ${report.label}:${topics} 个主题,${entries} 条摘选`)
}

if (!built.length) {
  console.info('这一轮没有生成任何一期,README 不动')
  process.exit(0)
}

// README 里「最新一期」放这轮里最新的那一期。ends 是按时间倒序排的,所以取第一个。
const report = built[0]
const issues = await listIssues(report.label)
const archive = issues.length
  ? issues.map(label => `- [${label}](${WEEKS_DIR}/${label}.md)`).join('\n')
  : '_还没有往期。_'

const readme = await readFile(README, 'utf8')
const withLatest = replaceRegion(
  readme,
  LATEST_START,
  LATEST_END,
  // 这一节的 h2 由注入内容自己出,标题里带上期号;正文里的主题是 h3,层级刚好接上。
  `## 最新一期：${report.label}\n\n${renderBody(report)}`,
)

await writeFile(README, replaceRegion(withLatest, ARCHIVE_START, ARCHIVE_END, archive), 'utf8')

// 提交信息要用这一期的编号。工作流在周一跑,那时 `date` 给的已经是新的一周了。
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `label=${report.label}\n`, 'utf8')
}

console.info(`README 最新一期指向 ${report.label},往期 ${issues.length} 期`)
