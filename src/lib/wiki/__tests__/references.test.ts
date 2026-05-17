import { describe, expect, it } from 'vitest';
import { normalizeWikiReferenceValue, unwrapWikiReference } from '../references';

describe('wiki reference helpers', () => {
  it('unwraps related values that were written as wikilinks', () => {
    expect(normalizeWikiReferenceValue('[[concepts/运营经理]]')).toBe('concepts/运营经理');
    expect(normalizeWikiReferenceValue('[[entities/company|公司]]')).toBe('entities/company');
  });

  it('tolerates over-wrapped references from nested wikilink rendering', () => {
    expect(normalizeWikiReferenceValue('[[[concepts/2026年5月1日]]]')).toBe('concepts/2026年5月1日');
  });

  it('keeps a display label for UI chips when an alias is present', () => {
    expect(unwrapWikiReference('[[concepts/运营经理|运营经理]]')).toEqual({
      target: 'concepts/运营经理',
      label: '运营经理',
    });
  });
});
