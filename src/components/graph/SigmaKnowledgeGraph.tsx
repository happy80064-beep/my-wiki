import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NodeCircleProgram } from 'sigma/rendering';

export type SigmaKnowledgeNode = {
  id: string;
  label: string;
  typeLabel: string;
  color: string;
  degree: number;
  communityId: string;
  isCommunityHub: boolean;
  updatedAt: number;
};

export type SigmaKnowledgeLink = {
  id: string;
  source: string;
  target: string;
  label: string;
  color: string;
  weight: number;
  sameCommunity: boolean;
};

type SigmaKnowledgeGraphProps = {
  nodes: SigmaKnowledgeNode[];
  links: SigmaKnowledgeLink[];
  highlightedNodeIds?: Set<string>;
  highlightedRelationshipIds: Set<string>;
  layoutKey: string;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onHoverNode: (nodeId: string | null) => void;
  onOpenNode: (nodeId: string) => void;
};

const positionCache = new Map<string, { x: number; y: number }>();
let lastLayoutKey = '';

export function SigmaKnowledgeGraph(props: SigmaKnowledgeGraphProps) {
  const [webglReady, setWebglReady] = useState<boolean | null>(null);
  const sigmaSettings = useMemo(
    () => ({
      allowInvalidContainer: true,
      defaultEdgeColor: '#cbd5e1',
      defaultNodeColor: '#94a3b8',
      defaultNodeType: 'circle',
      enableEdgeEvents: false,
      labelColor: { color: '#1f2937' },
      labelDensity: 0.34,
      labelGridCellSize: 90,
      labelRenderedSizeThreshold: 7,
      labelSize: 12,
      labelWeight: '700',
      nodeProgramClasses: { circle: NodeCircleProgram },
      renderEdgeLabels: false,
      stagePadding: 42,
      zIndex: true,
      nodeReducer: (_node: string, attrs: Record<string, unknown>) => {
        const result: Record<string, unknown> = { ...attrs };
        const baseSize = Number(attrs.size ?? 8);
        if (attrs.insightDimmed || attrs.hoverDimmed) {
          result.color = mixColor(String(attrs.color ?? '#94a3b8'), '#eef2f7', 0.72);
          result.label = '';
          result.size = Math.max(3.5, baseSize * 0.58);
        }
        if (attrs.insightHighlight || attrs.hovering) {
          result.size = baseSize * 1.42;
          result.forceLabel = true;
          result.zIndex = 10;
        }
        return result;
      },
      edgeReducer: (_edge: string, attrs: Record<string, unknown>) => {
        const result: Record<string, unknown> = { ...attrs };
        const baseSize = Number(attrs.size ?? 1);
        if (attrs.insightDimmed || attrs.hoverDimmed) {
          result.color = '#e7edf4';
          result.size = 0.28;
        }
        if (attrs.insightHighlight || attrs.hoverHighlight) {
          result.color = attrs.highlightColor ?? '#155eef';
          result.size = Math.max(2.2, baseSize * 1.7);
        }
        return result;
      },
    }),
    [],
  );

  useEffect(() => {
    setWebglReady(hasWebGLSupport());
  }, []);

  if (webglReady === null) return <GraphCanvasFallback>图谱画布加载中...</GraphCanvasFallback>;
  if (!webglReady) return <GraphCanvasFallback>当前环境不支持 WebGL 图谱画布。</GraphCanvasFallback>;

  return (
    <SigmaCanvasErrorBoundary>
      <SigmaContainer
        className="mywiki-sigma-graph h-full min-h-[360px] w-full"
        settings={sigmaSettings}
      >
        <SigmaGraphLoader nodes={props.nodes} links={props.links} layoutKey={props.layoutKey} />
        <SigmaGraphEvents onHoverNode={props.onHoverNode} onOpenNode={props.onOpenNode} />
        <SigmaHighlightManager
          highlightedNodeIds={props.highlightedNodeIds}
          highlightedRelationshipIds={props.highlightedRelationshipIds}
        />
        <SigmaCameraBridge layoutKey={props.layoutKey} zoom={props.zoom} onZoomChange={props.onZoomChange} />
      </SigmaContainer>
    </SigmaCanvasErrorBoundary>
  );
}

function SigmaGraphLoader({
  nodes,
  links,
  layoutKey,
}: {
  nodes: SigmaKnowledgeNode[];
  links: SigmaKnowledgeLink[];
  layoutKey: string;
}) {
  const loadGraph = useLoadGraph();
  const graph = useMemo(() => buildSigmaGraph(nodes, links, layoutKey), [nodes, links, layoutKey]);

  useEffect(() => {
    loadGraph(graph);
  }, [graph, loadGraph]);

  return null;
}

function SigmaGraphEvents({
  onHoverNode,
  onOpenNode,
}: {
  onHoverNode: (nodeId: string | null) => void;
  onOpenNode: (nodeId: string) => void;
}) {
  const registerEvents = useRegisterEvents();
  const sigma = useSigma();

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => onOpenNode(node),
      enterNode: ({ node }) => {
        onHoverNode(node);
        sigma.getContainer().style.cursor = 'pointer';
        const graph = sigma.getGraph();
        const neighbors = new Set(graph.neighbors(node));
        neighbors.add(node);
        graph.forEachNode((nodeId) => {
          if (nodeId === node) graph.setNodeAttribute(nodeId, 'hovering', true);
          if (!neighbors.has(nodeId)) graph.setNodeAttribute(nodeId, 'hoverDimmed', true);
        });
        graph.forEachEdge((edgeId, _attrs, source, target) => {
          if (source === node || target === node) {
            graph.setEdgeAttribute(edgeId, 'hoverHighlight', true);
          } else {
            graph.setEdgeAttribute(edgeId, 'hoverDimmed', true);
          }
        });
        sigma.refresh();
      },
      leaveNode: () => {
        onHoverNode(null);
        sigma.getContainer().style.cursor = 'default';
        const graph = sigma.getGraph();
        graph.forEachNode((nodeId) => {
          graph.removeNodeAttribute(nodeId, 'hovering');
          graph.removeNodeAttribute(nodeId, 'hoverDimmed');
        });
        graph.forEachEdge((edgeId) => {
          graph.removeEdgeAttribute(edgeId, 'hoverHighlight');
          graph.removeEdgeAttribute(edgeId, 'hoverDimmed');
        });
        sigma.refresh();
      },
    });
  }, [onHoverNode, onOpenNode, registerEvents, sigma]);

  return null;
}

function SigmaHighlightManager({
  highlightedNodeIds,
  highlightedRelationshipIds,
}: {
  highlightedNodeIds?: Set<string>;
  highlightedRelationshipIds: Set<string>;
}) {
  const sigma = useSigma();

  useEffect(() => {
    const graph = sigma.getGraph();
    if (!highlightedNodeIds) {
      graph.forEachNode((nodeId) => {
        graph.removeNodeAttribute(nodeId, 'insightHighlight');
        graph.removeNodeAttribute(nodeId, 'insightDimmed');
      });
      graph.forEachEdge((edgeId) => {
        graph.removeEdgeAttribute(edgeId, 'insightHighlight');
        graph.removeEdgeAttribute(edgeId, 'insightDimmed');
      });
      sigma.refresh();
      return;
    }

    graph.forEachNode((nodeId) => {
      if (highlightedNodeIds.has(nodeId)) {
        graph.setNodeAttribute(nodeId, 'insightHighlight', true);
        graph.removeNodeAttribute(nodeId, 'insightDimmed');
      } else {
        graph.setNodeAttribute(nodeId, 'insightDimmed', true);
        graph.removeNodeAttribute(nodeId, 'insightHighlight');
      }
    });
    graph.forEachEdge((edgeId, _attrs, source, target) => {
      if (highlightedRelationshipIds.has(edgeId) || (highlightedNodeIds.has(source) && highlightedNodeIds.has(target))) {
        graph.setEdgeAttribute(edgeId, 'insightHighlight', true);
        graph.removeEdgeAttribute(edgeId, 'insightDimmed');
      } else {
        graph.setEdgeAttribute(edgeId, 'insightDimmed', true);
        graph.removeEdgeAttribute(edgeId, 'insightHighlight');
      }
    });
    sigma.refresh();
  }, [highlightedNodeIds, highlightedRelationshipIds, sigma]);

  return null;
}

function SigmaCameraBridge({
  layoutKey,
  zoom,
  onZoomChange,
}: {
  layoutKey: string;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}) {
  const sigma = useSigma();
  const applyingExternalZoom = useRef(false);
  const externalZoomTimeoutRef = useRef<number | null>(null);
  const cameraZoomFrameRef = useRef<number | null>(null);
  const lastReportedZoomRef = useRef(zoom);

  useEffect(() => {
    lastReportedZoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    applyingExternalZoom.current = true;
    sigma.getCamera().animatedReset({ duration: 260 });
    if (externalZoomTimeoutRef.current !== null) window.clearTimeout(externalZoomTimeoutRef.current);
    externalZoomTimeoutRef.current = window.setTimeout(() => {
      applyingExternalZoom.current = false;
      externalZoomTimeoutRef.current = null;
    }, 320);
  }, [layoutKey, sigma]);

  useEffect(() => {
    const camera = sigma.getCamera();
    const targetRatio = clamp(1 / zoom, 0.36, 1.85);
    const currentRatio = camera.getState().ratio;
    if (Math.abs(currentRatio - targetRatio) < 0.025) return;

    applyingExternalZoom.current = true;
    camera.animate({ ratio: targetRatio }, { duration: 180 });
    if (externalZoomTimeoutRef.current !== null) window.clearTimeout(externalZoomTimeoutRef.current);
    externalZoomTimeoutRef.current = window.setTimeout(() => {
      applyingExternalZoom.current = false;
      externalZoomTimeoutRef.current = null;
    }, 210);
  }, [sigma, zoom]);

  useEffect(() => {
    const camera = sigma.getCamera();
    const handleCameraUpdate = () => {
      if (applyingExternalZoom.current) return;
      if (cameraZoomFrameRef.current !== null) return;
      cameraZoomFrameRef.current = window.requestAnimationFrame(() => {
        cameraZoomFrameRef.current = null;
        const nextZoom = clamp(1 / camera.getState().ratio, 0.62, 1.95);
        if (Math.abs(nextZoom - lastReportedZoomRef.current) < 0.035) return;
        lastReportedZoomRef.current = nextZoom;
        onZoomChange(nextZoom);
      });
    };
    camera.on('updated', handleCameraUpdate);
    return () => {
      camera.off('updated', handleCameraUpdate);
      if (cameraZoomFrameRef.current !== null) {
        window.cancelAnimationFrame(cameraZoomFrameRef.current);
        cameraZoomFrameRef.current = null;
      }
      if (externalZoomTimeoutRef.current !== null) {
        window.clearTimeout(externalZoomTimeoutRef.current);
        externalZoomTimeoutRef.current = null;
      }
    };
  }, [onZoomChange, sigma]);

  return null;
}

export function buildSigmaGraph(nodes: SigmaKnowledgeNode[], links: SigmaKnowledgeLink[], layoutKey: string) {
  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  const dataKey = `${layoutKey}:${nodes.map((node) => node.id).sort().join('|')}:${links
    .map((link) => `${link.source}>${link.target}`)
    .sort()
    .join('|')}`;
  const needsLayout = dataKey !== lastLayoutKey;
  const maxDegree = Math.max(...nodes.map((node) => node.degree), 1);

  for (const node of nodes) {
    const cached = !needsLayout ? positionCache.get(node.id) : undefined;
    const seeded = seededPosition(node.id, layoutKey);
    graph.addNode(node.id, {
      x: cached?.x ?? seeded.x,
      y: cached?.y ?? seeded.y,
      size: sigmaNodeSize(node.degree, maxDegree, node.isCommunityHub),
      color: node.color,
      label: shortGraphLabel(node.label, node.isCommunityHub ? 22 : 18),
      fullLabel: node.label,
      nodeTypeLabel: node.typeLabel,
      communityId: node.communityId,
      degree: node.degree,
      zIndex: node.isCommunityHub ? 4 : 1,
      forceLabel: node.isCommunityHub || node.degree >= 5,
    });
  }

  const seenPairs = new Set<string>();
  const maxWeight = Math.max(...links.map((link) => link.weight), 1);
  for (const link of links) {
    if (link.source === link.target) continue;
    if (!graph.hasNode(link.source) || !graph.hasNode(link.target)) continue;
    const pair = link.source < link.target ? `${link.source}:::${link.target}` : `${link.target}:::${link.source}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const normalizedWeight = Math.max(0.15, link.weight / maxWeight);
    graph.addEdgeWithKey(link.id, link.source, link.target, {
      color: withAlpha(link.color, link.sameCommunity ? 0.34 : 0.26),
      highlightColor: link.sameCommunity ? link.color : '#155eef',
      label: link.label,
      size: link.sameCommunity ? 0.65 + normalizedWeight * 2.3 : 0.45 + normalizedWeight * 1.4,
      weight: Math.max(0.2, link.weight),
    });
  }

  if (needsLayout && nodes.length > 1) {
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, {
      iterations: nodes.length > 80 ? 260 : 190,
      settings: {
        ...settings,
        adjustSizes: true,
        barnesHutOptimize: nodes.length > 48,
        edgeWeightInfluence: 0.7,
        gravity: nodes.length > 80 ? 0.38 : 0.5,
        linLogMode: false,
        outboundAttractionDistribution: true,
        scalingRatio: nodes.length > 80 ? 8.2 : 6.4,
        slowDown: 1.4,
        strongGravityMode: false,
      },
    });
    lastLayoutKey = dataKey;
    graph.forEachNode((nodeId, attrs) => {
      positionCache.set(nodeId, { x: Number(attrs.x), y: Number(attrs.y) });
    });
  }

  return graph;
}

function hasWebGLSupport() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function seededPosition(id: string, layoutKey: string) {
  const hash = hashCode(`${layoutKey}:${id}`);
  const angle = ((hash % 3600) / 3600) * Math.PI * 2;
  const radius = 18 + ((hash >> 3) % 46);
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

function sigmaNodeSize(degree: number, maxDegree: number, isCommunityHub: boolean) {
  const ratio = maxDegree <= 0 ? 0 : degree / maxDegree;
  return clamp(7 + Math.sqrt(ratio) * 17 + (isCommunityHub ? 4 : 0), 7, 29);
}

function shortGraphLabel(label: string, maxLength: number) {
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}...` : label;
}

function withAlpha(hex: string, alpha: number) {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  if (normalized.length !== 6) return hex;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixColor(color1: string, color2: string, ratio: number) {
  const left = parseHexColor(color1) ?? parseHexColor('#94a3b8')!;
  const right = parseHexColor(color2) ?? parseHexColor('#eef2f7')!;
  const r = Math.round(left.r + (right.r - left.r) * ratio);
  const g = Math.round(left.g + (right.g - left.g) * ratio);
  const b = Math.round(left.b + (right.b - left.b) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

function parseHexColor(color: string) {
  const normalized = color.startsWith('#') ? color.slice(1) : color;
  if (normalized.length !== 6) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function hashCode(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function GraphCanvasFallback({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[360px] items-center justify-center bg-[#f4f7fb] px-6 text-center text-sm text-[#626965]">
      {children}
    </div>
  );
}

class SigmaCanvasErrorBoundary extends React.Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <GraphCanvasFallback>图谱画布暂不可用，请稍后重试。</GraphCanvasFallback>;
    }
    return this.props.children;
  }
}
