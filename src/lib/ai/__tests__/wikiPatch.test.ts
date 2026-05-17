import { describe, expect, it } from 'vitest';
import {
  buildCaptureAnalysisFromMarkdownPrompt,
  buildCaptureAnalysisPrompt,
  buildCaptureAnalysisStructuredOutput,
  buildCaptureDigestPrompt,
  buildCaptureMarkdownAnalysisPrompt,
  buildCaptureSourceIdentityBlock,
  buildCaptureSourceForStructuredProcessing,
  buildWikiPatchPrompt,
  normalizeCaptureAnalysisToCaptureDraft,
  normalizeCaptureAnalysis,
  normalizeWikiPatchesToCaptureDraft,
  normalizeWikiPatchResponse,
  resolveCaptureDigestThreshold,
  shouldUseCaptureDigest,
  splitCaptureContentIntoChunks,
  validateWikiPatch,
  type CaptureAnalysis,
} from '@/lib/ai/wikiPatch';
import { inferWikiTargetSpec } from '@/lib/wiki/markdownCompiler';

describe('wiki patch prompts', () => {
  it('builds two-step ingestion prompts with patch constraints', () => {
    const analysisPrompt = buildCaptureAnalysisPrompt('OpenMaic 是开源项目。', '[]');
    expect(analysisPrompt).toContain('摄入分析 Agent');
    expect(analysisPrompt).toContain('recommendedUpdates');

    const analysis: CaptureAnalysis = {
      entities: [
        {
          title: 'OpenMaic',
          type: 'topic',
          evidence: 'OpenMaic 是开源项目。',
        },
      ],
      concepts: [],
      claims: [
        {
          subject: 'OpenMaic',
          predicate: 'openSourceStatus',
          object: '开源项目',
          evidence: 'OpenMaic 是开源项目。',
          confidence: 'high',
        },
      ],
      hierarchies: [],
      indicators: [],
      contradictions: [],
      recommendedUpdates: [
        {
          targetTitle: 'OpenMaic',
          action: 'UPDATE_ENTITY_PROPERTY',
          reason: '材料明确说明它是开源项目。',
        },
      ],
    };
    const patchPrompt = buildWikiPatchPrompt('OpenMaic 是开源项目。', analysis);

    expect(patchPrompt).toContain('WikiPatch');
    expect(patchPrompt).toContain('openSourceStatus');
    expect(patchPrompt).toContain('REVIEW_REQUIRED.options');
  });

  it('builds markdown digest prompts and representative chunks for long documents', () => {
    const longContent = [
      '开头段落。'.repeat(1200),
      '\n\n## 推荐路线\n下一阶段需要完善任务规划器和风险处理。',
      '\n\n结尾段落。'.repeat(1200),
    ].join('');

    const chunks = splitCaptureContentIntoChunks(longContent, 800, 3);
    const digestPrompt = buildCaptureDigestPrompt(chunks[0] ?? '', 1, chunks.length);

    expect(shouldUseCaptureDigest(longContent, 1000)).toBe(true);
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks.join('\n')).toContain('下一阶段需要完善任务规划器和风险处理');
    expect(digestPrompt).toContain('Markdown 阅读摘要');
    expect(digestPrompt).toContain('不要输出 JSON');
  });

  it('builds reference-style markdown-first prompts before structured ingestion', () => {
    const markdownPrompt = buildCaptureMarkdownAnalysisPrompt(
      '# 导入文件：项目测算.pdf\n\n来源格式：PDF\n\n福瑞健康科技园三期项目包含医疗与健康中心。',
      '[]',
    );
    const structuredPrompt = buildCaptureAnalysisFromMarkdownPrompt({
      markdownAnalysis: '## 应入库的 Page Types\n- source：项目测算\n- project：福瑞健康科技园三期项目',
      sourceExcerpt: '福瑞健康科技园三期项目包含医疗与健康中心。',
      entityIndexJson: '[]',
    });

    expect(markdownPrompt).toContain('先把原始材料理解成 Markdown 分析文本');
    expect(markdownPrompt).toContain('不要在这一轮输出 JSON');
    expect(markdownPrompt).toContain('应入库的 Page Types');
    expect(structuredPrompt).toContain('上一轮 Markdown 分析');
    expect(structuredPrompt).toContain('"entities"');
    expect(structuredPrompt).toContain('source 页和知识对象要分开');

    const structuredOutput = buildCaptureAnalysisStructuredOutput();
    expect(structuredOutput.name).toBe('capture_analysis');
    expect(structuredOutput.schema).toMatchObject({
      type: 'object',
      properties: {
        entities: expect.any(Object),
        recommendedUpdates: expect.any(Object),
      },
    });
  });

  it('carries workspace schema Page Types into structured drafts', () => {
    const schema = [
      '# Wiki Schema',
      '',
      '## Page Types',
      '| Type | Directory | Purpose |',
      '|---|---|---|',
      '| goal | wiki/goals/ | Concrete outcomes being pursued. |',
      '| habit | wiki/habits/ | Repeatable behaviors to track. |',
      '| reflection | wiki/reflections/ | Review notes and lessons. |',
      '| source | wiki/sources/ | Source documents. |',
    ].join('\n');
    const workspaceContext = {
      purpose: 'Personal growth wiki.',
      schema,
      templateId: 'personal-growth',
    };

    const prompt = buildCaptureAnalysisFromMarkdownPrompt({
      markdownAnalysis: '## Page Types\n- goal: Run 5km habit goal',
      sourceExcerpt: 'Run 5km is the current training goal.',
      entityIndexJson: '[]',
      workspaceContext,
    });
    const analysis = normalizeCaptureAnalysis(
      JSON.stringify({
        entities: [
          {
            title: 'Run 5km',
            type: 'topic',
            pageType: 'goal',
            tags: ['fitness'],
            evidence: 'Run 5km is the current training goal.',
          },
        ],
        concepts: [],
        claims: [],
        hierarchies: [],
        indicators: [],
        contradictions: [],
        recommendedUpdates: [],
      }),
    );
    const draft = normalizeCaptureAnalysisToCaptureDraft(
      analysis,
      'Run 5km is the current training goal.',
      workspaceContext,
    );

    expect(prompt).toContain('| goal | wiki/goals/ |');
    expect(analysis.entities[0]).toMatchObject({ pageType: 'goal', tags: ['fitness'] });
    expect(draft.primaryEntity.tags).toEqual(expect.arrayContaining(['goal', 'fitness']));
    expect(
      inferWikiTargetSpec(
        {
          id: draft.primaryEntity.clientId,
          type: draft.primaryEntity.type,
          title: draft.primaryEntity.title,
          tags: draft.primaryEntity.tags,
        },
        { schema },
      ),
    ).toMatchObject({ type: 'goal', path: 'wiki/goals/run-5km.md' });
  });

  it('materializes recommended updates as knowledge entities when the model omits entities', () => {
    const analysis = normalizeCaptureAnalysis(
      JSON.stringify({
        entities: [],
        concepts: [],
        claims: [],
        hierarchies: [],
        indicators: [],
        contradictions: [],
        recommendedUpdates: [
          {
            targetTitle: '福瑞健康科技园三期项目',
            action: 'CREATE_ENTITY',
            reason: '材料围绕福瑞健康科技园三期项目可研报告展开。',
          },
        ],
      }),
    );
    const draft = normalizeCaptureAnalysisToCaptureDraft(
      analysis,
      '# 导入文件：福瑞健康科技园三期项目可研报告.pdf\n\n来源格式：PDF\n\n福瑞健康科技园三期项目可行性研究报告。',
    );
    const entities = [draft.primaryEntity, ...draft.relatedEntities];

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '福瑞健康科技园三期项目可研报告', tags: expect.arrayContaining(['source']) }),
        expect.objectContaining({ title: '福瑞健康科技园三期项目', type: 'project', tags: expect.arrayContaining(['project']) }),
      ]),
    );
  });

  it('derives one evidence-based knowledge entity from imported content when structured output only identifies the source', () => {
    const analysis = normalizeCaptureAnalysis(
      JSON.stringify({
        entities: [],
        concepts: [],
        claims: [],
        hierarchies: [],
        indicators: [],
        contradictions: [],
        recommendedUpdates: [],
      }),
    );
    const draft = normalizeCaptureAnalysisToCaptureDraft(
      analysis,
      '# 导入文件：long-pdf-regression.pdf\n\n来源格式：PDF\n\nLong PDF Regression Knowledge Platform 2026\n\nThe platform plan tracks model routing and audit workflows.',
    );
    const entities = [draft.primaryEntity, ...draft.relatedEntities];

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'long-pdf-regression', tags: expect.arrayContaining(['source']) }),
        expect.objectContaining({ title: 'Long PDF Regression Knowledge Platform 2026', type: 'topic' }),
      ]),
    );
  });

  it('keeps the reference-project style 50k source window before long document digesting', () => {
    const content = `${'a'.repeat(50000)}TAIL_SHOULD_NOT_ENTER_STRUCTURED_CAPTURE`;
    const bounded = buildCaptureSourceForStructuredProcessing(content);
    const chunks = splitCaptureContentIntoChunks(bounded);

    expect(bounded).toContain('[...truncated to 50000 characters before structured capture');
    expect(bounded.length).toBeLessThanOrEqual(50000);
    expect(bounded).not.toContain('TAIL_SHOULD_NOT_ENTER_STRUCTURED_CAPTURE');
    expect(chunks.join('\n')).toContain('aaaa');
    expect(chunks.length).toBeLessThanOrEqual(5);
  });

  it('preserves imported source identity for long document markdown summaries', () => {
    const content = [
      '# 导入文件：long-pdf-regression.pdf',
      '',
      '来源格式：PDF',
      '文件大小：12345 bytes',
      '',
      'Long PDF Regression Knowledge Platform 2026',
    ].join('\n');

    expect(buildCaptureSourceIdentityBlock(content)).toContain('# 导入文件：long-pdf-regression.pdf');
    expect(buildCaptureSourceIdentityBlock(content)).toContain('来源格式：PDF');
  });

  it('uses the configured context window before falling back to markdown digesting', () => {
    const structuredContent = 'a'.repeat(50000);
    const miniMaxConfiguredWindow = 200000;

    expect(resolveCaptureDigestThreshold(miniMaxConfiguredWindow)).toBe(50000);
    expect(shouldUseCaptureDigest(structuredContent, resolveCaptureDigestThreshold(miniMaxConfiguredWindow))).toBe(false);
    expect(shouldUseCaptureDigest(structuredContent, resolveCaptureDigestThreshold(8000))).toBe(true);
  });

  it('validates property whitelist and review options', () => {
    expect(
      validateWikiPatch({
        type: 'UPDATE_ENTITY_PROPERTY',
        entityTitle: 'OpenMaic',
        propertyKey: 'openSourceStatus',
        propertyValue: '开源项目',
        evidence: 'OpenMaic 是开源项目。',
        confidence: 0.9,
      }),
    ).toBe(true);

    expect(
      validateWikiPatch({
        type: 'UPDATE_ENTITY_PROPERTY',
        entityTitle: 'OpenMaic',
        propertyKey: 'unsafePath',
        propertyValue: '../../../secret',
        evidence: '恶意材料。',
        confidence: 0.9,
      }),
    ).toBe(false);
  });

  it('normalizes two-step WikiPatch output into a capture draft with compile suggestions', () => {
    const analysis = normalizeCaptureAnalysis(
      JSON.stringify({
        entities: [
          {
            title: 'OpenMaic',
            type: 'topic',
            evidence: 'OpenMaic 是开源项目。',
            existsLikely: true,
          },
        ],
        concepts: [],
        claims: [
          {
            subject: 'OpenMaic',
            predicate: 'openSourceStatus',
            object: '开源项目',
            evidence: 'OpenMaic 是开源项目。',
            confidence: 'high',
          },
        ],
        contradictions: [],
        recommendedUpdates: [],
      }),
    );

    expect(analysis.claims[0]?.predicate).toBe('openSourceStatus');

    const patches = normalizeWikiPatchResponse(
      JSON.stringify({
        patches: [
          {
            type: 'UPDATE_ENTITY_PROPERTY',
            entityTitle: 'OpenMaic',
            propertyKey: 'openSourceStatus',
            propertyValue: '开源项目',
            evidence: 'OpenMaic 是开源项目。',
            confidence: 0.9,
          },
          {
            type: 'CREATE_TASK',
            description: '整理 OpenMaic 项目资料',
            ownerTitle: '我',
            linkedToTitles: ['OpenMaic'],
            status: 'pending',
            evidence: '后续需要整理 OpenMaic 项目资料。',
          },
        ],
      }),
    );
    const draft = normalizeWikiPatchesToCaptureDraft(patches, 'OpenMaic 是开源项目。后续需要整理 OpenMaic 项目资料。');

    expect(draft.primaryEntity.title).toBe('OpenMaic');
    expect(draft.compileSuggestions?.[0]).toEqual(
      expect.objectContaining({
        entityTitle: 'OpenMaic',
        propertyKey: 'openSourceStatus',
        propertyValue: '开源项目',
      }),
    );
    expect(draft.tasks[0]?.description).toBe('整理 OpenMaic 项目资料');
  });

  it('falls back from analysis into source, project and concept draft pages for imported files', () => {
    const analysis: CaptureAnalysis = {
      entities: [
        {
          title: '福瑞健康科技园三期项目',
          type: 'project',
          evidence: '福瑞健康科技园三期项目可研报告。',
        },
      ],
      concepts: [
        {
          title: '医疗业态',
          evidence: '医疗业态包含抗衰专病门诊、细胞治疗服务中心。',
        },
      ],
      claims: [
        {
          subject: '福瑞健康科技园三期项目',
          predicate: 'ownerNote',
          object: '需要补充运营主体',
          evidence: '运营主体待补充。',
          confidence: 'medium',
        },
      ],
      hierarchies: [],
      indicators: [
        {
          entityTitle: '福瑞健康科技园三期项目',
          name: '总投资',
          value: null,
          rawValue: '未明确披露',
          unit: '万元',
          evidence: '总投资未明确披露。',
          confidence: 'low',
          note: '原文未提供明确数值',
        },
      ],
      contradictions: [],
      recommendedUpdates: [
        {
          targetTitle: '福瑞健康科技园三期项目可研报告',
          action: 'CREATE_ENTITY',
          reason: '需要建立来源页。',
        },
      ],
    };

    const draft = normalizeCaptureAnalysisToCaptureDraft(
      analysis,
      '# 导入文件：福瑞健康科技园三期项目可研报告.pdf\n\n来源格式：PDF\n\n福瑞健康科技园三期项目可研报告。\n医疗业态包含抗衰专病门诊、细胞治疗服务中心。',
    );
    const entities = [draft.primaryEntity, ...draft.relatedEntities];

    expect(draft.primaryEntity).toMatchObject({
      type: 'project',
      title: '福瑞健康科技园三期项目',
    });
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '福瑞健康科技园三期项目可研报告', tags: expect.arrayContaining(['source']) }),
        expect.objectContaining({ title: '医疗业态', tags: expect.arrayContaining(['concept']) }),
      ]),
    );
    expect(draft.relationships.some((relationship) => relationship.type === 'mentions')).toBe(true);
    expect(draft.compileSuggestions?.[0]).toMatchObject({
      entityTitle: '福瑞健康科技园三期项目',
      propertyKey: 'ownerNote',
    });
    expect(
      entities.some(
        (entity) =>
          entity.title === '福瑞健康科技园三期项目可研报告' &&
          inferWikiTargetSpec({ id: entity.clientId, type: entity.type, title: entity.title, tags: entity.tags }).type === 'source',
      ),
    ).toBe(true);
  });

  it('adds a source page entity when WikiPatch succeeds for an imported file', () => {
    const patches = normalizeWikiPatchResponse(
      JSON.stringify({
        patches: [
          {
            type: 'CREATE_ENTITY',
            title: '福瑞健康科技园三期项目',
            entityType: 'project',
            summary: '可研报告中的长期项目。',
            tags: ['项目'],
            scenes: ['work'],
            evidence: '福瑞健康科技园三期项目可研报告。',
          },
        ],
      }),
    );

    const draft = normalizeWikiPatchesToCaptureDraft(
      patches,
      '# 导入文件：福瑞健康科技园三期项目可研报告.pdf\n\n来源格式：PDF\n\n福瑞健康科技园三期项目可研报告。',
    );
    const entities = [draft.primaryEntity, ...draft.relatedEntities];

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '福瑞健康科技园三期项目', type: 'project' }),
        expect.objectContaining({ title: '福瑞健康科技园三期项目可研报告', tags: expect.arrayContaining(['source']) }),
      ]),
    );
  });

  it('repairs common missing-comma JSON returned by LLM patch calls', () => {
    const patches = normalizeWikiPatchResponse(`{
      "patches": [
        {
          "type": "CREATE_ENTITY",
          "title": "福瑞三期项目",
          "entityType": "project",
          "summary": "项目可研报告。",
          "tags": ["项目"]
          "scenes": ["work"],
          "evidence": "福瑞三期项目可研报告"
        }
        {
          "type": "CREATE_RELATIONSHIP",
          "fromTitle": "福瑞三期项目",
          "toTitle": "产业投资基金",
          "relationshipType": "related-to",
          "evidence": "产业投资基金组建及项目实施方案",
          "confidence": 0.8
        }
      ]
    }`);

    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ type: 'CREATE_ENTITY', title: '福瑞三期项目' });
    expect(patches[1]).toMatchObject({ type: 'CREATE_RELATIONSHIP', fromTitle: '福瑞三期项目' });
  });

  it('repairs missing commas between array string values returned by LLM patch calls', () => {
    const patches = normalizeWikiPatchResponse(`{
      "patches": [
        {
          "type": "CREATE_ENTITY",
          "title": "福瑞健康科技园三期项目",
          "entityType": "project",
          "summary": "可研报告核心项目。",
          "tags": ["project" "项目" "可研"]
          "scenes": ["work"],
          "evidence": "福瑞健康科技园三期项目可研报告"
        },
        {
          "type": "REVIEW_REQUIRED",
          "title": "住宅业态指标",
          "reason": "需要核对住宅板块建筑面积。",
          "evidence": "住宅业态章节",
          "options": ["Create Page" "Update Existing" "Skip"]
        }
      ]
    }`);

    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ type: 'CREATE_ENTITY', tags: ['project', '项目', '可研'] });
    expect(patches[1]).toMatchObject({ type: 'REVIEW_REQUIRED', options: ['Create Page', 'Update Existing', 'Skip'] });
  });

  it('repairs Chinese punctuation used as JSON separators', () => {
    const patches = normalizeWikiPatchResponse(`{
      "patches"： [
        {
          "type": "CREATE_ENTITY"，
          "title": "福瑞健康科技园三期项目"，
          "entityType": "project"，
          "summary": "可研报告核心项目。"，
          "tags": ["project"、 "项目"、 "可研"]，
          "scenes": ["work"]，
          "evidence": "福瑞健康科技园三期项目可研报告"
        }
      ]
    }`);

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ type: 'CREATE_ENTITY', tags: ['project', '项目', '可研'] });
  });

  it('uses the last valid JSON candidate when the model emits extra JSON-like objects', () => {
    const patches = normalizeWikiPatchResponse(`{"note": "draft object"}
    下面才是最终结果：
    {
      "patches": [
        {
          "type": "CREATE_ENTITY",
          "title": "福瑞三期项目",
          "entityType": "project",
          "summary": "项目可研报告。",
          "tags": ["项目"、"可研"],
          "scenes": ["work"],
          "evidence": "福瑞三期项目可研报告"
        }
      ]
    }`);

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ type: 'CREATE_ENTITY', title: '福瑞三期项目' });
  });
});
