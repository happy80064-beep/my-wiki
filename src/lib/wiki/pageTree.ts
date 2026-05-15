import { WIKI_PAGE_TYPE_ORDER, type WikiPageIndexEntry, type WikiPageType } from './scanner';

export type WikiPageGroup = {
  type: WikiPageType;
  label: string;
  pages: WikiPageIndexEntry[];
};

const typeLabels: Record<WikiPageType, string> = {
  overview: '总览',
  project: '项目',
  entity: '实体',
  concept: '概念',
  source: '来源',
  query: '查询',
  synthesis: '综合',
  purpose: '用途',
  schema: 'Schema',
  comparison: '对比',
  decision: '决策',
  meeting: '会议',
  stakeholder: '干系人',
  methodology: '方法',
  finding: '发现',
  thesis: '论点',
  book: '书籍',
  character: '人物',
  theme: '主题',
  'plot-thread': '情节线',
  chapter: '章节',
  goal: '目标',
  habit: '习惯',
  reflection: '复盘',
  journal: '日记',
};

export function groupWikiPagesByType(pages: WikiPageIndexEntry[]): WikiPageGroup[] {
  const grouped = new Map<WikiPageType, WikiPageIndexEntry[]>();
  for (const page of pages) {
    const group = grouped.get(page.type) ?? [];
    group.push(page);
    grouped.set(page.type, group);
  }

  return [...grouped.entries()]
    .map(([type, items]) => ({
      type,
      label: typeLabels[type],
      pages: [...items].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN')),
    }))
    .sort((a, b) => WIKI_PAGE_TYPE_ORDER.indexOf(a.type) - WIKI_PAGE_TYPE_ORDER.indexOf(b.type));
}

export function typeLabel(type: WikiPageType) {
  return typeLabels[type];
}
