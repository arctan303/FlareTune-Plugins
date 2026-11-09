import { getLocale, t } from "@flaretune/plugin-sdk/client/i18n";

// The persisted/SSE contract stores tool copy as strings. Match complete known
// system messages so historical records can be localized without rewriting
// records or treating song names, playlist names, or model prose as UI copy.
const templates = [
  '查询 {timeZone} 当前时间',
  '读到 {count} 个个人歌单',
  '读取了 {count} 个个人歌单',
  '读到《{name}》的 {count} 首歌曲',
  '读到 {count} 首收听最多的歌曲',
  '搜索「{keyword}」找到 {count} 首歌曲',
  '查询到 {count} 首歌曲',
  '已查询 {count} 条记忆',
  '读取了《{title}》资料与 {count} 行歌词',
  '读取了《{title}》资料',
  '读取歌单《{name}》',
  '歌单《{name}》此前已创建',
  '已创建歌单《{name}》',
  '等待确认删除歌单《{name}》',
  '歌名「{title}」对应多首歌曲，请使用歌曲 ID。',
  '找不到歌曲「{title}」。',
];

const actionTemplates = [
  '播放《{title}》',
  '插播《{title}》为下一首',
  '向播放队列追加 {count} 首歌曲',
  '替换为包含 {count} 首歌曲的播放队列',
  '更新播放队列（{count} 首）',
  '跳转播放进度至 {position}%',
  '跳转播放进度至 {position} 秒',
];

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compile = source => {
  const keys = [...source.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]);
  const parts = source.split(/\{[A-Za-z][A-Za-z0-9]*\}/g).map(escapeRegExp);
  const pattern = parts.reduce((result, part, index) => result + (index
    ? (keys[index - 1] === 'count' ? '(\\d+)' : '([\\s\\S]*?)') : '') + part, '');
  return { source, keys, pattern: new RegExp(`^${pattern}$`) };
};
const summaryRules = templates.map(compile);
const actionRules = actionTemplates.map(compile);
const matchTemplate = (text, rules) => {
  for (const { source, keys, pattern } of rules) {
    const match = text.match(pattern);
    if (match) {
      const values = Object.fromEntries(keys.map((key, index) => [key, match[index + 1]]));
      if (Object.hasOwn(values, 'position')) values.count = Number(values.position);
      return t(source, values);
    }
  }
  return null;
};

const progressGroups = [
  ['正在发现歌曲…', ['我从曲库里挑几首。', '我去曲库里转一圈。', '我从乐境里找几首合适的。', '我看看曲库里有什么值得一听的。']],
  ['正在检查播放器状态…', ['我处理一下播放器状态。', '我来调整一下播放状态。', '我看看播放器现在的状态。', '我帮你操作一下播放器。']],
  ['正在查询当前时间…', ['我确认一下当前时间。', '我看一眼现在的时间。', '我去核对一下时区和时间。', '我帮你查一下当地时间。']],
  ['正在读取歌单…', ['我看看你的歌单。', '我去翻一下你的歌单。', '我先读一下歌单状态。', '我帮你确认一下歌单内容。', '我看看你的个人歌单。', '我先读一下你的歌单内容。']],
  ['正在检查歌单调整…', ['我先核对一下这个歌单。', '我看看歌单现在的状态。', '我先确认一下这次歌单调整。', '我来处理一下这份歌单。']],
  ['正在准备播放队列…', ['我准备调整一下播放队列。', '我先看看现在的播放队列。', '我来整理一下接下来要播放的内容。', '我帮你安排一下接下来的播放顺序。']],
  ['正在检查播放位置…', ['我准备调整一下播放进度。', '我先确认一下要跳到的位置。', '我来处理一下播放位置。', '我帮你把进度移到合适的位置。']],
  ['正在读取收听统计…', ['我看看你的收听统计。', '我去翻一下你的收听记录。', '我先核对一下你的播放数据。', '我帮你理一下你常听的歌。']],
  ['正在读取歌曲资料…', ['我读一下这首歌的资料。', '我核对一下这首歌的信息。']],
  ['正在准备关闭随机漫游…', ['我准备关闭随机漫游。', '我来关掉随机漫游。', '我帮你把随机漫游停下。']],
  ['正在准备开启随机漫游…', ['我准备开启随机漫游。', '我来打开随机漫游。', '我帮你把随机漫游开起来。']],
  ['正在检查随机漫游…', ['我先处理一下随机漫游的开关。']],
  ['正在检查相关信息…', ['我先核对一下相关信息。', '我去确认一下。', '我先看看具体情况。', '我帮你查一下。']],
];
const progressMessages = new Map(progressGroups.flatMap(([key, messages]) => messages.map(message => [message, key])));
const targetedProgress = [
  ['正在曲库中查找{target}…', ['我去曲库里找一下{target}。', '我帮你看看曲库里的{target}。', '我先核对一下{target}的曲库信息。', '我在曲库里找找{target}。']],
  ['正在准备播放{target}…', ['我准备一下{target}。', '我去把{target}找出来。', '我先确认一下{target}的播放信息。', '我帮你把{target}接到播放器上。']],
  ['正在准备新歌单{target}…', ['我准备一下新歌单{target}。', '我先核对一下新歌单{target}。', '我来整理一下新歌单{target}。', '我帮你把新歌单{target}建起来。']],
].flatMap(([key, messages]) => messages.map(message => ({ ...compile(message), key })));

const staticKeys = [
  '记忆已存在', '记忆操作未完成', '时区参数无效', '当前无播放曲目', '需要登录账号',
  '播放统计存储不可用', '收听统计参数无效', '暂无收听记录', '收听统计查询失败',
  'song_ids 必须是有效歌曲 ID 或歌名数组。', '请提供有效的个人歌单 ID。',
  '歌单已在其他页面更新，请先重新读取。', '缺少操作标识，未创建歌单。', '歌曲未能加入歌单。',
  '这些歌曲已在歌单中', '已将歌曲加入个人歌单', '排序必须包含当前歌单所有歌曲，且不能重复。',
  '歌单内容无需修改', '已更新个人歌单歌曲', '歌单信息无需修改', '已更新个人歌单信息',
  '“我的收藏”歌单不可删除。', '已删除个人歌单', '未知的歌单动作。', '个人歌单存储暂时不可用。',
  '个人歌单存储不可用', '个人歌单参数无效', '暂无个人歌单', '个人歌单不存在', '个人歌单查询失败',
  '播放器参数无效', '乐境曲库不可用', '未找到可播放歌曲', '播放歌曲查询失败', '乐境曲库查询失败',
  '语种参数无效', '曲库查询参数无效', '搜索词为空', '队列动作参数无效', '缺少歌曲 ID',
  '曲库数据库不可用', '未找到可播放的曲目', '播放队列操作失败', '跳转参数无效',
  '随机漫游参数无效', '漫游语种参数无效', '歌曲资料不可用', '未找到歌曲',
  '本轮操作数量已达上限。', '已完成的操作未重复执行', '操作数量已达上限', '当前播放状态未知',
  '缓冲中', '播放中', '已暂停', '状态未知', '未播放', '暂停播放', '继续播放', '切换播放状态',
  '关闭随机漫游', '其他语种', '已记住', '已调用', '这首歌',
  'ID 格式无效。', 'expectedRevision 必须是非负整数。', '歌单名称需为 1 到 40 个字符。',
  '歌单简介不能超过 300 个字符。', 'songIds 数量无效。', 'songIds 不能包含重复 ID。',
  '歌单已在其他页面更新。', '部分歌曲不存在。', '歌单不存在。',
  '每个账号最多创建 50 个普通歌单。', '“我的收藏”名称和简介不可修改。',
  '至少提供 name 或 description。', '收藏歌单不可改名。', '每个歌单最多保存 500 首歌曲。',
];

// Consumed by catalog validation: data-driven translation calls have the same
// required coverage as literal t(...) calls in JSX.
export const ASSISTANT_TOOL_TEXT_KEYS = Object.freeze([...new Set([
  ...templates, ...actionTemplates, ...progressGroups.map(([key]) => key),
  ...targetedProgress.map(({ key }) => key), ...staticKeys,
  '播放器指令已生成：{target}', '开启【{language}】随机漫游',
  '（{seconds}s / {duration}s，{percent}）', '（{seconds}s / {duration}s）',
  '{state}{progress}：《{title}》- {artist}',
])]);

function formatProgress(text) {
  if (progressMessages.has(text)) return t(progressMessages.get(text));
  for (const { pattern, key } of targetedProgress) {
    const match = text.match(pattern);
    if (match && /^(?:《[^《》]*》|这首歌|)$/.test(match[1])) {
      return t(key, { target: match[1] === '这首歌' ? t('这首歌') : match[1] });
    }
  }
  return null;
}

function formatPlayerTarget(text) {
  const matched = matchTemplate(text, actionRules);
  if (matched !== null) return matched;
  const roam = text.match(/^开启【(全库|华语|欧美|日文|韩语|纯音乐|其他语种)】随机漫游$/);
  if (roam) return t('开启【{language}】随机漫游', { language: t(roam[1]) });
  return t(text);
}

/** Only call for system-authored tool summaries/progress, never assistant prose. */
export function formatAssistantToolText(text) {
  if (typeof text !== 'string' || !text) return t('已调用');
  if (getLocale() === 'zh') return text;
  const generated = text.match(/^播放器指令已生成：([\s\S]+)$/);
  if (generated) return t('播放器指令已生成：{target}', { target: formatPlayerTarget(generated[1]) });
  const playback = text.match(/^(缓冲中|播放中|已暂停|状态未知|未播放)(?:（(\d+)s \/ (\d+)s(?:，(\d+%))?）)?：《([\s\S]*?)》- ([\s\S]*)$/);
  if (playback) {
    const progress = playback[2] === undefined ? '' : playback[4]
      ? t('（{seconds}s / {duration}s，{percent}）', { seconds: playback[2], duration: playback[3], percent: playback[4] })
      : t('（{seconds}s / {duration}s）', { seconds: playback[2], duration: playback[3] });
    return t('{state}{progress}：《{title}》- {artist}', {
      state: t(playback[1]), progress, title: playback[5], artist: playback[6],
    });
  }
  return matchTemplate(text, summaryRules) ?? formatProgress(text) ?? t(text);
}

export const formatAssistantToolEntry = entry => formatAssistantToolText(entry?.summary || entry?.progress || '已调用');
