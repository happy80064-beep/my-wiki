import {
  Activity,
  AlertTriangle,
  GitBranch,
  Map as MapIcon,
  Maximize2,
  Minus,
  Minimize2,
  Network,
  Plus,
  Radar,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLiveQuery } from '@/lib/db/liveQuery';
import { Link, useNavigate } from 'react-router';
import * as THREE from 'three';
import {
  buildGraphOverview,
  detectEntityLouvainCommunities,
  relationshipTypeLabel,
  type EntityLouvainCommunity,
  type GraphInsight,
} from '@/lib/graph';
import { db, getClientId } from '@/lib/db';
import { ResearchPanel } from '@/components/research/ResearchPanel';
import { useResearchStore } from '@/lib/research/store';
import type { Entity, EntityType, Relationship } from '@/types';

type SceneNode = {
  entity: Entity;
  x: number;
  y: number;
  z: number;
  degree: number;
  communityId: string;
  communityRank: number;
  communityWeight: number;
  isCommunityHub: boolean;
  phase: number;
  drift: number;
};

type LayoutNode = SceneNode & {
  vx: number;
  vy: number;
};

type SceneLink = {
  relationship: Relationship;
  from: SceneNode;
  to: SceneNode;
  weight: number;
  sameCommunity: boolean;
};

type GraphCommunity = {
  id: string;
  hubId: string;
  title: string;
  type: EntityType;
  x: number;
  y: number;
  z: number;
  radius: number;
  nodeCount: number;
  cohesion: number;
  topNodeIds: string[];
};

type GraphScene = {
  nodes: SceneNode[];
  links: SceneLink[];
  communities: GraphCommunity[];
};

type ProjectedNode = {
  node: SceneNode;
  x: number;
  y: number;
  radius: number;
  scale: number;
  depth: number;
  opacity: number;
};

type ProjectedLink = {
  relationship: Relationship;
  from: ProjectedNode;
  to: ProjectedNode;
  weight: number;
  sameCommunity: boolean;
  crossCommunity: boolean;
  opacity: number;
};

type ProjectedCommunity = GraphCommunity & {
  projectedX: number;
  projectedY: number;
  projectedRadius: number;
  opacity: number;
};

type ProjectedScene = {
  nodes: ProjectedNode[];
  links: ProjectedLink[];
  communities: ProjectedCommunity[];
  visibleLabelIds: Set<string>;
};

type NodeOverride = {
  x: number;
  y: number;
  z: number;
};

type Rotation = {
  x: number;
  y: number;
};

type GraphOffset = {
  x: number;
  y: number;
};

type GraphViewMode = 'map' | 'space';
type GraphColorMode = 'community' | 'type';

type DragState =
  | {
      mode: 'rotate';
      pointerId: number;
      startX: number;
      startY: number;
      rotation: Rotation;
    }
  | {
      mode: 'pan';
      pointerId: number;
      startPoint: { x: number; y: number };
      offset: GraphOffset;
    }
  | {
      mode: 'node';
      pointerId: number;
      nodeId: string;
      lastPoint: { x: number; y: number };
    };

type GraphLegendItem = {
  id: string;
  label: string;
  color: string;
  count: number;
};

const entityTypes: EntityType[] = ['project', 'topic', 'person', 'event'];

const entityTypeLabels: Record<EntityType, string> = {
  person: '人物',
  project: '事项',
  event: '互动',
  topic: '主题',
};

const nodeColors: Record<EntityType, string> = {
  person: '#16a34a',
  project: '#2563eb',
  event: '#64748b',
  topic: '#d9a400',
};

const communityPalette = [
  '#3b82f6',
  '#22c55e',
  '#f97316',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#ec4899',
  '#6366f1',
  '#06b6d4',
  '#84cc16',
  '#f59e0b',
  '#10b981',
  '#64748b',
];

const insightTypeLabels = {
  'bridge-node': '桥接',
  'knowledge-gap': '空白',
  'surprising-link': '连接',
  'sparse-community': '低凝聚',
  'dense-hub': '高密',
} as const;

const insightReasonLabels: Record<GraphInsight['type'], string> = {
  'bridge-node': '连接多个社群，适合作为追问入口',
  'knowledge-gap': '来源或关系偏少，需要补证据',
  'surprising-link': '跨类型或跨社群，适合核对上下文',
  'sparse-community': '同一社群内部连接弱，建议补交叉引用',
  'dense-hub': '连接密集，可作为主题索引',
};

const GRAPH_WIDTH = 1900;
const GRAPH_HEIGHT = 1180;
const flatRotation: Rotation = { x: 0, y: 0 };
const spaceRotation: Rotation = { x: -0.38, y: 0.44 };

export function GraphPage() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodeWasDraggedRef = useRef(false);
  const navigate = useNavigate();
  const [layoutSalt, setLayoutSalt] = useState(0);
  const [viewMode, setViewMode] = useState<GraphViewMode>('map');
  const [colorMode, setColorMode] = useState<GraphColorMode>('community');
  const [rotation, setRotation] = useState<Rotation>(flatRotation);
  const [graphOffset, setGraphOffset] = useState<GraphOffset>({ x: 0, y: 0 });
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, NodeOverride>>({});
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [floatTime, setFloatTime] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [isGraphFullscreen, setIsGraphFullscreen] = useState(false);
  const [researchPanelOpen, setResearchPanelOpen] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedInsightId, setSelectedInsightId] = useState<string | null>(null);
  const [researchDraft, setResearchDraft] = useState<{
    insight: GraphInsight;
    topic: string;
    queries: string;
  } | null>(null);
  const queueResearch = useResearchStore((state) => state.queueResearch);
  const entities = useLiveQuery(() => db.entities.toArray(), [], []);
  const relationships = useLiveQuery(() => db.relationships.toArray(), [], []);
  const dismissals = useLiveQuery(() => db.graphInsightDismissals.toArray(), [], []);
  const filteredEntities = useMemo(() => entities, [entities]);
  const filteredEntityIds = useMemo(
    () => new Set(filteredEntities.map((entity) => entity.id)),
    [filteredEntities],
  );
  const filteredRelationships = useMemo(
    () =>
      relationships.filter(
        (relationship) => filteredEntityIds.has(relationship.from) && filteredEntityIds.has(relationship.to),
      ),
    [relationships, filteredEntityIds],
  );
  const overview = useMemo(
    () => buildGraphOverview(filteredEntities, filteredRelationships),
    [filteredEntities, filteredRelationships],
  );
  const dismissedInsightIds = useMemo(() => new Set(dismissals.map((item) => item.id)), [dismissals]);
  const visibleInsights = useMemo(
    () => overview.insights.filter((insight) => !dismissedInsightIds.has(insight.id)),
    [overview.insights, dismissedInsightIds],
  );
  const selectedInsight = useMemo(
    () => visibleInsights.find((insight) => insight.id === selectedInsightId) ?? null,
    [selectedInsightId, visibleInsights],
  );
  const scene = useMemo(
    () => buildGraphScene(filteredEntities, filteredRelationships, layoutSalt, nodeOverrides),
    [filteredEntities, filteredRelationships, layoutSalt, nodeOverrides],
  );
  const projectedScene = useMemo(
    () => projectGraphScene(scene, viewMode === 'space' ? rotation : flatRotation, floatTime, zoom, viewMode, graphOffset),
    [scene, viewMode, rotation, floatTime, zoom, graphOffset],
  );
  const communityLegendItems = useMemo<GraphLegendItem[]>(
    () =>
      scene.communities
        .slice()
        .sort((a, b) => b.nodeCount - a.nodeCount || a.title.localeCompare(b.title, 'zh-Hans-CN'))
        .map((community) => ({
          id: community.id,
          label: community.title,
          color: getCommunityColor(community.id),
          count: community.nodeCount,
        })),
    [scene.communities],
  );
  const typeLegendItems = useMemo<GraphLegendItem[]>(() => {
    const counts = new Map<EntityType, number>();
    for (const node of scene.nodes) {
      counts.set(node.entity.type, (counts.get(node.entity.type) ?? 0) + 1);
    }
    return entityTypes
      .map((type) => ({
        id: type,
        label: entityTypeLabels[type],
        color: nodeColors[type],
        count: counts.get(type) ?? 0,
      }))
      .filter((item) => item.count > 0);
  }, [scene.nodes]);
  const legendTitle = colorMode === 'community' ? '社区' : '类型';
  const legendItems = colorMode === 'community' ? communityLegendItems : typeLegendItems;
  const highlightedNodeIds = useMemo(
    () => buildHighlightedNodeIds(scene, hoveredNodeId, selectedInsight),
    [scene, hoveredNodeId, selectedInsight],
  );
  const highlightedRelationshipIds = useMemo(
    () => new Set(selectedInsight?.relationshipIds ?? []),
    [selectedInsight],
  );
  const openGraphNode = useCallback(
    (node: SceneNode) => {
      navigate(buildWikiEntityHref(node.entity));
    },
    [navigate],
  );

  useEffect(() => {
    if (viewMode !== 'space') {
      setFloatTime(0);
      return undefined;
    }
    let frame = 0;
    let mounted = true;
    let lastPaintedAt = 0;
    const startedAt = performance.now();

    const tick = (now: number) => {
      if (!mounted) return;
      if (now - lastPaintedAt > 66) {
        setFloatTime((now - startedAt) / 1000);
        lastPaintedAt = now;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      cancelAnimationFrame(frame);
    };
  }, [viewMode]);

  useEffect(() => {
    if (!isGraphFullscreen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsGraphFullscreen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isGraphFullscreen]);

  function handleResetLayout() {
    setLayoutSalt((value) => value + 1);
    setNodeOverrides({});
    setGraphOffset({ x: 0, y: 0 });
    setRotation(viewMode === 'space' ? spaceRotation : flatRotation);
    setZoom(1);
  }

  function changeViewMode(mode: GraphViewMode) {
    setViewMode(mode);
    setRotation(mode === 'space' ? spaceRotation : flatRotation);
  }

  function handleGraphWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0012);
    setZoom((value) => clamp(value * factor, 0.62, 1.95));
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (viewMode === 'space' && event.altKey) {
      setDragState({
        mode: 'rotate',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        rotation,
      });
      return;
    }

    setDragState({
      mode: 'pan',
      pointerId: event.pointerId,
      startPoint: getSvgPoint(event),
      offset: graphOffset,
    });
  }

  function handleNodePointerDown(event: ReactPointerEvent<SVGGElement>, node: SceneNode) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    nodeWasDraggedRef.current = false;
    svgRef.current?.setPointerCapture(event.pointerId);
    setDragState({
      mode: 'node',
      pointerId: event.pointerId,
      nodeId: node.entity.id,
      lastPoint: getSvgPoint(event),
    });
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    if (dragState.mode === 'rotate') {
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      setRotation({
        x: clamp(dragState.rotation.x + dy * 0.006, -1.15, 1.15),
        y: dragState.rotation.y + dx * 0.006,
      });
      return;
    }

    if (dragState.mode === 'pan') {
      const point = getSvgPoint(event);
      const dx = point.x - dragState.startPoint.x;
      const dy = point.y - dragState.startPoint.y;
      setGraphOffset({
        x: clamp(dragState.offset.x + dx, -GRAPH_WIDTH * 0.72, GRAPH_WIDTH * 0.72),
        y: clamp(dragState.offset.y + dy, -GRAPH_HEIGHT * 0.72, GRAPH_HEIGHT * 0.72),
      });
      return;
    }

    const point = getSvgPoint(event);
    const dx = point.x - dragState.lastPoint.x;
    const dy = point.y - dragState.lastPoint.y;
    if (Math.abs(dx) + Math.abs(dy) > 1.5) {
      nodeWasDraggedRef.current = true;
    }
    const currentNode = scene.nodes.find((node) => node.entity.id === dragState.nodeId);
    if (!currentNode) return;

    setNodeOverrides((current) => {
      const base = current[dragState.nodeId] ?? {
        x: currentNode.x,
        y: currentNode.y,
        z: currentNode.z,
      };
      return {
        ...current,
        [dragState.nodeId]: {
          x: clamp(base.x + dx / zoom, 48, GRAPH_WIDTH - 48),
          y: clamp(base.y + dy / zoom, 48, GRAPH_HEIGHT - 48),
          z: clamp(base.z + (dy / zoom) * 0.18 * Math.sin(rotation.x), -260, 260),
        },
      };
    });
    setDragState({ ...dragState, lastPoint: point });
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragState(null);
  }

  function getSvgPoint(event: ReactPointerEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * GRAPH_WIDTH,
      y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * GRAPH_HEIGHT,
    };
  }

  async function dismissInsight(insight: GraphInsight) {
    await db.graphInsightDismissals.put({
      id: insight.id,
      clientId: getClientId(),
      type: insight.type,
      dismissedAt: Date.now(),
    });
  }

  function openResearchDraftFromInsight(insight: GraphInsight) {
    const entityTitles = insight.entityIds
      .map((entityId) => entities.find((entity) => entity.id === entityId)?.title)
      .filter(Boolean)
      .slice(0, 4)
      .join(' ');
    const topic = `${insight.title} ${entityTitles}`.trim();
    setResearchDraft({
      insight,
      topic,
      queries: [insight.title, topic].filter(Boolean).join('\n'),
    });
    setSelectedInsightId(insight.id);
  }

  function confirmResearchDraft() {
    if (!researchDraft) return;
    const topic = researchDraft.topic.trim();
    if (!topic) return;
    const queries = researchDraft.queries
      .split(/\r?\n/)
      .map((query) => query.trim())
      .filter(Boolean);
    queueResearch(topic, { searchQueries: queries.length ? queries : [topic] });
    setResearchDraft(null);
    setResearchPanelOpen(true);
  }

  const graphPanelClass = [
    'flex flex-col overflow-hidden rounded-[12px] border border-[#d9d9d6] bg-white',
    isGraphFullscreen
      ? 'fixed inset-3 z-50 min-h-0 shadow-2xl lg:inset-4'
      : 'min-h-[640px] lg:min-h-0',
  ].join(' ');

  return (
    <section className="mx-auto flex min-h-full max-w-7xl flex-col overflow-visible px-5 py-6 lg:h-full lg:overflow-hidden">
      <div className="mb-4 flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#155eef]">Graph</p>
          <h2 className="mt-2 text-2xl font-semibold text-[#1f2937]">关系图谱</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setZoom((value) => clamp(value - 0.12, 0.62, 1.95))}
            className="inline-flex size-9 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
            title="缩小"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => clamp(value + 0.12, 0.62, 1.95))}
            className="inline-flex size-9 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
            title="放大"
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setIsGraphFullscreen((value) => !value)}
            className="inline-flex size-9 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
            title={isGraphFullscreen ? '退出全屏' : '全屏图谱'}
            aria-label={isGraphFullscreen ? '退出全屏图谱' : '全屏图谱'}
          >
            {isGraphFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            onClick={handleResetLayout}
            className="inline-flex items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-4 py-2 text-sm font-medium text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
          >
            <RotateCcw size={16} />
            重排
          </button>
          <div className="inline-flex rounded-full border border-[#d9d9d6] bg-white p-1 text-xs">
            <button
              type="button"
              onClick={() => setColorMode('community')}
              className={[
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition',
                colorMode === 'community' ? 'bg-[#155eef] text-white' : 'text-[#4b5563] hover:text-[#155eef]',
              ].join(' ')}
              title="按社区着色"
            >
              <GitBranch size={14} />
              社区
            </button>
            <button
              type="button"
              onClick={() => setColorMode('type')}
              className={[
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition',
                colorMode === 'type' ? 'bg-[#155eef] text-white' : 'text-[#4b5563] hover:text-[#155eef]',
              ].join(' ')}
              title="按类型着色"
            >
              <Radar size={14} />
              类型
            </button>
          </div>
          <div className="inline-flex rounded-full border border-[#d9d9d6] bg-white p-1 text-xs">
            <button
              type="button"
              onClick={() => changeViewMode('map')}
              className={[
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition',
                viewMode === 'map' ? 'bg-[#155eef] text-white' : 'text-[#4b5563] hover:text-[#155eef]',
              ].join(' ')}
              title="平面视角"
            >
              <MapIcon size={14} />
              平面
            </button>
          </div>
        </div>
      </div>

      <div className="grid flex-1 gap-5 lg:min-h-0 lg:grid-cols-[minmax(0,1.9fr)_minmax(320px,0.72fr)]">
        <section className={graphPanelClass}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e5e4] px-5 py-4">
            <div className="flex items-center gap-3 text-[#1f2937]">
              <span className="flex size-9 items-center justify-center rounded-[10px] border border-[#d9d9d6] bg-[#f4f8ff] text-[#155eef]">
                <Network size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold">Knowledge Network</h3>
                <p className="text-xs text-[#626965]">
                  {scene.nodes.length}/{overview.entityCount} nodes / {scene.links.length}/{overview.relationshipCount} links / {scene.communities.length} communities / {Math.round(zoom * 100)}%
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {isGraphFullscreen ? (
                <button
                  type="button"
                  onClick={() => setIsGraphFullscreen(false)}
                  className="inline-flex size-8 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
                  title="退出全屏"
                  aria-label="退出全屏图谱"
                >
                  <Minimize2 size={14} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="relative min-h-0 flex-1 bg-[#fbfbfa]">
            {scene.nodes.length === 0 ? (
              <div className="flex h-full min-h-[360px] items-center justify-center px-6 text-center text-sm text-[#626965]">
                当前没有可展示的图谱节点。请先完成原文件入库，或批量生成/更新 Wiki 页。
              </div>
            ) : viewMode === 'space' ? (
              <GraphSpaceView
                scene={scene}
                colorMode={colorMode}
                highlightedNodeIds={highlightedNodeIds}
                highlightedRelationshipIds={highlightedRelationshipIds}
                hoveredNodeId={hoveredNodeId}
                rotation={rotation}
                zoom={zoom}
                graphOffset={graphOffset}
                onHoverNode={setHoveredNodeId}
                onOpenNode={openGraphNode}
                onRotationChange={setRotation}
                onZoomChange={setZoom}
                onOffsetChange={setGraphOffset}
              />
            ) : (
              <svg
                ref={svgRef}
                viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                className="mywiki-tech-graph h-full min-h-[360px] w-full cursor-grab active:cursor-grabbing"
                role="img"
                aria-label="MyWiki 关系图谱"
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onWheel={handleGraphWheel}
              >
                <defs>
                  <pattern id="graph-grid" width="42" height="42" patternUnits="userSpaceOnUse">
                    <path d="M 42 0 L 0 0 0 42" fill="none" stroke="rgba(100, 116, 139, 0.18)" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="#f4f7fb" />
                <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="url(#graph-grid)" />

                {projectedScene.links.map((link) => {
                  const focused =
                    !highlightedNodeIds ||
                    link.from.node.entity.id === hoveredNodeId ||
                    link.to.node.entity.id === hoveredNodeId ||
                    highlightedRelationshipIds.has(link.relationship.id) ||
                    (highlightedNodeIds.has(link.from.node.entity.id) && highlightedNodeIds.has(link.to.node.entity.id));
                  return (
                    <g key={link.relationship.id}>
                      <path
                        d={buildLinkPath(link)}
                        className={link.crossCommunity ? 'mywiki-tech-link mywiki-tech-link-cross' : 'mywiki-tech-link'}
                        style={{
                          opacity: focused
                            ? Math.max(link.opacity, link.crossCommunity ? 0.38 : link.sameCommunity ? 0.34 : 0.18)
                            : link.crossCommunity
                              ? 0.24
                              : 0.1,
                          stroke:
                            highlightedRelationshipIds.has(link.relationship.id)
                              ? '#16a34a'
                              : colorMode === 'community' && link.sameCommunity
                                ? getCommunityColor(link.from.node.communityId)
                                : link.crossCommunity
                                  ? '#64748b'
                                  : undefined,
                          strokeWidth: highlightedRelationshipIds.has(link.relationship.id)
                            ? Math.max(2.8, 1.5 + link.weight * 0.3)
                            : link.crossCommunity
                              ? Math.max(1.55, 1.25 + link.weight * 0.12)
                            : link.sameCommunity
                              ? Math.max(1.2, 0.95 + link.weight * 0.08)
                              : 1.05,
                          strokeDasharray: link.crossCommunity ? '7 7' : undefined,
                        }}
                      />
                      <title>
                        {link.from.node.entity.title} / {relationshipTypeLabel(link.relationship.type)} / {link.to.node.entity.title}
                      </title>
                    </g>
                  );
                })}

                {projectedScene.nodes.map((projected) => {
                  const node = projected.node;
                  const color = getNodeColor(node, colorMode);
                  const focused = !highlightedNodeIds || highlightedNodeIds.has(node.entity.id);
                  const isHovered = hoveredNodeId === node.entity.id;
                  const showLabel = isHovered || projectedScene.visibleLabelIds.has(node.entity.id);
                  return (
                    <a
                      key={node.entity.id}
                      href={buildWikiEntityHref(node.entity)}
                      onClick={(event) => {
                        if (nodeWasDraggedRef.current) {
                          event.preventDefault();
                          nodeWasDraggedRef.current = false;
                        }
                      }}
                    >
                      <g
                        className="mywiki-tech-node"
                        style={{ opacity: focused ? projected.opacity : 0.18 }}
                        onPointerDown={(event) => handleNodePointerDown(event, node)}
                        onPointerEnter={() => setHoveredNodeId(node.entity.id)}
                        onPointerLeave={() => setHoveredNodeId(null)}
                      >
                        <circle
                          cx={projected.x}
                          cy={projected.y}
                          r={projected.radius + 14}
                          fill="transparent"
                          pointerEvents="all"
                        />
                        <circle
                          cx={projected.x}
                          cy={projected.y}
                          r={projected.radius + 6}
                          stroke={color}
                          className="mywiki-tech-node-ring"
                          style={{ opacity: node.isCommunityHub ? 0.42 : 0.24 }}
                        />
                        <circle
                          cx={projected.x}
                          cy={projected.y}
                          r={projected.radius}
                          fill={color}
                          stroke="#f8fafc"
                          strokeWidth="2.5"
                        />
                        <circle
                          cx={projected.x - projected.radius * 0.32}
                          cy={projected.y - projected.radius * 0.34}
                          r={Math.max(2.2, projected.radius * 0.23)}
                          fill="#ffffff"
                          opacity="0.42"
                          pointerEvents="none"
                        />
                        {showLabel ? (
                          <text
                            x={projected.x}
                            y={projected.y + projected.radius + 17}
                            textAnchor="middle"
                            className={isHovered ? 'mywiki-tech-label mywiki-tech-label-active' : 'mywiki-tech-label'}
                          >
                            {isHovered ? shortTitle(node.entity.title, 24) : shortTitle(node.entity.title, node.isCommunityHub ? 16 : 13)}
                          </text>
                        ) : null}
                        <title>
                          {entityTypeLabels[node.entity.type]} / {node.entity.title} / {node.degree} links
                          {colorMode === 'community' ? ` / community: ${node.communityId}` : ''}
                        </title>
                      </g>
                    </a>
                  );
                })}
              </svg>
            )}
          </div>
        </section>

        <aside className="min-h-0 space-y-5 overflow-auto pr-1">
          <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
            <div className="flex items-center gap-2">
              <Activity size={17} className="text-[#155eef]" />
              <h3 className="text-sm font-semibold text-[#1f2937]">图谱状态</h3>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Stat label="实体" value={overview.entityCount} />
              <Stat label="关系" value={overview.relationshipCount} />
              <Stat label="连通分量" value={overview.componentCount} />
              <Stat label="孤立实体" value={overview.orphanCount} />
            </div>
          </section>

          <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Radar size={17} className="text-[#155eef]" />
                <div>
                  <h3 className="text-sm font-semibold text-[#1f2937]">图谱诊断</h3>
                  <p className="mt-0.5 text-[11px] leading-4 text-[#626965]">自动找出补来源、补关系和研究入口。</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setResearchPanelOpen((value) => !value)}
                className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] bg-white px-2.5 py-1 text-xs text-[#155eef] hover:bg-[#f4f8ff]"
              >
                <Search size={13} />
                研究
              </button>
            </div>
            {visibleInsights.length === 0 ? (
              <div className="mt-4 flex items-center gap-2 rounded-[10px] border border-[#d9d9d6] bg-[#fbfbfa] px-3 py-3 text-sm text-[#626965]">
                <Sparkles size={16} />
                暂无需要处理的洞察。
              </div>
            ) : (
              <div className="mt-4 grid gap-3">
                {visibleInsights.slice(0, 5).map((insight) => (
                  <article
                    key={insight.id}
                    className={[
                      'cursor-pointer rounded-[10px] border p-3 transition',
                      selectedInsightId === insight.id
                        ? 'border-[#155eef] bg-[#f4f8ff]'
                        : 'border-[#e5e5e4] bg-[#fbfbfa] hover:border-[#b8cdf7]',
                    ].join(' ')}
                    onClick={() => setSelectedInsightId((current) => (current === insight.id ? null : insight.id))}
                  >
                    <div className="flex items-start gap-2">
                      <InsightIcon type={insight.type} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-[#d9d9d6] bg-white px-2 py-0.5 text-[11px] text-[#155eef]">
                            {insightTypeLabels[insight.type]}
                          </span>
                          <h4 className="text-sm font-semibold text-[#1f2937]">{insight.title}</h4>
                        </div>
                        <p className="mt-1 text-[11px] leading-4 text-[#155eef]">{insightReasonLabels[insight.type]}</p>
                        <p className="mt-2 text-xs leading-5 text-[#626965]">{insight.detail}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {insight.entityIds.slice(0, 3).map((entityId) => {
                            const entity = entities.find((item) => item.id === entityId);
                            if (!entity) return null;
                            return (
                              <Link
                                key={entityId}
                                to={buildWikiEntityHref(entity)}
                                onClick={(event) => event.stopPropagation()}
                                className="rounded-full border border-[#d9d9d6] bg-white px-2.5 py-1 text-xs text-[#155eef]"
                              >
                                {entity.title}
                              </Link>
                            );
                          })}
                        </div>
                        {insight.type === 'knowledge-gap' || insight.type === 'sparse-community' || insight.type === 'bridge-node' ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openResearchDraftFromInsight(insight);
                            }}
                            className="mt-3 inline-flex items-center gap-1 rounded-full border border-[#155eef] bg-white px-3 py-1.5 text-xs font-medium text-[#155eef] hover:bg-[#eef4ff]"
                          >
                            <Search size={13} />
                            发起深度研究
                          </button>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void dismissInsight(insight);
                        }}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#626965] transition hover:border-[#155eef] hover:text-[#155eef]"
                        title="隐藏这条洞察"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </article>
                ))}
                {visibleInsights.length > 5 ? (
                  <p className="rounded-[10px] border border-[#e5e5e4] bg-white px-3 py-2 text-xs text-[#626965]">
                    还有 {visibleInsights.length - 5} 条诊断已收起，优先处理上方高优先级项目。
                  </p>
                ) : null}
              </div>
            )}
          </section>
          {researchPanelOpen ? <ResearchPanel compact /> : null}
        </aside>
      </div>
      {researchDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/32 px-4">
          <div className="w-full max-w-xl rounded-[12px] border border-[#d9d9d6] bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-[#155eef]">Deep Research</p>
                <h3 className="mt-1 text-lg font-semibold text-[#1f2937]">确认研究主题</h3>
              </div>
              <button
                type="button"
                onClick={() => setResearchDraft(null)}
                className="inline-flex size-8 items-center justify-center rounded-full border border-[#d9d9d6] text-[#626965] hover:border-[#155eef] hover:text-[#155eef]"
                title="关闭"
              >
                <X size={15} />
              </button>
            </div>
            <label className="mt-4 grid gap-2 text-sm font-medium text-[#1f2937]">
              主题
              <input
                value={researchDraft.topic}
                onChange={(event) => setResearchDraft({ ...researchDraft, topic: event.target.value })}
                className="rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
              />
            </label>
            <label className="mt-3 grid gap-2 text-sm font-medium text-[#1f2937]">
              搜索 query（每行一个）
              <textarea
                value={researchDraft.queries}
                onChange={(event) => setResearchDraft({ ...researchDraft, queries: event.target.value })}
                className="min-h-28 resize-y rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm leading-6 outline-none focus:border-[#155eef]"
              />
            </label>
            <p className="mt-3 text-xs leading-5 text-[#626965]">{researchDraft.insight.detail}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResearchDraft(null)}
                className="rounded-full border border-[#d9d9d6] px-4 py-2 text-sm text-[#4b5563] hover:bg-[#f7f7f5]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmResearchDraft}
                className="inline-flex items-center gap-2 rounded-full bg-[#155eef] px-4 py-2 text-sm font-medium text-white hover:bg-[#0f4bcc]"
              >
                <Search size={15} />
                开始研究
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

type GraphSpaceViewProps = {
  scene: GraphScene;
  colorMode: GraphColorMode;
  highlightedNodeIds?: Set<string>;
  highlightedRelationshipIds: Set<string>;
  hoveredNodeId: string | null;
  rotation: Rotation;
  zoom: number;
  graphOffset: GraphOffset;
  onHoverNode: (nodeId: string | null) => void;
  onOpenNode: (node: SceneNode) => void;
  onRotationChange: (rotation: Rotation) => void;
  onZoomChange: (zoom: number) => void;
  onOffsetChange: (offset: GraphOffset) => void;
};

type SpaceDragState =
  | {
      mode: 'orbit';
      pointerId: number;
      startX: number;
      startY: number;
      rotation: Rotation;
      moved: boolean;
    }
  | {
      mode: 'pan';
      pointerId: number;
      startX: number;
      startY: number;
      offset: GraphOffset;
      moved: boolean;
    };

function GraphSpaceView({
  scene,
  colorMode,
  highlightedNodeIds,
  highlightedRelationshipIds,
  hoveredNodeId,
  rotation,
  zoom,
  graphOffset,
  onHoverNode,
  onOpenNode,
  onRotationChange,
  onZoomChange,
  onOffsetChange,
}: GraphSpaceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rotationRef = useRef(rotation);
  const zoomRef = useRef(zoom);
  const offsetRef = useRef(graphOffset);
  const colorModeRef = useRef(colorMode);
  const hoveredNodeIdRef = useRef(hoveredNodeId);
  const highlightedNodeIdsRef = useRef(highlightedNodeIds);
  const highlightedRelationshipIdsRef = useRef(highlightedRelationshipIds);
  const callbacksRef = useRef({ onHoverNode, onOpenNode, onRotationChange, onZoomChange, onOffsetChange });
  const dragStateRef = useRef<SpaceDragState | null>(null);

  useEffect(() => {
    rotationRef.current = rotation;
  }, [rotation]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    offsetRef.current = graphOffset;
  }, [graphOffset]);

  useEffect(() => {
    colorModeRef.current = colorMode;
  }, [colorMode]);

  useEffect(() => {
    hoveredNodeIdRef.current = hoveredNodeId;
  }, [hoveredNodeId]);

  useEffect(() => {
    highlightedNodeIdsRef.current = highlightedNodeIds;
  }, [highlightedNodeIds]);

  useEffect(() => {
    highlightedRelationshipIdsRef.current = highlightedRelationshipIds;
  }, [highlightedRelationshipIds]);

  useEffect(() => {
    callbacksRef.current = { onHoverNode, onOpenNode, onRotationChange, onZoomChange, onOffsetChange };
  }, [onHoverNode, onOpenNode, onRotationChange, onZoomChange, onOffsetChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#f4f7fb', 1);

    const threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color('#f4f7fb');
    threeScene.fog = new THREE.FogExp2('#f4f7fb', 0.00028);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 3000);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const root = new THREE.Group();
    threeScene.add(root);

    const resources: Array<{ dispose: () => void }> = [];
    const nodeGeometry = new THREE.SphereGeometry(1, 28, 18);
    resources.push(nodeGeometry);

    const ambient = new THREE.AmbientLight('#ffffff', 1.9);
    threeScene.add(ambient);
    const keyLight = new THREE.DirectionalLight('#ffffff', 2.1);
    keyLight.position.set(280, 420, 520);
    threeScene.add(keyLight);
    const rimLight = new THREE.DirectionalLight('#8fb7ff', 1.1);
    rimLight.position.set(-420, 160, -520);
    threeScene.add(rimLight);

    const grid = new THREE.GridHelper(960, 24, '#94a3b8', '#dbe3eb');
    grid.position.y = -305;
    grid.material.opacity = 0.42;
    grid.material.transparent = true;
    root.add(grid);

    addSpaceAxis(root, resources, new THREE.Vector3(-520, -305, 0), new THREE.Vector3(520, -305, 0), '#ef4444', 'X');
    addSpaceAxis(root, resources, new THREE.Vector3(-500, -305, -360), new THREE.Vector3(-500, -305, 360), '#22c55e', 'Z');
    addSpaceAxis(root, resources, new THREE.Vector3(-500, -305, -360), new THREE.Vector3(-500, 260, -360), '#2563eb', 'Y');
    [-260, 0, 260].forEach((depth, index) => {
      addSpaceDepthFrame(root, resources, depth, index === 0 ? '远层' : index === 1 ? '中层' : '近层');
    });

    const nodePositions = new Map<string, THREE.Vector3>();
    const nodeObjects = scene.nodes.map((node) => {
      const radius = nodeRadius(node.degree) * (node.isCommunityHub ? 1.28 : 1.08);
      const material = new THREE.MeshStandardMaterial({
        color: getNodeColor(node, colorModeRef.current),
        emissive: getNodeColor(node, colorModeRef.current),
        emissiveIntensity: 0.16,
        roughness: 0.44,
        metalness: 0.05,
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(nodeGeometry, material);
      mesh.scale.setScalar(radius);
      mesh.userData = { nodeId: node.entity.id };
      resources.push(material);
      root.add(mesh);

      const haloMaterial = new THREE.MeshBasicMaterial({
        color: getNodeColor(node, colorModeRef.current),
        transparent: true,
        opacity: node.isCommunityHub ? 0.28 : 0.14,
        wireframe: true,
      });
      const halo = new THREE.Mesh(nodeGeometry, haloMaterial);
      halo.scale.setScalar(radius + (node.isCommunityHub ? 13 : 8));
      resources.push(haloMaterial);
      root.add(halo);

      return { node, mesh, halo, material, haloMaterial, radius };
    });
    const nodeMeshes = nodeObjects.map((item) => item.mesh);

    const labeledNodeIds = new Set(
      scene.nodes
        .slice()
        .sort((a, b) => Number(b.isCommunityHub) - Number(a.isCommunityHub) || b.degree - a.degree || b.entity.updatedAt - a.entity.updatedAt)
        .slice(0, 34)
        .map((node) => node.entity.id),
    );
    const labelObjects = nodeObjects
      .filter((item) => labeledNodeIds.has(item.node.entity.id))
      .map((item) => {
        const label = createSpaceTextSprite(shortTitle(item.node.entity.title, item.node.isCommunityHub ? 16 : 13), '#1f2937');
        label.renderOrder = 20;
        resources.push(label.material, label.material.map as THREE.Texture);
        root.add(label);
        return { ...item, label };
      });

    const communityShells = scene.communities.map((community) => {
      const material = new THREE.MeshBasicMaterial({
        color: colorModeRef.current === 'community' ? getCommunityColor(community.id) : nodeColors[community.type],
        transparent: true,
        opacity: 0.09,
        wireframe: true,
      });
      const geometry = new THREE.SphereGeometry(Math.max(46, community.radius * 0.56), 28, 16);
      const shell = new THREE.Mesh(geometry, material);
      shell.position.copy(spaceCommunityPosition(community));
      resources.push(geometry, material);
      root.add(shell);
      return { community, shell, material };
    });

    const linkObjects = scene.links.map((link) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const material = new THREE.LineBasicMaterial({
        color: link.sameCommunity && colorModeRef.current === 'community' ? getCommunityColor(link.from.communityId) : '#9ca7b4',
        transparent: true,
        opacity: link.sameCommunity ? 0.58 : 0.3,
      });
      const line = new THREE.Line(geometry, material);
      resources.push(geometry, material);
      root.add(line);
      return { link, line, geometry, material };
    });

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const setPointerFromEvent = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
    };

    const pickNode = (event: PointerEvent) => {
      setPointerFromEvent(event);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(nodeMeshes, false)[0];
      const nodeId = typeof hit?.object.userData.nodeId === 'string' ? hit.object.userData.nodeId : null;
      callbacksRef.current.onHoverNode(nodeId);
      return nodeId ? scene.nodes.find((node) => node.entity.id === nodeId) ?? null : null;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const mode = event.shiftKey || event.altKey || event.button === 1 ? 'pan' : 'orbit';
      dragStateRef.current =
        mode === 'orbit'
          ? {
              mode,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              rotation: rotationRef.current,
              moved: false,
            }
          : {
              mode,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              offset: offsetRef.current,
              moved: false,
            };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        pickNode(event);
        return;
      }

      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
      if (dragState.mode === 'orbit') {
        callbacksRef.current.onRotationChange({
          x: clamp(dragState.rotation.x + dy * 0.0065, -1.18, 1.18),
          y: dragState.rotation.y + dx * 0.0065,
        });
      } else {
        callbacksRef.current.onOffsetChange({
          x: clamp(dragState.offset.x + dx * 1.45, -GRAPH_WIDTH * 0.72, GRAPH_WIDTH * 0.72),
          y: clamp(dragState.offset.y + dy * 1.45, -GRAPH_HEIGHT * 0.72, GRAPH_HEIGHT * 0.72),
        });
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      dragStateRef.current = null;
      const pickedNode = pickNode(event);
      if (pickedNode && !dragState.moved) callbacksRef.current.onOpenNode(pickedNode);
    };

    const handlePointerLeave = () => {
      callbacksRef.current.onHoverNode(null);
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0012);
      callbacksRef.current.onZoomChange(clamp(zoomRef.current * factor, 0.62, 1.95));
    };

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    let frame = 0;
    const animate = (now: number) => {
      const time = now / 1000;
      updateSpaceCamera(camera, rotationRef.current, zoomRef.current, offsetRef.current);
      const activeHighlights = highlightedNodeIdsRef.current;
      const activeRelationships = highlightedRelationshipIdsRef.current;
      const hovered = hoveredNodeIdRef.current;
      const mode = colorModeRef.current;

      for (const item of nodeObjects) {
        const position = spaceNodePosition(item.node, time);
        nodePositions.set(item.node.entity.id, position);
        item.mesh.position.copy(position);
        item.halo.position.copy(position);
        const focused = !activeHighlights || activeHighlights.has(item.node.entity.id);
        const isHovered = hovered === item.node.entity.id;
        const color = getNodeColor(item.node, mode);
        item.material.color.set(color);
        item.material.emissive.set(color);
        item.haloMaterial.color.set(color);
        item.material.opacity = focused ? 1 : 0.32;
        item.haloMaterial.opacity = focused ? (item.node.isCommunityHub ? 0.28 : 0.14) : 0.06;
        const targetScale = item.radius * (isHovered ? 1.24 : 1);
        item.mesh.scale.setScalar(targetScale);
        item.halo.scale.setScalar(targetScale + (item.node.isCommunityHub ? 13 : 8));
      }

      for (const item of labelObjects) {
        const position = nodePositions.get(item.node.entity.id);
        if (!position) continue;
        const focused = !activeHighlights || activeHighlights.has(item.node.entity.id);
        const isHovered = hovered === item.node.entity.id;
        item.label.visible = focused && (isHovered || labeledNodeIds.has(item.node.entity.id));
        item.label.material.opacity = isHovered ? 1 : 0.96;
        item.label.position.set(position.x, position.y + item.radius + 18, position.z);
      }

      for (const item of communityShells) {
        item.material.color.set(mode === 'community' ? getCommunityColor(item.community.id) : nodeColors[item.community.type]);
      }

      for (const item of linkObjects) {
        const from = nodePositions.get(item.link.from.entity.id);
        const to = nodePositions.get(item.link.to.entity.id);
        if (!from || !to) continue;
        const position = item.geometry.getAttribute('position') as THREE.BufferAttribute;
        position.setXYZ(0, from.x, from.y, from.z);
        position.setXYZ(1, to.x, to.y, to.z);
        position.needsUpdate = true;
        const focused =
          activeRelationships.has(item.link.relationship.id) ||
          !activeHighlights ||
          (activeHighlights.has(item.link.from.entity.id) && activeHighlights.has(item.link.to.entity.id));
        item.material.color.set(
          activeRelationships.has(item.link.relationship.id)
            ? '#16a34a'
            : mode === 'community' && item.link.sameCommunity
              ? getCommunityColor(item.link.from.communityId)
              : '#9ca7b4',
        );
        item.material.opacity = focused ? (item.link.sameCommunity ? 0.62 : 0.32) : 0.08;
      }

      renderer.render(threeScene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('wheel', handleWheel);
      callbacksRef.current.onHoverNode(null);
      resources.forEach((resource) => resource.dispose());
      renderer.dispose();
    };
  }, [scene]);

  return (
    <div ref={containerRef} className="mywiki-graph-space-shell h-full min-h-[360px] w-full">
      <canvas
        ref={canvasRef}
        className="mywiki-graph-space-canvas h-full w-full cursor-grab active:cursor-grabbing"
        title="拖拽旋转，Shift/Alt 拖拽平移，滚轮缩放"
      />
    </div>
  );
}

function updateSpaceCamera(camera: THREE.PerspectiveCamera, rotation: Rotation, zoom: number, offset: GraphOffset) {
  const distance = 850 / clamp(zoom, 0.62, 1.95);
  const target = new THREE.Vector3(-offset.x * 0.55, offset.y * 0.55, 0);
  const pitch = rotation.x;
  const yaw = rotation.y;
  camera.position.set(
    target.x + Math.cos(pitch) * Math.sin(yaw) * distance,
    target.y - Math.sin(pitch) * distance,
    target.z + Math.cos(pitch) * Math.cos(yaw) * distance,
  );
  camera.lookAt(target);
}

function spaceNodePosition(node: SceneNode, time = 0) {
  const driftX = Math.sin(time * 0.46 + node.phase) * node.drift * 0.95;
  const driftY = Math.cos(time * 0.41 + node.phase * 0.8) * node.drift * 0.5;
  const driftZ = Math.sin(time * 0.35 + node.phase * 1.4) * node.drift * 4.4;
  return new THREE.Vector3(
    (node.x - GRAPH_WIDTH / 2) * 0.72 + driftX,
    -(node.y - GRAPH_HEIGHT / 2) * 0.72 + driftY,
    spaceNodeDepth(node) + driftZ,
  );
}

function spaceCommunityPosition(community: GraphCommunity) {
  return new THREE.Vector3(
    (community.x - GRAPH_WIDTH / 2) * 0.72,
    -(community.y - GRAPH_HEIGHT / 2) * 0.72,
    community.z * 2.2 + ((hashCode(`${community.id}:space-community`) % 360) - 180) * 0.72,
  );
}

function spaceNodeDepth(node: SceneNode) {
  const communityBand = ((hashCode(`${node.communityId}:space-band`) % 420) - 210) * 0.72;
  const typeBand: Record<EntityType, number> = {
    project: 76,
    topic: -36,
    person: 128,
    event: -128,
  };
  const rankBand = (node.communityRank - 1) * 24;
  return node.z * 2.25 + communityBand + typeBand[node.entity.type] + rankBand;
}

function addSpaceAxis(
  root: THREE.Group,
  resources: Array<{ dispose: () => void }>,
  start: THREE.Vector3,
  end: THREE.Vector3,
  color: string,
  label: string,
) {
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.72 });
  const line = new THREE.Line(geometry, material);
  root.add(line);
  resources.push(geometry, material);

  const sprite = createSpaceTextSprite(label, color);
  sprite.position.copy(end);
  sprite.position.y += 16;
  sprite.scale.multiplyScalar(0.72);
  root.add(sprite);
  resources.push(sprite.material, sprite.material.map as THREE.Texture);
}

function addSpaceDepthFrame(root: THREE.Group, resources: Array<{ dispose: () => void }>, z: number, label: string) {
  const points = [
    new THREE.Vector3(-465, -255, z),
    new THREE.Vector3(465, -255, z),
    new THREE.Vector3(465, 235, z),
    new THREE.Vector3(-465, 235, z),
    new THREE.Vector3(-465, -255, z),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: '#94a3b8', transparent: true, opacity: z === 0 ? 0.28 : 0.18 });
  const line = new THREE.Line(geometry, material);
  root.add(line);
  resources.push(geometry, material);

  const sprite = createSpaceTextSprite(label, '#64748b');
  sprite.position.set(-492, 248, z);
  sprite.scale.multiplyScalar(0.62);
  root.add(sprite);
  resources.push(sprite.material, sprite.material.map as THREE.Texture);
}

function createSpaceTextSprite(text: string, color: string) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const fontSize = 30;
  context.font = `700 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const metrics = context.measureText(text);
  canvas.width = Math.ceil(metrics.width + 28);
  canvas.height = 52;
  context.font = `700 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  context.fillStyle = 'rgba(255, 255, 255, 0.97)';
  roundRect(context, 0, 4, canvas.width, 42, 12);
  context.fill();
  context.strokeStyle = 'rgba(100, 116, 139, 0.55)';
  context.lineWidth = 2;
  roundRect(context, 1, 5, canvas.width - 2, 40, 11);
  context.stroke();
  context.fillStyle = color;
  context.textBaseline = 'middle';
  context.fillText(text, 14, 26);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(canvas.width * 0.34, canvas.height * 0.34, 1);
  return sprite;
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function GraphLegendCard({ title, items }: { title: string; items: GraphLegendItem[] }) {
  return (
    <div className="pointer-events-auto absolute bottom-4 left-4 z-10 w-[172px] max-w-[calc(100%-2rem)] rounded-[10px] border border-[#d9d9d6] bg-white/95 p-3 shadow-[0_12px_32px_rgba(15,23,42,0.12)] backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-[#1f2937]">{title}</h4>
        <span className="text-xs text-[#8a908b]">{items.length}</span>
      </div>
      <div className="mt-2 grid max-h-[168px] gap-2 overflow-y-auto pr-1">
        {items.map((item) => (
          <div key={item.id} className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 text-sm">
            <span className="size-3 rounded-full" style={{ backgroundColor: item.color }} />
            <span className="truncate text-[#626965]" title={item.label}>
              {item.label}
            </span>
            <span className="text-xs tabular-nums text-[#9ca3af]">{item.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function getNodeColor(node: SceneNode, colorMode: GraphColorMode) {
  return colorMode === 'community' ? getCommunityColor(node.communityId) : nodeColors[node.entity.type];
}

function getCommunityColor(communityId: string) {
  return communityPalette[hashCode(communityId) % communityPalette.length];
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[10px] border border-[#eeeeed] bg-[#fbfbfa] px-3 py-2">
      <p className="text-xs text-[#626965]">{label}</p>
      <p className="mt-1 text-xl font-semibold text-[#1f2937]">{value}</p>
    </div>
  );
}

function InsightIcon({ type }: { type: keyof typeof insightTypeLabels }) {
  const className = 'mt-0.5 shrink-0 text-[#155eef]';
  if (type === 'knowledge-gap') return <AlertTriangle size={16} className={className} />;
  if (type === 'sparse-community') return <AlertTriangle size={16} className={className} />;
  if (type === 'bridge-node') return <GitBranch size={16} className={className} />;
  if (type === 'dense-hub') return <Network size={16} className={className} />;
  return <Radar size={16} className={className} />;
}

function buildWikiEntityHref(entity: Entity) {
  const reference = entity.title.trim() || entity.id;
  return `/wiki?ref=${encodeURIComponent(reference)}`;
}

function buildHighlightedNodeIds(scene: GraphScene, hoveredNodeId: string | null, selectedInsight: GraphInsight | null) {
  if (!hoveredNodeId && !selectedInsight) return undefined;
  const ids = new Set<string>(selectedInsight?.entityIds ?? []);
  if (hoveredNodeId) ids.add(hoveredNodeId);
  for (const link of scene.links) {
    if (hoveredNodeId && link.from.entity.id === hoveredNodeId) ids.add(link.to.entity.id);
    if (hoveredNodeId && link.to.entity.id === hoveredNodeId) ids.add(link.from.entity.id);
    if (selectedInsight?.relationshipIds.includes(link.relationship.id)) {
      ids.add(link.from.entity.id);
      ids.add(link.to.entity.id);
    }
  }
  return ids;
}

function buildGraphScene(
  entities: Entity[],
  relationships: Relationship[],
  salt: number,
  nodeOverrides: Record<string, NodeOverride>,
): GraphScene {
  if (entities.length === 0) return { nodes: [], links: [], communities: [] };

  const validEntityIds = new Set(entities.map((entity) => entity.id));
  const validRelationships = relationships.filter(
    (relationship) => validEntityIds.has(relationship.from) && validEntityIds.has(relationship.to),
  );
  const degreeById = new Map<string, number>();
  for (const entity of entities) {
    degreeById.set(entity.id, 0);
  }
  for (const relationship of validRelationships) {
    degreeById.set(relationship.from, (degreeById.get(relationship.from) ?? 0) + 1);
    degreeById.set(relationship.to, (degreeById.get(relationship.to) ?? 0) + 1);
  }

  const communityModel = buildCommunityModel(entities, validRelationships, degreeById, salt);
  const selectedEntities = selectCommunityEntities(entities, communityModel, degreeById, 104);
  const selectedIds = new Set(selectedEntities.map((entity) => entity.id));
  const selectedRelationships = validRelationships
    .filter((relationship) => selectedIds.has(relationship.from) && selectedIds.has(relationship.to))
    .sort((a, b) => {
      const sameA = communityModel.assignment.get(a.from) === communityModel.assignment.get(a.to);
      const sameB = communityModel.assignment.get(b.from) === communityModel.assignment.get(b.to);
      return Number(sameB) - Number(sameA) || relationshipStrength(b) - relationshipStrength(a);
    })
    .slice(0, 185);

  const { nodes, communities } = runCommunityLayout(
    selectedEntities,
    selectedRelationships,
    degreeById,
    communityModel,
    salt,
    nodeOverrides,
  );
  const nodeById = new Map(nodes.map((node) => [node.entity.id, node]));
  const links = selectedRelationships
    .map((relationship) => {
      const from = nodeById.get(relationship.from);
      const to = nodeById.get(relationship.to);
      return from && to
        ? {
            relationship,
            from,
            to,
            weight: relationshipStrength(relationship),
            sameCommunity: from.communityId === to.communityId,
          }
        : undefined;
    })
    .filter((link): link is SceneLink => Boolean(link));

  return { nodes, links, communities };
}

type CommunityModel = {
  hubs: Entity[];
  assignment: Map<string, string>;
  weightToHub: Map<string, number>;
  communities: EntityLouvainCommunity[];
  communityByHubId: Map<string, EntityLouvainCommunity>;
};

function buildCommunityModel(
  entities: Entity[],
  relationships: Relationship[],
  _degreeById: Map<string, number>,
  _salt: number,
): CommunityModel {
  return detectEntityLouvainCommunities(entities, relationships, {
    relationshipWeight: relationshipStrength,
    resolution: 1,
    sourceOverlapWeight: 0.75,
  });
}

function communityHubScore(entity: Entity, degreeById: Map<string, number>) {
  const typeBoost: Record<EntityType, number> = {
    project: 4.4,
    topic: 3.4,
    person: 2.4,
    event: 1.6,
  };
  return (degreeById.get(entity.id) ?? 0) * 7 + typeBoost[entity.type] + Math.log10(Math.max(entity.sourceEntries.length, 1));
}

function selectCommunityEntities(
  entities: Entity[],
  communityModel: CommunityModel,
  degreeById: Map<string, number>,
  maxCount: number,
) {
  const byCommunity = new Map<string, Entity[]>();
  for (const entity of entities) {
    const communityId = communityModel.assignment.get(entity.id) ?? entity.id;
    byCommunity.set(communityId, [...(byCommunity.get(communityId) ?? []), entity]);
  }

  const selected = new Map<string, Entity>();
  for (const hub of communityModel.hubs) {
    selected.set(hub.id, hub);
  }

  const sortedCommunities = communityModel.hubs
    .slice()
    .sort((a, b) => (byCommunity.get(b.id)?.length ?? 0) - (byCommunity.get(a.id)?.length ?? 0));
  let cursor = 0;
  while (selected.size < Math.min(maxCount, entities.length) && sortedCommunities.length > 0) {
    const hub = sortedCommunities[cursor % sortedCommunities.length];
    const members = (byCommunity.get(hub.id) ?? [])
      .filter((entity) => !selected.has(entity.id))
      .sort(
        (a, b) =>
          (communityModel.weightToHub.get(b.id) ?? 0) - (communityModel.weightToHub.get(a.id) ?? 0) ||
          (degreeById.get(b.id) ?? 0) - (degreeById.get(a.id) ?? 0) ||
          b.updatedAt - a.updatedAt,
      );
    if (members[0]) selected.set(members[0].id, members[0]);
    sortedCommunities.splice(cursor % sortedCommunities.length, members.length > 1 ? 0 : 1);
    if (sortedCommunities.length === 0) break;
    cursor += 1;
  }

  return [...selected.values()];
}

function runCommunityLayout(
  entities: Entity[],
  relationships: Relationship[],
  degreeById: Map<string, number>,
  communityModel: CommunityModel,
  salt: number,
  nodeOverrides: Record<string, NodeOverride>,
): { nodes: SceneNode[]; communities: GraphCommunity[] } {
  const width = GRAPH_WIDTH;
  const height = GRAPH_HEIGHT;
  const centerX = width / 2;
  const centerY = height / 2;
  const selectedIds = new Set(entities.map((entity) => entity.id));
  const visibleHubs = communityModel.hubs.filter((hub) => selectedIds.has(hub.id));
  const communityCenters = placeCommunityCenters(visibleHubs, entities, relationships, communityModel, salt);
  const membersByCommunity = new Map<string, Entity[]>();
  for (const entity of entities) {
    const communityId = communityModel.assignment.get(entity.id) ?? entity.id;
    membersByCommunity.set(communityId, [...(membersByCommunity.get(communityId) ?? []), entity]);
  }

  const nodes: LayoutNode[] = entities.map((entity) => {
    const communityId = communityModel.assignment.get(entity.id) ?? entity.id;
    const hub = communityCenters.get(communityId) ?? { x: centerX, y: centerY, z: 0, rank: 0 };
    const members = membersByCommunity.get(communityId) ?? [];
    const sortedMembers = members
      .filter((member) => member.id !== communityId)
      .sort(
        (a, b) =>
          (communityModel.weightToHub.get(b.id) ?? 0) - (communityModel.weightToHub.get(a.id) ?? 0) ||
          (degreeById.get(b.id) ?? 0) - (degreeById.get(a.id) ?? 0),
      );
    const memberIndex = Math.max(0, sortedMembers.findIndex((member) => member.id === entity.id));
    const isCommunityHub = entity.id === communityId;
    const tightness = communityModel.weightToHub.get(entity.id) ?? 0;
    const ring = isCommunityHub ? 0 : Math.floor(memberIndex / 8) + 1;
    const slot = isCommunityHub ? 0 : memberIndex % 8;
    const slotCount = Math.min(9 + ring * 4, Math.max(6, sortedMembers.length - (ring - 1) * 8));
    const angle =
      ((slot + (hashCode(`${communityId}:${salt}`) % 12) / 12) / Math.max(slotCount, 1)) * Math.PI * 2 +
      ring * 0.42;
    const orbit = isCommunityHub ? 0 : 66 + ring * 50 - Math.min(28, tightness * 5);
    const ellipse = 0.72 + (hashCode(`${entity.id}:ellipse`) % 18) / 100;
    return {
      entity,
      x: hub.x + Math.cos(angle) * orbit,
      y: hub.y + Math.sin(angle) * orbit * ellipse,
      z: hub.z + ((hashCode(`${entity.id}:z:${salt}`) % 190) - 95) * (isCommunityHub ? 0.25 : 0.62),
      vx: 0,
      vy: 0,
      degree: degreeById.get(entity.id) ?? 0,
      communityId,
      communityRank: ring,
      communityWeight: tightness,
      isCommunityHub,
      phase: (hashCode(`${entity.id}:phase`) % 628) / 100,
      drift: 2.4 + (hashCode(`${entity.id}:drift`) % 34) / 10,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.entity.id, node]));

  for (let step = 0; step < 260; step += 1) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distanceSq = Math.max(dx * dx + dy * dy, 64);
        const sameCommunity = left.communityId === right.communityId;
        const minDistance = layoutCollisionDistance(left, right);
        const overlap = minDistance - Math.sqrt(distanceSq);
        if (overlap <= 0 && !sameCommunity) continue;
        const collisionBoost = overlap > 0 ? (sameCommunity ? 9.4 : 14.2) : 0.18;
        const force = (7200 * collisionBoost) / distanceSq;
        const distance = Math.sqrt(distanceSq);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        left.vx -= fx;
        left.vy -= fy;
        right.vx += fx;
        right.vy += fy;
        if (overlap > 0) {
          const leftMobility = layoutNodeMobility(left);
          const rightMobility = layoutNodeMobility(right);
          const mobilityTotal = leftMobility + rightMobility;
          const push = overlap * (sameCommunity ? 0.052 : 0.076);
          left.vx -= (dx / distance) * push * (leftMobility / mobilityTotal);
          left.vy -= (dy / distance) * push * (leftMobility / mobilityTotal);
          right.vx += (dx / distance) * push * (rightMobility / mobilityTotal);
          right.vy += (dy / distance) * push * (rightMobility / mobilityTotal);
        }
      }
    }

    for (const relationship of relationships) {
      const from = nodeById.get(relationship.from);
      const to = nodeById.get(relationship.to);
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const sameCommunity = from.communityId === to.communityId;
      if (!sameCommunity) continue;
      const desired = 76 + Math.max(from.communityRank, to.communityRank) * 18;
      const force = (distance - desired) * 0.011 * relationshipStrength(relationship);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      from.vx += fx;
      from.vy += fy;
      to.vx -= fx;
      to.vy -= fy;
    }

    for (const node of nodes) {
      const hub = communityCenters.get(node.communityId) ?? { x: centerX, y: centerY };
      const anchorStrength = node.isCommunityHub ? 0.038 : 0.018;
      node.vx += (hub.x - node.x) * anchorStrength;
      node.vy += (hub.y - node.y) * anchorStrength;
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= 0.66;
      node.vy *= 0.66;
      node.x = clamp(node.x, 64, width - 64);
      node.y = clamp(node.y, 68, height - 76);
    }
  }

  let fittedNodes = fitLayoutToViewport(
    nodes.map(({ entity, x, y, z, degree, communityId, communityRank, communityWeight, isCommunityHub, phase, drift }) => ({
      entity,
      x,
      y,
      z,
      degree,
      communityId,
      communityRank,
      communityWeight,
      isCommunityHub,
      phase,
      drift,
    })),
    width,
    height,
  );
  for (let pass = 0; pass < 5; pass += 1) {
    fittedNodes = keepMembersNearCommunityHubs(fittedNodes, width, height);
    fittedNodes = relaxNodeCollisions(fittedNodes, width, height);
  }
  fittedNodes = keepMembersNearCommunityHubs(fittedNodes, width, height);
  fittedNodes = repelForeignCommunityIntrusions(fittedNodes, width, height);

  const fittedNodeById = new Map(fittedNodes.map((node) => [node.entity.id, node]));
  const communities = visibleHubs
    .map((hub) => {
      const hubNode = fittedNodeById.get(hub.id);
      if (!hubNode) return undefined;
      const memberNodes = fittedNodes.filter((node) => node.communityId === hub.id);
      const communityInfo = communityModel.communityByHubId.get(hub.id);
      const radius = clamp(
        Math.max(
          56,
          ...memberNodes.map((node) => Math.hypot(node.x - hubNode.x, node.y - hubNode.y) + nodeRadius(node.degree) + 16),
        ),
        66,
        152,
      );
      return {
        id: hub.id,
        hubId: hub.id,
        title: hub.title,
        type: hub.type,
        x: hubNode.x,
        y: hubNode.y,
        z: hubNode.z,
        radius,
        nodeCount: memberNodes.length,
        cohesion: communityInfo?.cohesion ?? 0,
        topNodeIds: communityInfo?.topNodeIds ?? [hub.id],
      };
    })
    .filter((community): community is GraphCommunity => Boolean(community));

  return {
    nodes: fittedNodes.map((node) => {
    const override = nodeOverrides[node.entity.id];
    return override ? { ...node, ...override } : node;
    }),
    communities,
  };
}

function placeCommunityCenters(
  hubs: Entity[],
  entities: Entity[],
  relationships: Relationship[],
  communityModel: CommunityModel,
  salt: number,
) {
  const centerX = GRAPH_WIDTH / 2;
  const centerY = GRAPH_HEIGHT * 0.5;
  const sizes = new Map<string, number>();
  for (const entity of entities) {
    const communityId = communityModel.assignment.get(entity.id);
    if (communityId) sizes.set(communityId, (sizes.get(communityId) ?? 0) + 1);
  }
  const sortedHubs = hubs
    .slice()
    .sort((a, b) => (sizes.get(b.id) ?? 0) - (sizes.get(a.id) ?? 0) || communityHubScore(b, new Map()) - communityHubScore(a, new Map()));
  const centers = new Map<string, { x: number; y: number; z: number; rank: number }>();
  const candidates = buildCommunityCenterCandidates(salt, Math.max(sortedHubs.length, 8));
  const communityLinkWeights = buildCommunityLinkWeights(relationships, communityModel.assignment);
  const placed: CommunityCenterPlacement[] = [];
  sortedHubs.forEach((hub) => {
    const nodeCount = sizes.get(hub.id) ?? 1;
    const radius = communityCenterRadius(nodeCount);
    const center = chooseSparseCommunityCenter(
      candidates,
      placed,
      communityLinkWeights,
      radius,
      nodeCount,
      centerX,
      centerY,
      hub.id,
    );
    const rank = Math.hypot(center.x - centerX, center.y - centerY) < GRAPH_WIDTH * 0.18 ? 0 : 1;
    centers.set(hub.id, {
      x: center.x,
      y: center.y,
      z: ((hashCode(`${hub.id}:community:z`) % 240) - 120) * 0.5,
      rank,
    });
    placed.push({ id: hub.id, x: center.x, y: center.y, radius, nodeCount });
  });
  return centers;
}

type CommunityCenterPlacement = {
  id: string;
  x: number;
  y: number;
  radius: number;
  nodeCount: number;
};

function buildCommunityCenterCandidates(salt: number, communityCount: number) {
  const centerX = GRAPH_WIDTH / 2;
  const centerY = GRAPH_HEIGHT * 0.5;
  const candidates: Array<{ x: number; y: number }> = [{ x: centerX, y: centerY }];
  const rings = [
    { count: Math.max(8, Math.min(12, communityCount + 2)), rx: GRAPH_WIDTH * 0.31, ry: GRAPH_HEIGHT * 0.27 },
    { count: Math.max(12, Math.min(18, communityCount + 8)), rx: GRAPH_WIDTH * 0.43, ry: GRAPH_HEIGHT * 0.38 },
  ];

  rings.forEach((ring, ringIndex) => {
    for (let index = 0; index < ring.count; index += 1) {
      const angle = (index / ring.count) * Math.PI * 2 + 0.34 + ringIndex * 0.21 + (salt % 11) * 0.014;
      candidates.push({
        x: centerX + Math.cos(angle) * ring.rx,
        y: centerY + Math.sin(angle) * ring.ry,
      });
    }
  });

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      candidates.push({
        x: 170 + column * ((GRAPH_WIDTH - 340) / 4),
        y: 126 + row * ((GRAPH_HEIGHT - 252) / 2),
      });
    }
  }

  return candidates;
}

function chooseSparseCommunityCenter(
  candidates: Array<{ x: number; y: number }>,
  placed: CommunityCenterPlacement[],
  communityLinkWeights: Map<string, Map<string, number>>,
  radius: number,
  nodeCount: number,
  centerX: number,
  centerY: number,
  hubId: string,
) {
  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const edgeRoom = Math.min(candidate.x - 84, GRAPH_WIDTH - 84 - candidate.x, candidate.y - 90, GRAPH_HEIGHT - 96 - candidate.y);
    if (edgeRoom < 0) continue;

    let score = edgeRoom * 0.72 - Math.hypot(candidate.x - centerX, candidate.y - centerY) * 0.18;
    score += (hashCode(`${hubId}:${candidate.x}:${candidate.y}`) % 19) * 0.1;
    for (const other of placed) {
      const distance = Math.max(Math.hypot(candidate.x - other.x, candidate.y - other.y), 1);
      const required = radius + other.radius + 38;
      const linkWeight = communityLinkWeights.get(hubId)?.get(other.id) ?? 0;
      score += Math.min(distance, required * 1.28) * 0.56;
      score += Math.min(linkWeight, 8) * Math.min(distance, required * 1.8) * 0.08;
      score -= (other.nodeCount / distance) * 420;
      if (distance < required) score -= (required - distance) * 8.6;
    }
    score -= communityLinePenalty(candidate, hubId, placed, communityLinkWeights);

    if (placed.length === 0 && nodeCount >= 2) {
      score -= Math.hypot(candidate.x - centerX, candidate.y - centerY) * 0.4;
    }

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function buildCommunityLinkWeights(relationships: Relationship[], assignment: Map<string, string>) {
  const weights = new Map<string, Map<string, number>>();
  for (const relationship of relationships) {
    const fromCommunity = assignment.get(relationship.from);
    const toCommunity = assignment.get(relationship.to);
    if (!fromCommunity || !toCommunity || fromCommunity === toCommunity) continue;
    addCommunityLinkWeight(weights, fromCommunity, toCommunity);
    addCommunityLinkWeight(weights, toCommunity, fromCommunity);
  }
  return weights;
}

function addCommunityLinkWeight(weights: Map<string, Map<string, number>>, from: string, to: string) {
  const links = weights.get(from) ?? new Map<string, number>();
  links.set(to, (links.get(to) ?? 0) + 1);
  weights.set(from, links);
}

function communityLinePenalty(
  candidate: { x: number; y: number },
  hubId: string,
  placed: CommunityCenterPlacement[],
  communityLinkWeights: Map<string, Map<string, number>>,
) {
  let penalty = 0;
  for (let leftIndex = 0; leftIndex < placed.length; leftIndex += 1) {
    const left = placed[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < placed.length; rightIndex += 1) {
      const right = placed[rightIndex];
      const linkWeight = communityLinkWeights.get(left.id)?.get(right.id) ?? 0;
      if (linkWeight <= 0) continue;
      const clearance = 34 + Math.min(24, linkWeight * 3);
      const distance = distanceToSegment(candidate, left, right);
      if (distance < clearance) penalty += (clearance - distance) * (7.5 + linkWeight);
    }
  }

  for (const linked of placed) {
    const linkWeight = communityLinkWeights.get(hubId)?.get(linked.id) ?? 0;
    if (linkWeight <= 0) continue;
    for (const other of placed) {
      if (other.id === linked.id) continue;
      const clearance = other.radius + 28;
      const distance = distanceToSegment(other, candidate, linked);
      if (distance < clearance) penalty += (clearance - distance) * (4.2 + linkWeight * 0.8);
    }
  }
  return penalty;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.001) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq, 0, 1);
  const x = start.x + dx * t;
  const y = start.y + dy * t;
  return Math.hypot(point.x - x, point.y - y);
}

function communityCenterRadius(nodeCount: number) {
  return clamp(130 + Math.sqrt(Math.max(nodeCount, 1)) * 26, 160, 270);
}

function layoutCollisionDistance(left: SceneNode, right: SceneNode) {
  const sameCommunity = left.communityId === right.communityId;
  const degreePadding = Math.min(left.degree + right.degree, 12) * (sameCommunity ? 1.15 : 1.6);
  const hubPadding = left.isCommunityHub || right.isCommunityHub ? 10 : 6;
  const communityPadding = sameCommunity ? 11 : 22;
  return nodeRadius(left.degree) + nodeRadius(right.degree) + hubPadding + communityPadding + degreePadding;
}

function layoutNodeMobility(node: SceneNode) {
  if (node.isCommunityHub) return 0.34;
  return clamp(1.18 - node.communityRank * 0.08 + Math.max(0, 5 - node.degree) * 0.025, 0.72, 1.28);
}

function keepMembersNearCommunityHubs(nodes: SceneNode[], width: number, height: number) {
  const next = nodes.map((node) => ({ ...node }));
  keepMembersNearCommunityHubsInPlace(next, width, height);
  return next;
}

function keepMembersNearCommunityHubsInPlace(nodes: SceneNode[], width: number, height: number) {
  const hubs = new Map(nodes.filter((node) => node.isCommunityHub).map((node) => [node.communityId, node]));
  const counts = communityCounts(nodes);
  for (const node of nodes) {
    if (node.isCommunityHub) continue;
    const hub = hubs.get(node.communityId);
    if (!hub) continue;
    const dx = node.x - hub.x;
    const dy = node.y - hub.y;
    const distance = Math.max(Math.hypot(dx, dy), 1);
    const maxDistance = communityMemberMaxDistance(node, counts.get(node.communityId) ?? 1);
    const preferredDistance = maxDistance * 0.72;
    if (distance > maxDistance) {
      node.x = hub.x + (dx / distance) * maxDistance;
      node.y = hub.y + (dy / distance) * maxDistance;
    } else if (distance > preferredDistance) {
      const pull = (distance - preferredDistance) * 0.18;
      node.x -= (dx / distance) * pull;
      node.y -= (dy / distance) * pull;
    }
    const padding = nodeRadius(node.degree) + 18;
    node.x = clamp(node.x, padding, width - padding);
    node.y = clamp(node.y, padding, height - padding);
  }
}

function repelForeignCommunityIntrusionsInPlace(nodes: SceneNode[], width: number, height: number) {
  const hubs = new Map(nodes.filter((node) => node.isCommunityHub).map((node) => [node.communityId, node]));
  const counts = communityCounts(nodes);
  let moved = false;
  for (const node of nodes) {
    const ownHub = hubs.get(node.communityId);
    for (const [communityId, foreignHub] of hubs) {
      if (communityId === node.communityId) continue;
      let dx = node.x - foreignHub.x;
      let dy = node.y - foreignHub.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.01) {
        const angle = ((hashCode(`${node.entity.id}:${communityId}:foreign`) % 628) / 100) * Math.PI;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }
      const territory = communityTerritoryRadius(counts.get(communityId) ?? 1);
      const minDistance = territory + nodeRadius(node.degree) + (node.isCommunityHub ? 18 : 12);
      if (distance >= minDistance) continue;

      const ownDistance = ownHub ? Math.hypot(node.x - ownHub.x, node.y - ownHub.y) : Number.POSITIVE_INFINITY;
      const strength = node.isCommunityHub ? 0.22 : ownDistance > distance ? 0.92 : 0.58;
      const push = (minDistance - distance) * strength;
      node.x += (dx / distance) * push;
      node.y += (dy / distance) * push;
      moved = true;
    }
    const padding = nodeRadius(node.degree) + 18;
    node.x = clamp(node.x, padding, width - padding);
    node.y = clamp(node.y, padding, height - padding);
  }
  return moved;
}

function repelForeignCommunityIntrusions(nodes: SceneNode[], width: number, height: number) {
  const next = nodes.map((node) => ({ ...node }));
  repelForeignCommunityIntrusionsInPlace(next, width, height);
  return next;
}

function communityCounts(nodes: SceneNode[]) {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.communityId, (counts.get(node.communityId) ?? 0) + 1);
  }
  return counts;
}

function communityMemberMaxDistance(node: SceneNode, communityNodeCount: number) {
  return clamp(
    110 + Math.sqrt(Math.max(communityNodeCount, 1)) * 24 + Math.min(node.communityRank, 4) * 28,
    150,
    280,
  );
}

function communityTerritoryRadius(communityNodeCount: number) {
  return clamp(84 + Math.sqrt(Math.max(communityNodeCount, 1)) * 24, 128, 220);
}

function relaxNodeCollisions(nodes: SceneNode[], width: number, height: number) {
  const relaxed = nodes.map((node) => ({ ...node }));
  if (relaxed.length <= 1) return relaxed;

  for (let step = 0; step < 180; step += 1) {
    let moved = false;
    for (let leftIndex = 0; leftIndex < relaxed.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < relaxed.length; rightIndex += 1) {
        const left = relaxed[leftIndex];
        const right = relaxed[rightIndex];
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          const angle = ((hashCode(`${left.entity.id}:${right.entity.id}`) % 628) / 100) * Math.PI;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }

        const minDistance = layoutCollisionDistance(left, right);
        const overlap = minDistance - distance;
        if (overlap <= 0) continue;

        const leftMobility = layoutNodeMobility(left);
        const rightMobility = layoutNodeMobility(right);
        const mobilityTotal = leftMobility + rightMobility;
        const pushX = (dx / distance) * (overlap + 0.35);
        const pushY = (dy / distance) * (overlap + 0.35);
        left.x -= pushX * (leftMobility / mobilityTotal);
        left.y -= pushY * (leftMobility / mobilityTotal);
        right.x += pushX * (rightMobility / mobilityTotal);
        right.y += pushY * (rightMobility / mobilityTotal);
        moved = true;
      }
    }

    keepMembersNearCommunityHubsInPlace(relaxed, width, height);
    repelForeignCommunityIntrusionsInPlace(relaxed, width, height);
    for (const node of relaxed) {
      const padding = nodeRadius(node.degree) + 18;
      node.x = clamp(node.x, padding, width - padding);
      node.y = clamp(node.y, padding, height - padding);
    }
    if (!moved) break;
  }

  return relaxed;
}

function fitLayoutToViewport(nodes: SceneNode[], width: number, height: number) {
  if (nodes.length <= 1) return nodes;

  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y));
  const spreadX = Math.max(maxX - minX, 1);
  const spreadY = Math.max(maxY - minY, 1);
  const paddingX = 95;
  const paddingY = 96;
  const scale = Math.min(
    1.85,
    (width - paddingX * 2) / spreadX,
    (height - paddingY * 2) / spreadY,
  );
  const graphCenterX = minX + spreadX / 2;
  const graphCenterY = minY + spreadY / 2;

  return nodes.map((node) => ({
    ...node,
    x: width / 2 + (node.x - graphCenterX) * scale,
    y: height * 0.48 + (node.y - graphCenterY) * scale,
    z: node.z * 1.08,
  }));
}

function projectGraphScene(
  scene: GraphScene,
  rotation: Rotation,
  time: number,
  zoom: number,
  viewMode: GraphViewMode,
  offset: GraphOffset,
): ProjectedScene {
  const projectedNodes = relaxProjectedNodeCollisions(
    scene.nodes
      .map((node) => projectNode(node, rotation, time, zoom, viewMode, offset))
      .sort((a, b) => a.depth - b.depth),
  );
  const projectedById = new Map(projectedNodes.map((node) => [node.node.entity.id, node]));
  const links = scene.links
    .map((link) => {
      const from = projectedById.get(link.from.entity.id);
      const to = projectedById.get(link.to.entity.id);
      if (!from || !to) return undefined;
      return {
        relationship: link.relationship,
        from,
        to,
        weight: link.weight,
        sameCommunity: link.sameCommunity,
        crossCommunity: !link.sameCommunity,
        opacity: viewMode === 'space'
          ? clamp(0.36 + (from.scale + to.scale) * 0.17, 0.38, 0.78)
          : link.sameCommunity
            ? clamp(0.22 + link.weight * 0.055 + Math.min(link.from.degree + link.to.degree, 12) * 0.01, 0.24, 0.48)
            : clamp(0.26 + link.weight * 0.045, 0.28, 0.52),
      };
    })
    .filter((link): link is ProjectedLink => Boolean(link))
    .sort((a, b) => Number(a.sameCommunity) - Number(b.sameCommunity) || a.weight - b.weight);
  const communities = scene.communities.map((community) =>
    projectCommunity(community, rotation, zoom, viewMode, offset),
  );

  return {
    nodes: projectedNodes,
    links,
    communities,
    visibleLabelIds: buildVisibleLabelIds(projectedNodes, zoom, viewMode),
  };
}

function projectCommunity(
  community: GraphCommunity,
  rotation: Rotation,
  zoom: number,
  viewMode: GraphViewMode,
  offset: GraphOffset,
): ProjectedCommunity {
  const width = GRAPH_WIDTH;
  const height = GRAPH_HEIGHT;
  const centeredX = community.x - width / 2;
  const centeredY = community.y - height / 2;
  const centeredZ = community.z;

  if (viewMode === 'map') {
    return {
      ...community,
      projectedX: width / 2 + centeredX * zoom + offset.x,
      projectedY: height / 2 + centeredY * zoom + offset.y,
      projectedRadius: community.radius * zoom,
      opacity: clamp(0.02 + Math.min(community.nodeCount, 18) * 0.0012, 0.022, 0.045),
    };
  }

  const cosY = Math.cos(rotation.y);
  const sinY = Math.sin(rotation.y);
  const x1 = centeredX * cosY + centeredZ * sinY;
  const z1 = -centeredX * sinY + centeredZ * cosY;
  const cosX = Math.cos(rotation.x);
  const sinX = Math.sin(rotation.x);
  const y2 = centeredY * cosX - z1 * sinX;
  const z2 = centeredY * sinX + z1 * cosX;
  const perspective = 1080;
  const scale = clamp(perspective / (perspective - z2), 0.62, 1.42);
  return {
    ...community,
    projectedX: width / 2 + x1 * scale * zoom + offset.x,
    projectedY: height / 2 + y2 * scale * zoom + offset.y,
    projectedRadius: community.radius * scale * zoom,
    opacity: 0.03,
  };
}

function projectNode(
  node: SceneNode,
  rotation: Rotation,
  time: number,
  zoom: number,
  viewMode: GraphViewMode,
  offset: GraphOffset,
): ProjectedNode {
  const width = GRAPH_WIDTH;
  const height = GRAPH_HEIGHT;
  const floatStrength = viewMode === 'space' ? 1 : 0;
  const floatX = Math.sin(time * 0.75 + node.phase) * node.drift * floatStrength;
  const floatY = Math.cos(time * 0.64 + node.phase * 0.8) * node.drift * 0.72 * floatStrength;
  const floatZ = viewMode === 'space' ? Math.sin(time * 0.52 + node.phase * 1.4) * node.drift * 2.2 : 0;
  const centeredX = node.x - width / 2 + floatX;
  const centeredY = node.y - height / 2 + floatY;
  const centeredZ = node.z + floatZ;

  if (viewMode === 'map') {
    const radius = nodeRadius(node.degree) * clamp(Math.sqrt(zoom), 0.8, 1.18);
    return {
      node,
      x: width / 2 + centeredX * zoom + offset.x,
      y: height / 2 + centeredY * zoom + offset.y,
      radius,
      scale: 1,
      depth: node.degree,
      opacity: 0.95,
    };
  }

  const cosY = Math.cos(rotation.y);
  const sinY = Math.sin(rotation.y);
  const x1 = centeredX * cosY + centeredZ * sinY;
  const z1 = -centeredX * sinY + centeredZ * cosY;

  const cosX = Math.cos(rotation.x);
  const sinX = Math.sin(rotation.x);
  const y2 = centeredY * cosX - z1 * sinX;
  const z2 = centeredY * sinX + z1 * cosX;

  const perspective = 1080;
  const scale = clamp(perspective / (perspective - z2), 0.62, 1.42);
  const radius = nodeRadius(node.degree) * scale * clamp(Math.sqrt(zoom), 0.78, 1.2);

  return {
    node,
    x: width / 2 + x1 * scale * zoom + offset.x,
    y: height / 2 + y2 * scale * zoom + offset.y,
    radius,
    scale,
    depth: z2,
    opacity: clamp(0.5 + scale * 0.42, 0.62, 1),
  };
}

function nodeRadius(degree: number) {
  return Math.min(22, 9.5 + degree * 1.25);
}

function relaxProjectedNodeCollisions(nodes: ProjectedNode[]) {
  const relaxed = nodes.map((node) => ({ ...node }));
  if (relaxed.length <= 1) return relaxed;
  const hubs = new Map(relaxed.filter((node) => node.node.isCommunityHub).map((node) => [node.node.communityId, node]));
  const counts = projectedCommunityCounts(relaxed);

  for (let step = 0; step < 44; step += 1) {
    let moved = false;
    for (let leftIndex = 0; leftIndex < relaxed.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < relaxed.length; rightIndex += 1) {
        const left = relaxed[leftIndex];
        const right = relaxed[rightIndex];
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          const angle = ((hashCode(`${left.node.entity.id}:${right.node.entity.id}:projected`) % 628) / 100) * Math.PI;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }

        const minDistance = left.radius + right.radius + (left.node.isCommunityHub || right.node.isCommunityHub ? 18 : 14);
        const overlap = minDistance - distance;
        if (overlap <= 0) continue;

        const leftMobility = layoutNodeMobility(left.node);
        const rightMobility = layoutNodeMobility(right.node);
        const mobilityTotal = leftMobility + rightMobility;
        const pushX = (dx / distance) * (overlap + 0.2);
        const pushY = (dy / distance) * (overlap + 0.2);
        left.x -= pushX * (leftMobility / mobilityTotal);
        left.y -= pushY * (leftMobility / mobilityTotal);
        right.x += pushX * (rightMobility / mobilityTotal);
        right.y += pushY * (rightMobility / mobilityTotal);
        moved = true;
      }
    }
    if (keepProjectedMembersNearHubsInPlace(relaxed, hubs, counts)) moved = true;
    if (repelProjectedForeignCommunityIntrusionsInPlace(relaxed, hubs, counts)) moved = true;
    clampProjectedNodesInPlace(relaxed);
    if (!moved) break;
  }
  for (let step = 0; step < 48; step += 1) {
    const pulled = keepProjectedMembersNearHubsInPlace(relaxed, hubs, counts);
    const repelled = repelProjectedForeignCommunityIntrusionsInPlace(relaxed, hubs, counts);
    const separated = resolveProjectedPairCollisions(relaxed);
    clampProjectedNodesInPlace(relaxed);
    if (!pulled && !repelled && !separated) break;
  }

  return relaxed;
}

function clampProjectedNodesInPlace(nodes: ProjectedNode[]) {
  for (const node of nodes) {
    const padding = node.radius + (node.node.isCommunityHub ? 20 : 16);
    node.x = clamp(node.x, padding, GRAPH_WIDTH - padding);
    node.y = clamp(node.y, padding, GRAPH_HEIGHT - padding - 8);
  }
}

function resolveProjectedPairCollisions(nodes: ProjectedNode[]) {
  let moved = false;
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.01) {
        const angle = ((hashCode(`${left.node.entity.id}:${right.node.entity.id}:projected-final`) % 628) / 100) * Math.PI;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }

      const minDistance = left.radius + right.radius + (left.node.isCommunityHub || right.node.isCommunityHub ? 18 : 14);
      const overlap = minDistance - distance;
      if (overlap <= 0) continue;

      const leftMobility = layoutNodeMobility(left.node);
      const rightMobility = layoutNodeMobility(right.node);
      const mobilityTotal = leftMobility + rightMobility;
      const pushX = (dx / distance) * (overlap + 0.2);
      const pushY = (dy / distance) * (overlap + 0.2);
      left.x -= pushX * (leftMobility / mobilityTotal);
      left.y -= pushY * (leftMobility / mobilityTotal);
      right.x += pushX * (rightMobility / mobilityTotal);
      right.y += pushY * (rightMobility / mobilityTotal);
      moved = true;
    }
  }
  return moved;
}

function repelProjectedForeignCommunityIntrusionsInPlace(
  nodes: ProjectedNode[],
  hubs: Map<string, ProjectedNode>,
  counts: Map<string, number>,
) {
  let moved = false;
  for (const node of nodes) {
    const ownHub = hubs.get(node.node.communityId);
    for (const [communityId, foreignHub] of hubs) {
      if (communityId === node.node.communityId) continue;
      let dx = node.x - foreignHub.x;
      let dy = node.y - foreignHub.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.01) {
        const angle = ((hashCode(`${node.node.entity.id}:${communityId}:projected-foreign`) % 628) / 100) * Math.PI;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }
      const territory = communityTerritoryRadius(counts.get(communityId) ?? 1) * clamp(foreignHub.scale, 0.82, 1.22);
      const minDistance = territory + node.radius + (node.node.isCommunityHub ? 18 : 12);
      if (distance >= minDistance) continue;

      const ownDistance = ownHub ? Math.hypot(node.x - ownHub.x, node.y - ownHub.y) : Number.POSITIVE_INFINITY;
      const strength = node.node.isCommunityHub ? 0.18 : ownDistance > distance ? 0.88 : 0.54;
      const push = (minDistance - distance) * strength;
      node.x += (dx / distance) * push;
      node.y += (dy / distance) * push;
      moved = true;
    }
  }
  return moved;
}

function keepProjectedMembersNearHubsInPlace(
  nodes: ProjectedNode[],
  hubs: Map<string, ProjectedNode>,
  counts: Map<string, number>,
) {
  let moved = false;
  for (const node of nodes) {
    if (node.node.isCommunityHub) continue;
    const hub = hubs.get(node.node.communityId);
    if (!hub) continue;
    const dx = node.x - hub.x;
    const dy = node.y - hub.y;
    const distance = Math.max(Math.hypot(dx, dy), 1);
    const maxDistance = communityMemberMaxDistance(node.node, counts.get(node.node.communityId) ?? 1) * clamp(node.scale, 0.82, 1.22);
    const preferredDistance = maxDistance * 0.72;
    if (distance > maxDistance) {
      node.x = hub.x + (dx / distance) * maxDistance;
      node.y = hub.y + (dy / distance) * maxDistance;
      moved = true;
    } else if (distance > preferredDistance) {
      const pull = (distance - preferredDistance) * 0.12;
      node.x -= (dx / distance) * pull;
      node.y -= (dy / distance) * pull;
      moved = true;
    }
  }
  return moved;
}

function projectedCommunityCounts(nodes: ProjectedNode[]) {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.node.communityId, (counts.get(node.node.communityId) ?? 0) + 1);
  }
  return counts;
}

function buildVisibleLabelIds(nodes: ProjectedNode[], zoom: number, viewMode: GraphViewMode) {
  const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const nodeBoxes = nodes.map((node) => ({
    id: node.node.entity.id,
    left: node.x - node.radius - 18,
    right: node.x + node.radius + 18,
    top: node.y - node.radius - 18,
    bottom: node.y + node.radius + 18,
  }));
  const visible = new Set<string>();
  const maxLabels = viewMode === 'map'
    ? zoom >= 1.35 ? 74 : zoom >= 1.08 ? 54 : 38
    : zoom >= 1.45 ? 72 : zoom >= 1.15 ? 46 : 28;
  const candidates = nodes
    .filter((node) => node.x > 24 && node.x < GRAPH_WIDTH - 24 && node.y > 24 && node.y < GRAPH_HEIGHT - 38)
    .filter((node) =>
      viewMode === 'map'
        ? node.node.isCommunityHub || zoom >= 1.22 || node.node.degree >= 4
        : zoom >= 1.35 || node.node.degree >= 4 || (node.scale > 1.08 && node.node.degree >= 2),
    )
    .sort(
      (a, b) =>
        Number(b.node.isCommunityHub) - Number(a.node.isCommunityHub) ||
        b.node.degree - a.node.degree ||
        b.scale - a.scale ||
        b.node.entity.updatedAt - a.node.entity.updatedAt,
    );

  for (const node of candidates) {
    if (visible.size >= maxLabels) break;
    const label = shortTitle(node.node.entity.title);
    const width = Math.min(150, Math.max(58, label.length * 9));
    const box = {
      left: node.x - width / 2,
      right: node.x + width / 2,
      top: node.y + node.radius + 2,
      bottom: node.y + node.radius + 30,
    };
    if (box.left < 6 || box.right > GRAPH_WIDTH - 6 || box.bottom > GRAPH_HEIGHT - 8) continue;
    if (boxes.some((other) => intersects(box, other))) continue;
    if (nodeBoxes.some((other) => other.id !== node.node.entity.id && intersects(box, other))) continue;
    boxes.push(box);
    visible.add(node.node.entity.id);
  }

  return visible;
}

function buildLinkPath(link: ProjectedLink) {
  const x1 = link.from.x;
  const y1 = link.from.y;
  const x2 = link.to.x;
  const y2 = link.to.y;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  if (link.sameCommunity && distance < 145) return `M ${x1} ${y1} L ${x2} ${y2}`;

  const normalX = -dy / distance;
  const normalY = dx / distance;
  const sign = hashCode(link.relationship.id) % 2 === 0 ? 1 : -1;
  const bend = link.sameCommunity
    ? clamp(distance * 0.08, 8, 28)
    : clamp(distance * 0.16, 32, 96);
  const controlX = (x1 + x2) / 2 + normalX * bend * sign;
  const controlY = (y1 + y2) / 2 + normalY * bend * sign;
  return `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`;
}

function relationshipStrength(relationship: Relationship) {
  const weights: Partial<Record<Relationship['type'], number>> = {
    owner: 4.6,
    participant: 4,
    stakeholder: 3.6,
    'decision-maker': 4,
    attendee: 3,
    organizer: 3.4,
    'depends-on': 3.8,
    about: 3.2,
    'relevant-to': 2.7,
    'related-to': 2.2,
    mentions: 1.3,
    'mentioned-in': 1.3,
    colleague: 2.6,
    friend: 2.4,
    family: 3.5,
    mentor: 3,
    'reports-to': 3.2,
    'parent-of': 3.4,
    'kicked-off': 3,
  };
  return weights[relationship.type] ?? 2;
}

function intersects(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function shortTitle(title: string, maxLength = 13) {
  return title.length > maxLength ? `${title.slice(0, maxLength - 1)}...` : title;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hashCode(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
