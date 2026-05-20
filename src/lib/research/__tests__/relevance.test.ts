import { describe, expect, it } from 'vitest';
import { classifyWebResultsForResearchContext } from '../relevance';
import type { ResearchWikiContext, WebSearchResult } from '../store';

const question = '如果我想给福瑞科技园三期项目的医疗业态引流，你可以给策划一下吗？';

const wikiContext: ResearchWikiContext[] = [
  {
    title: '福瑞健康科技园三期项目',
    path: 'wiki/projects/福瑞健康科技园三期项目.md',
    content: '项目位于乌兰察布市集宁区，关注医疗与康养服务。',
  },
  {
    title: '睡眠健康管理',
    path: 'wiki/concepts/睡眠健康管理.md',
    content: '睡眠健康管理是项目医疗业态可借鉴的服务方向。',
  },
];

function web(title: string, snippet: string): WebSearchResult {
  return {
    title,
    url: `https://example.com/${encodeURIComponent(title)}`,
    snippet,
    source: 'example.com',
  };
}

describe('research web relevance', () => {
  it('marks external cases without project keywords as weak references', () => {
    const [result] = classifyWebResultsForResearchContext(
      [web('济南科技城医疗器械产业园招商策划案例', '介绍医疗器械园区获客、招商和运营打法。')],
      wikiContext,
      question,
    );

    expect(result.relevance).toBe('weak');
    expect(result.relevanceReason).toContain('未命中当前 Wiki 项目关键词');
  });

  it('keeps pages with the current project keyword as direct project material', () => {
    const [result] = classifyWebResultsForResearchContext(
      [web('福瑞科技园三期医疗健康服务规划', '围绕福瑞科技园三期的医疗业态进行运营策划。')],
      wikiContext,
      question,
    );

    expect(result.relevance).toBe('direct');
  });

  it('does not promote generic concept matches to direct project facts', () => {
    const [result] = classifyWebResultsForResearchContext(
      [web('睡眠健康管理中心引流方法', '面向健康管理机构的散客获客和会员转化案例。')],
      wikiContext,
      question,
    );

    expect(result.relevance).toBe('weak');
  });
});
