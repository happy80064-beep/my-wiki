import { describe, expect, it } from 'vitest';
import {
  buildCaptureAnalysisPrompt,
  buildWikiPatchPrompt,
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
});
