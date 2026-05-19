import { describe, expect, it } from 'vitest';
import { buildWikiPageMetadata, isSuspiciousWikiDescription, repairWikiMarkdownDescription } from '../pageMetadata';

const fallback = {
  title: 'Fallback Project',
  type: 'project' as const,
  tags: ['health'],
};

describe('wiki page metadata view model', () => {
  it('extracts llm-wiki style frontmatter fields for the page header card', () => {
    const metadata = buildWikiPageMetadata(
      [
        '---',
        'type: entity',
        'title: "Project Three"',
        'created: 2026-04-29',
        'updated: 2026-05-09',
        'tags: ["park", "compute", "health"]',
        'sources: ["raw/sources/report.docx"]',
        'related: ["Hospital A", "Compute Center"]',
        'confidence: high',
        '---',
        '',
        '# Project Three',
        '',
        '## Summary',
        'Main page content.',
      ].join('\n'),
      fallback,
    );

    expect(metadata.title).toBe('Project Three');
    expect(metadata.type).toBe('entity');
    expect(metadata.tags).toEqual(['park', 'compute', 'health']);
    expect(metadata.sources).toEqual(['raw/sources/report.docx']);
    expect(metadata.related).toEqual(['Hospital A', 'Compute Center']);
    expect(metadata.updated).toBe('2026-05-09');
    expect(metadata.description).toBe('Main page content.');
    expect(metadata.extras).toEqual([{ key: 'confidence', value: 'high' }]);
    expect(metadata.body).toContain('Main page content.');
  });

  it('normalizes related frontmatter values written as wikilinks', () => {
    const metadata = buildWikiPageMetadata(
      [
        '---',
        'type: entity',
        'title: "李俊杰"',
        'updated: 2026-05-15',
        'tags: []',
        'sources: []',
        'related: ["[[concepts/运营经理]]", "[[entities/company|公司]]"]',
        '---',
        '',
        '# 李俊杰',
      ].join('\n'),
      fallback,
    );

    expect(metadata.related).toEqual(['concepts/运营经理', 'entities/company']);
  });

  it('falls back to entity fields when a page has no frontmatter', () => {
    const metadata = buildWikiPageMetadata('# Temp Page\n\nBody text', fallback);

    expect(metadata.title).toBe('Fallback Project');
    expect(metadata.type).toBe('project');
    expect(metadata.tags).toEqual(['health']);
    expect(metadata.description).toBe('Body text');
    expect(metadata.body).toContain('Body text');
  });

  it('hides model thinking that was accidentally saved in older markdown', () => {
    const metadata = buildWikiPageMetadata(
      [
        '<think>This must never be shown.</think>',
        '---',
        'type: entity',
        'title: "Partner Hospital"',
        'tags: ["tcm"]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# Partner Hospital',
        '',
        '## Summary',
        'Joint medical partner.',
      ].join('\n'),
      fallback,
    );

    expect(metadata.body).not.toContain('<think>');
    expect(metadata.body).not.toContain('must never be shown');
    expect(metadata.body).toContain('Joint medical partner.');
  });

  it('treats polluted frontmatter descriptions as suspicious and falls back to body summary', () => {
    const metadata = buildWikiPageMetadata(
      [
        '---',
        'type: topic',
        'title: "Query Insight"',
        'description: "MiniMax failed: fetch failed ??? ??? Wiki ?? ###### 3279 / OpenAI / ????"',
        'tags: ["query-insight"]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# Query Insight',
        '',
        '## Summary',
        'A short useful answer.',
      ].join('\n'),
      fallback,
    );

    expect(isSuspiciousWikiDescription('MiniMax failed: fetch failed ??? ??? Wiki ??')).toBe(true);
    expect(metadata.description).toBe('A short useful answer.');
  });

  it('can repair bad description fields inside stored wiki markdown', () => {
    const repaired = repairWikiMarkdownDescription(
      [
        '---',
        'type: topic',
        'title: "Query Insight"',
        'description: "MiniMax failed: fetch failed ??? ??? Wiki ?? ###### 3279 / OpenAI / ????"',
        'tags: ["query-insight"]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# Query Insight',
        '',
        '## Summary',
        'A short useful answer.',
      ].join('\n'),
      { ...fallback, summary: '' },
    );

    expect(repaired).not.toBeNull();
    expect(repaired?.description).toBe('A short useful answer.');
    expect(repaired?.markdown).not.toContain('MiniMax failed');
  });

  it('strips duplicated malformed frontmatter-like blocks from older topic pages', () => {
    const metadata = buildWikiPageMetadata(
      [
        '---',
        'type: topic',
        'title: "Local First Storage"',
        'created: "2026-04-02"',
        'updated: "2026-05-09"',
        'tags: ["privacy", "storage"]',
        'sources: ["entry_1"]',
        'related: ["Digital Student"]',
        '---',
        '',
        '---',
        '',
        'type: topic',
        '',
        'title: Local First Storage',
        '',
        'created: "\\\"2026-04-02\\\""',
        '',
        'updated: "\\\"2026-05-09\\\""',
        '',
        'tags: privacy storage',
        '',
        'sources: entry_1',
        '',
        'related: Digital Student',
        '',
        'Local-First Storage keeps data on the local machine.',
        '',
        '## Architecture',
        'Body starts here.',
      ].join('\n'),
      fallback,
    );

    expect(metadata.title).toBe('Local First Storage');
    expect(metadata.description).toContain('Local-First Storage keeps data on the local machine.');
    expect(metadata.body).not.toContain('type: topic');
    expect(metadata.body).not.toContain('created:');
    expect(metadata.body).toContain('Local-First Storage keeps data on the local machine.');
  });

  it('repairs malformed topic frontmatter by rewriting a clean frontmatter block', () => {
    const repaired = repairWikiMarkdownDescription(
      [
        '---',
        'type: topic',
        'title: "Private Deployment"',
        'created: "2026-04-02"',
        'updated: "2026-05-09"',
        'tags: ["private", "open-llm"]',
        'sources: ["entry_x"]',
        'related: ["project_y"]',
        '---',
        '',
        '---',
        'type: topic',
        'title: Private Deployment',
        'created: "\\\\\\\\"2026-04-02\\\\\\\\""',
        'updated: "\\\\\\\\"2026-05-09\\\\\\\\""',
        'tags: private open-llm',
        'sources: entry_x',
        'related: project_y',
        '',
        'Private deployment uses self-hosted services with compatible APIs.',
      ].join('\n'),
      { ...fallback, title: 'Private Deployment', type: 'topic', tags: ['private', 'open-llm'], summary: '' },
    );

    expect(repaired).not.toBeNull();
    expect(repaired?.markdown).toMatch(/^---\ntype: topic/m);
    expect(repaired?.markdown).toContain('title: Private Deployment');
    expect(repaired?.markdown).not.toContain('created: "\\\\\\\\"2026-04-02\\\\\\\\""');
    expect(repaired?.markdown).not.toContain('\n---\ntype: topic\ntitle: Private Deployment');
    expect(repaired?.markdown).toContain('Private deployment uses self-hosted services with compatible APIs.');
  });

  it('strips collapsed frontmatter residue from topic descriptions and body', () => {
    const metadata = buildWikiPageMetadata(
      [
        '---',
        'type: topic',
        'title: "Local First Storage"',
        'created: "2026-04-02"',
        'updated: "2026-05-09"',
        'tags: ["privacy", "local-storage"]',
        'sources: ["entry_a"]',
        'related: ["digital-student"]',
        '---',
        '',
        '--- type: topic title: Local First Storage created: "\\\\\\\\"2026-04-02\\\\\\\\"" updated: "\\\\\\\\"2026-05-09\\\\\\\\"" tags: privacy local-storage sources: entry_a related: digital-student',
        '',
        '---',
        'type: topic',
        'title: Local First Storage',
        'created: "2026-04-02"',
        'updated: "2026-05-09"',
        'tags: privacy local-storage',
        'sources: entry_a',
        'related: digital-student',
        '',
        'Local-first storage keeps user data on the local machine by default.',
      ].join('\n'),
      fallback,
    );

    expect(metadata.description).toBe('Local-first storage keeps user data on the local machine by default.');
    expect(metadata.body).not.toContain('--- type: topic title:');
    expect(metadata.body).not.toContain('created:');
    expect(metadata.body).toContain('Local-first storage keeps user data on the local machine by default.');
  });

  it('does not cut long descriptions in the middle of a sentence', () => {
    const metadata = buildWikiPageMetadata(
      [
        '---',
        'type: project',
        'title: "Long Project"',
        'description: "福瑞健康科技园三期项目是内蒙古福瑞医疗科技股份有限公司在乌兰察布市集宁区实施的重大战略扩建工程，聚焦医疗、康养住宅、研发生产和文旅休闲五大业态，构建医康旅一体融合的综合性医疗康养产业集群。项目总投资12.03亿元，预计年均营业收入4.22亿元，税后内部收益率8.68%，2026年开工，建设周期3年，预计2029年开始运营。后续还有更长的背景介绍和运营安排。继续补充医疗板块康养住宅研发生产文旅板块财务指标市场空间投资回收风险控制合作医院健康管理服务会员权益运营节奏"',
        'tags: ["project"]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# Long Project',
      ].join('\n'),
      fallback,
    );

    expect(metadata.description).toBe(
      '福瑞健康科技园三期项目是内蒙古福瑞医疗科技股份有限公司在乌兰察布市集宁区实施的重大战略扩建工程，聚焦医疗、康养住宅、研发生产和文旅休闲五大业态，构建医康旅一体融合的综合性医疗康养产业集群。项目总投资12.03亿元，预计年均营业收入4.22亿元，税后内部收益率8.68%，2026年开工，建设周期3年，预计2029年开始运营。后续还有更长的背景介绍和运营安排。...',
    );
    expect(metadata.description).not.toMatch(/2026年开$/);
  });

  it('falls back to a sentence-aware body summary when frontmatter description is unusable', () => {
    const metadata = buildWikiPageMetadata(
      [
        '---',
        'type: entity',
        'title: "Person"',
        'description: "MiniMax failed: fetch failed"',
        'tags: ["entity"]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# Person',
        '',
        '## 摘要',
        '王冠一长期担任公司核心管理职务，是内蒙古福瑞医疗科技股份有限公司董事长兼总经理，也是公司实际控制人，长期推动公司从工业生产型向综合医药企业转型。1993年2月至1995年5月任内蒙古蒙电无损检测技术公司经理，1995年5月至1998年11月任北京福麦特副总经理，1998年起担任公司总经理，2005年起担任董事长。继续补充项目投资医疗资源整合康养运营上市公司战略规划',
      ].join('\n'),
      fallback,
    );

    expect(metadata.description).toBe(
      '王冠一长期担任公司核心管理职务，是内蒙古福瑞医疗科技股份有限公司董事长兼总经理，也是公司实际控制人，长期推动公司从工业生产型向综合医药企业转型。1993年2月至1995年5月任内蒙古蒙电无损检测技术公司经理，1995年5月至1998年11月任北京福麦特副总经理，1998年起担任公司总经理，2005年起担任董事长。...',
    );
    expect(metadata.description).not.toMatch(/1993年2月$/);
  });
});
