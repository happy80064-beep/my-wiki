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

  it('spreads dense communities and limits forced labels in large graphs', async () => {
    globalThis.WebGLRenderingContext ??= class WebGLRenderingContext {} as typeof WebGLRenderingContext;
    globalThis.WebGL2RenderingContext ??= class WebGL2RenderingContext {} as typeof WebGL2RenderingContext;
    const { buildSigmaGraph } = await import('../SigmaKnowledgeGraph');
    const nodes: SigmaKnowledgeNode[] = Array.from({ length: 96 }, (_, index) => {
      const communityIndex = index % 4;
      const isCommunityHub = index < 4;
      return {
        id: `node_${index}`,
        label: `Node ${index}`,
        typeLabel: 'Topic',
        color: ['#155eef', '#16a34a', '#f97316', '#a855f7'][communityIndex],
        degree: isCommunityHub ? 24 : 2 + (index % 7),
        communityId: `community_${communityIndex}`,
        isCommunityHub,
        updatedAt: index,
      };
    });
    const links: SigmaKnowledgeLink[] = [];
    for (let index = 4; index < nodes.length; index += 1) {
      const communityIndex = index % 4;
      links.push({
        id: `hub_${index}`,
        source: `node_${communityIndex}`,
        target: `node_${index}`,
        label: 'related',
        color: nodes[index].color,
        weight: 1,
        sameCommunity: true,
      });
      if (index + 4 < nodes.length) {
        links.push({
          id: `chain_${index}`,
          source: `node_${index}`,
          target: `node_${index + 4}`,
          label: 'related',
          color: nodes[index].color,
          weight: 0.5,
          sameCommunity: true,
        });
      }
    }

    const graph = buildSigmaGraph(nodes, links, 'dense-community-test');
    const centroids = new Map<string, { x: number; y: number; count: number }>();
    graph.forEachNode((nodeId, attrs) => {
      const communityId = String(attrs.communityId);
      const current = centroids.get(communityId) ?? { x: 0, y: 0, count: 0 };
      centroids.set(communityId, {
        x: current.x + Number(attrs.x),
        y: current.y + Number(attrs.y),
        count: current.count + 1,
      });
    });
    const centers = Array.from(centroids.values()).map((centroid) => ({
      x: centroid.x / centroid.count,
      y: centroid.y / centroid.count,
    }));
    const closestCommunityDistance = centers.reduce((closest, center, index) => {
      for (let nextIndex = index + 1; nextIndex < centers.length; nextIndex += 1) {
        const other = centers[nextIndex];
        closest = Math.min(closest, Math.hypot(center.x - other.x, center.y - other.y));
      }
      return closest;
    }, Number.POSITIVE_INFINITY);
    const forcedLabelCount = graph
      .nodes()
      .filter((nodeId) => Boolean(graph.getNodeAttribute(nodeId, 'forceLabel'))).length;

    expect(closestCommunityDistance).toBeGreaterThan(260);
    expect(forcedLabelCount).toBeLessThan(nodes.length / 4);
  });
});
