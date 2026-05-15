import { describe, expect, it } from 'vitest';
import { extractMetricAnswer, type EvidenceHit } from '../metrics';
import type { Entry } from '@/types';

function hit(content: string): EvidenceHit {
  const entry: Entry = {
    id: 'entry_test',
    clientId: 'test-client',
    content,
    source: 'text',
    capturedAt: 1,
    processed: false,
    derivedEntities: [],
    derivedRelationships: [],
    derivedTasks: [],
  };

  return {
    entry,
    snippet: content,
    matchedTerms: [],
    scope: 'entity-source',
    score: 1,
  };
}

describe('metric evidence extraction', () => {
  it('chooses the value nearest to the requested business line when a sentence has multiple area numbers', () => {
    const answer = extractMetricAnswer('福瑞三期文旅业态的面积是多少？', [
      hit('药材科普园还有 132 亩建设用地和文旅开发空地 685 亩（宗地三）正在整理。'),
    ]);

    expect(answer?.value).toBe('685亩');
  });

  it('does not reuse another business-line value when the requested scope has no value', () => {
    const answer = extractMetricAnswer('福瑞三期住宅业态的建筑面积是多少？', [
      hit('医疗板块：用地面积 248 亩。住宅板块暂未披露建筑面积。'),
    ]);

    expect(answer).toBeUndefined();
  });
});
