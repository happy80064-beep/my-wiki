import { describe, expect, it } from 'vitest';
import type { SigmaKnowledgeLink, SigmaKnowledgeNode } from '../SigmaKnowledgeGraph';

describe('buildSigmaGraph', () => {
  it('skips self-loop links so legacy graph data cannot crash the canvas', async () => {
    globalThis.WebGLRenderingContext ??= class WebGLRenderingContext {} as typeof WebGLRenderingContext;
    globalThis.WebGL2RenderingContext ??= class WebGL2RenderingContext {} as typeof WebGL2RenderingContext;
    const { buildSigmaGraph } = await import('../SigmaKnowledgeGraph');
    const nodes: SigmaKnowledgeNode[] = [
      {
        id: 'topic_self',
        label: 'Self Topic',
        typeLabel: 'Topic',
        color: '#155eef',
        degree: 1,
        communityId: 'community_1',
        isCommunityHub: false,
        updatedAt: 1,
      },
    ];
    const links: SigmaKnowledgeLink[] = [
      {
        id: 'rel_self',
        source: 'topic_self',
        target: 'topic_self',
        label: 'mentions',
        color: '#64748b',
        weight: 1,
        sameCommunity: true,
      },
    ];

    const graph = buildSigmaGraph(nodes, links, 'self-loop-test');

    expect(graph.order).toBe(1);
    expect(graph.size).toBe(0);
  });
});
