import { describe, expect, it } from 'vitest';
import {
  buildCaptureAnalysisPrompt,
  buildCaptureDigestPrompt,
  buildWikiPatchPrompt,
  normalizeCaptureAnalysis,
  normalizeWikiPatchesToCaptureDraft,
  normalizeWikiPatchResponse,
  shouldUseCaptureDigest,
  splitCaptureContentIntoChunks,
  validateWikiPatch,
  type CaptureAnalysis,
} from '@/lib/ai/wikiPatch';

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
});
