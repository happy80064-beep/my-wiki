import {
  Activity,
  AlertTriangle,
  GitBranch,
  Minus,
  Network,
  Plus,
  Radar,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { buildGraphOverview, relationshipTypeLabel, type GraphInsight } from '@/lib/graph';
import { db } from '@/lib/db';
import type { Entity, EntityType, Relationship, Scene } from '@/types';

type SceneNode = {
  entity: Entity;
  x: number;
  y: number;
  z: number;
  degree: number;
  phase: number;
  drift: number;
};

type SceneLink = {
  relationship: Relationship;
  from: SceneNode;
  to: SceneNode;
};

type GraphScene = {
  nodes: SceneNode[];
  links: SceneLink[];
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
  opacity: number;
};

type ProjectedScene = {
  nodes: ProjectedNode[];
  links: ProjectedLink[];
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

type TimeScope = 'all' | '30d' | '90d' | '365d';

type GraphFilters = {
  activeTypes: Set<EntityType>;
  activeScenes: Set<Scene>;
  changedAfter?: number;
};

type DragState =
  | {
      mode: 'rotate';
      pointerId: number;
      startX: number;
      startY: number;
      rotation: Rotation;
    }
  | {
      mode: 'node';
      pointerId: number;
      nodeId: string;
      lastPoint: { x: number; y: number };
    };

const entityTypes: EntityType[] = ['project', 'topic', 'person', 'event'];
const sceneTypes: Scene[] = ['work', 'life', 'social', 'personal'];

const entityTypeLabels: Record<EntityType, string> = {
  person: '人物',
  project: '事项',
  event: '互动',
  topic: '主题',
};

const sceneLabels: Record<Scene, string> = {
  work: '工作',
  life: '生活',
  social: '社交',
  personal: '个人',
};

const timeScopeLabels: Record<TimeScope, string> = {
  all: '全部时间',
  '30d': '30 天',
  '90d': '90 天',
  '365d': '一年',
};

const nodeColors: Record<EntityType, string> = {
  person: '#16a34a',
  project: '#2563eb',
  event: '#64748b',
  topic: '#d9a400',
};

const insightTypeLabels = {
  'bridge-node': '桥接',
  'knowledge-gap': '空白',
  'surprising-link': '连接',
  'dense-hub': '高密',
} as const;

const GRAPH_WIDTH = 1240;
const GRAPH_HEIGHT = 760;
const defaultRotation: Rotation = { x: -0.38, y: 0.44 };

export function GraphPage() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodeWasDraggedRef = useRef(false);
  const [layoutSalt, setLayoutSalt] = useState(0);
  const [rotation, setRotation] = useState<Rotation>(defaultRotation);
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, NodeOverride>>({});
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [floatTime, setFloatTime] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [activeTypes, setActiveTypes] = useState<Set<EntityType>>(() => new Set(entityTypes));
  const [activeScenes, setActiveScenes] = useState<Set<Scene>>(() => new Set(sceneTypes));
  const [timeScope, setTimeScope] = useState<TimeScope>('all');
  const entities = useLiveQuery(() => db.entities.toArray(), [], []);
  const relationships = useLiveQuery(() => db.relationships.toArray(), [], []);
  const dismissals = useLiveQuery(() => db.graphInsightDismissals.toArray(), [], []);
  const filters = useMemo<GraphFilters>(
    () => ({
      activeTypes,
      activeScenes,
      changedAfter: changedAfterForScope(timeScope),
    }),
    [activeTypes, activeScenes, timeScope],
  );
  const filteredEntities = useMemo(() => filterGraphEntities(entities, filters), [entities, filters]);
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
  const scene = useMemo(
    () => buildGraphScene(filteredEntities, filteredRelationships, layoutSalt, nodeOverrides),
    [filteredEntities, filteredRelationships, layoutSalt, nodeOverrides],
  );
  const projectedScene = useMemo(
    () => projectGraphScene(scene, rotation, floatTime, zoom),
    [scene, rotation, floatTime, zoom],
  );
  const highlightedNodeIds = useMemo(
    () => buildHighlightedNodeIds(scene, hoveredNodeId),
    [scene, hoveredNodeId],
  );

  useEffect(() => {
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
  }, []);

  function handleResetLayout() {
    setLayoutSalt((value) => value + 1);
    setNodeOverrides({});
    setRotation(defaultRotation);
    setZoom(1);
  }

  function toggleType(type: EntityType) {
    setActiveTypes((current) => {
      const next = new Set(current);
      if (next.has(type) && next.size > 1) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  function toggleScene(scene: Scene) {
    setActiveScenes((current) => {
      const next = new Set(current);
      if (next.has(scene) && next.size > 1) {
        next.delete(scene);
      } else {
        next.add(scene);
      }
      return next;
    });
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      mode: 'rotate',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rotation,
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
    event.currentTarget.releasePointerCapture(event.pointerId);
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
      type: insight.type,
      dismissedAt: Date.now(),
    });
  }

  return (
    <section className="mx-auto max-w-7xl px-5 py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#155eef]">Graph</p>
          <h2 className="mt-2 text-2xl font-semibold text-[#1f2937]">关系图谱</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setZoom((value) => clamp(value - 0.12, 0.62, 1.75))}
            className="inline-flex size-9 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
            title="缩小"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => clamp(value + 0.12, 0.62, 1.75))}
            className="inline-flex size-9 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
            title="放大"
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={handleResetLayout}
            className="inline-flex items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-4 py-2 text-sm font-medium text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
          >
            <RotateCcw size={16} />
            重排
          </button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.9fr)_minmax(320px,0.72fr)]">
        <section className="overflow-hidden rounded-[12px] border border-[#d9d9d6] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e5e4] px-5 py-4">
            <div className="flex items-center gap-3 text-[#1f2937]">
              <span className="flex size-9 items-center justify-center rounded-[10px] border border-[#d9d9d6] bg-[#f4f8ff] text-[#155eef]">
                <Network size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold">Knowledge Network</h3>
                <p className="text-xs text-[#626965]">
                  {scene.nodes.length}/{overview.entityCount} nodes / {scene.links.length}/{overview.relationshipCount} links / {Math.round(zoom * 100)}%
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {entityTypes.map((type) => (
                <FilterPill
                  key={type}
                  active={activeTypes.has(type)}
                  color={nodeColors[type]}
                  label={entityTypeLabels[type]}
                  onClick={() => toggleType(type)}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eeeeed] px-5 py-3">
            <div className="flex flex-wrap gap-2 text-xs">
              {sceneTypes.map((scene) => (
                <button
                  key={scene}
                  type="button"
                  onClick={() => toggleScene(scene)}
                  className={[
                    'rounded-full border px-2.5 py-1 transition',
                    activeScenes.has(scene)
                      ? 'border-[#155eef] bg-[#f4f8ff] text-[#155eef]'
                      : 'border-[#d9d9d6] bg-white text-[#626965]',
                  ].join(' ')}
                >
                  {sceneLabels[scene]}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {(Object.keys(timeScopeLabels) as TimeScope[]).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setTimeScope(scope)}
                  className={[
                    'rounded-full border px-2.5 py-1 transition',
                    timeScope === scope
                      ? 'border-[#155eef] bg-[#f4f8ff] text-[#155eef]'
                      : 'border-[#d9d9d6] bg-white text-[#626965]',
                  ].join(' ')}
                >
                  {timeScopeLabels[scope]}
                </button>
              ))}
            </div>
          </div>

          <div className="relative min-h-[640px] bg-[#fbfbfa]">
            {scene.nodes.length === 0 ? (
              <div className="flex min-h-[640px] items-center justify-center px-6 text-center text-sm text-[#626965]">
                当前筛选范围内没有可展示实体。可以放宽类型、场景或时间条件。
              </div>
            ) : (
              <svg
                ref={svgRef}
                viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                className="mywiki-tech-graph h-[640px] w-full cursor-grab active:cursor-grabbing"
                role="img"
                aria-label="MyWiki 关系图谱"
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                <defs>
                  <pattern id="graph-grid" width="42" height="42" patternUnits="userSpaceOnUse">
                    <path d="M 42 0 L 0 0 0 42" fill="none" stroke="rgba(148, 163, 184, 0.11)" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="#fbfbfa" />
                <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="url(#graph-grid)" />

                {projectedScene.links.map((link) => {
                  const focused =
                    !highlightedNodeIds ||
                    link.from.node.entity.id === hoveredNodeId ||
                    link.to.node.entity.id === hoveredNodeId;
                  return (
                    <g key={link.relationship.id}>
                      <line
                        x1={link.from.x}
                        y1={link.from.y}
                        x2={link.to.x}
                        y2={link.to.y}
                        className="mywiki-tech-link"
                        style={{ opacity: focused ? link.opacity : 0.08 }}
                      />
                      <title>
                        {link.from.node.entity.title} / {relationshipTypeLabel(link.relationship.type)} / {link.to.node.entity.title}
                      </title>
                    </g>
                  );
                })}

                {projectedScene.nodes.map((projected) => {
                  const node = projected.node;
                  const color = nodeColors[node.entity.type];
                  const focused = !highlightedNodeIds || highlightedNodeIds.has(node.entity.id);
                  const isHovered = hoveredNodeId === node.entity.id;
                  const showLabel = isHovered || projectedScene.visibleLabelIds.has(node.entity.id);
                  return (
                    <a
                      key={node.entity.id}
                      href={`/wiki/${node.entity.type}/${node.entity.id}`}
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
                        />
                        <circle
                          cx={projected.x}
                          cy={projected.y}
                          r={projected.radius}
                          fill={color}
                          stroke="#ffffff"
                          strokeWidth="2"
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
                            {isHovered ? shortTitle(node.entity.title, 24) : shortTitle(node.entity.title)}
                          </text>
                        ) : null}
                        <title>
                          {entityTypeLabels[node.entity.type]} / {node.entity.title} / {node.degree} links
                        </title>
                      </g>
                    </a>
                  );
                })}
              </svg>
            )}
          </div>
        </section>

        <aside className="space-y-5">
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
            <div className="flex items-center gap-2">
              <Radar size={17} className="text-[#155eef]" />
              <h3 className="text-sm font-semibold text-[#1f2937]">图谱洞察</h3>
            </div>
            {visibleInsights.length === 0 ? (
              <div className="mt-4 flex items-center gap-2 rounded-[10px] border border-[#d9d9d6] bg-[#fbfbfa] px-3 py-3 text-sm text-[#626965]">
                <Sparkles size={16} />
                暂无需要处理的洞察。
              </div>
            ) : (
              <div className="mt-4 grid gap-3">
                {visibleInsights.map((insight) => (
                  <article key={insight.id} className="rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-3">
                    <div className="flex items-start gap-2">
                      <InsightIcon type={insight.type} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-[#d9d9d6] bg-white px-2 py-0.5 text-[11px] text-[#155eef]">
                            {insightTypeLabels[insight.type]}
                          </span>
                          <h4 className="text-sm font-semibold text-[#1f2937]">{insight.title}</h4>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-[#626965]">{insight.detail}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {insight.entityIds.slice(0, 3).map((entityId) => {
                            const entity = entities.find((item) => item.id === entityId);
                            if (!entity) return null;
                            return (
                              <Link
                                key={entityId}
                                to={`/wiki/${entity.type}/${entity.id}`}
                                className="rounded-full border border-[#d9d9d6] bg-white px-2.5 py-1 text-xs text-[#155eef]"
                              >
                                {entity.title}
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void dismissInsight(insight)}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#626965] transition hover:border-[#155eef] hover:text-[#155eef]"
                        title="隐藏这条洞察"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

function FilterPill({
  active,
  color,
  label,
  onClick,
}: {
  active: boolean;
  color: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition',
        active ? 'border-[#155eef] bg-[#f4f8ff] text-[#155eef]' : 'border-[#d9d9d6] bg-[#fbfbfa] text-[#4b5563]',
      ].join(' ')}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: active ? color : '#c8c8c5' }} />
      {label}
    </button>
  );
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
  if (type === 'bridge-node') return <GitBranch size={16} className={className} />;
  if (type === 'dense-hub') return <Network size={16} className={className} />;
  return <Radar size={16} className={className} />;
}

function filterGraphEntities(entities: Entity[], filters: GraphFilters) {
  return entities.filter((entity) => {
    if (!filters.activeTypes.has(entity.type)) return false;
    if (filters.changedAfter && entity.updatedAt < filters.changedAfter) return false;
    if (filters.activeScenes.size === sceneTypes.length) return true;
    if (entity.scenes.length === 0) return filters.activeScenes.has('work');
    return entity.scenes.some((scene) => filters.activeScenes.has(scene));
  });
}

function changedAfterForScope(scope: TimeScope) {
  if (scope === 'all') return undefined;
  const days = scope === '30d' ? 30 : scope === '90d' ? 90 : 365;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function buildHighlightedNodeIds(scene: GraphScene, hoveredNodeId: string | null) {
  if (!hoveredNodeId) return undefined;
  const ids = new Set<string>([hoveredNodeId]);
  for (const link of scene.links) {
    if (link.from.entity.id === hoveredNodeId) ids.add(link.to.entity.id);
    if (link.to.entity.id === hoveredNodeId) ids.add(link.from.entity.id);
  }
  return ids;
}

function buildGraphScene(
  entities: Entity[],
  relationships: Relationship[],
  salt: number,
  nodeOverrides: Record<string, NodeOverride>,
): GraphScene {
  if (entities.length === 0) return { nodes: [], links: [] };

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

  const selectedEntities = entities
    .slice()
    .sort((a, b) => (degreeById.get(b.id) ?? 0) - (degreeById.get(a.id) ?? 0) || b.updatedAt - a.updatedAt)
    .slice(0, 80);
  const selectedIds = new Set(selectedEntities.map((entity) => entity.id));
  const selectedRelationships = validRelationships
    .filter((relationship) => selectedIds.has(relationship.from) && selectedIds.has(relationship.to))
    .slice(0, 140);

  const nodes = runForceLayout(selectedEntities, selectedRelationships, degreeById, salt, nodeOverrides);
  const nodeById = new Map(nodes.map((node) => [node.entity.id, node]));
  const links = selectedRelationships
    .map((relationship) => {
      const from = nodeById.get(relationship.from);
      const to = nodeById.get(relationship.to);
      return from && to ? { relationship, from, to } : undefined;
    })
    .filter((link): link is SceneLink => Boolean(link));

  return { nodes, links };
}

function runForceLayout(
  entities: Entity[],
  relationships: Relationship[],
  degreeById: Map<string, number>,
  salt: number,
  nodeOverrides: Record<string, NodeOverride>,
): SceneNode[] {
  const width = GRAPH_WIDTH;
  const height = GRAPH_HEIGHT;
  const centerX = width / 2;
  const centerY = height / 2;
  const typeAnchors: Record<EntityType, { x: number; y: number }> = {
    project: { x: width * 0.36, y: height * 0.4 },
    topic: { x: width * 0.66, y: height * 0.36 },
    person: { x: width * 0.32, y: height * 0.68 },
    event: { x: width * 0.68, y: height * 0.68 },
  };
  const nodes = entities.map((entity, index) => {
    const angle = ((index + salt * 3) / Math.max(entities.length, 1)) * Math.PI * 2;
    const radius = 220 + (hashCode(entity.id) % 150);
    return {
      entity,
      x: centerX + Math.cos(angle) * radius + (hashCode(entity.title) % 80) - 40,
      y: centerY + Math.sin(angle) * radius + (hashCode(entity.id + entity.title) % 70) - 35,
      z: ((hashCode(`${entity.id}:z:${salt}`) % 360) - 180) * 0.9,
      vx: 0,
      vy: 0,
      degree: degreeById.get(entity.id) ?? 0,
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
        const minDistance = 42 + Math.min(left.degree + right.degree, 12) * 2.6;
        const collisionBoost = distanceSq < minDistance * minDistance ? 4.8 : 1;
        const force = (9200 * collisionBoost) / distanceSq;
        const distance = Math.sqrt(distanceSq);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        left.vx -= fx;
        left.vy -= fy;
        right.vx += fx;
        right.vy += fy;
      }
    }

    for (const relationship of relationships) {
      const from = nodeById.get(relationship.from);
      const to = nodeById.get(relationship.to);
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const desired = 150 + Math.min(from.degree + to.degree, 12) * 2.5;
      const force = (distance - desired) * 0.0075;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      from.vx += fx;
      from.vy += fy;
      to.vx -= fx;
      to.vy -= fy;
    }

    for (const node of nodes) {
      const anchor = typeAnchors[node.entity.type];
      node.vx += (anchor.x - node.x) * 0.0024;
      node.vy += (anchor.y - node.y) * 0.0024;
      node.vx += (centerX - node.x) * 0.0007;
      node.vy += (centerY - node.y) * 0.0007;
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= 0.68;
      node.vy *= 0.68;
      node.x = clamp(node.x, 64, width - 64);
      node.y = clamp(node.y, 68, height - 76);
    }
  }

  const fittedNodes = fitLayoutToViewport(
    nodes.map(({ entity, x, y, z, degree, phase, drift }) => ({
      entity,
      x,
      y,
      z,
      degree,
      phase,
      drift,
    })),
    width,
    height,
  );

  return fittedNodes.map((node) => {
    const override = nodeOverrides[node.entity.id];
    return override ? { ...node, ...override } : node;
  });
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

function projectGraphScene(scene: GraphScene, rotation: Rotation, time: number, zoom: number): ProjectedScene {
  const projectedNodes = scene.nodes
    .map((node) => projectNode(node, rotation, time, zoom))
    .sort((a, b) => a.depth - b.depth);
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
        opacity: clamp(0.36 + (from.scale + to.scale) * 0.17, 0.38, 0.78),
      };
    })
    .filter((link): link is ProjectedLink => Boolean(link));

  return { nodes: projectedNodes, links, visibleLabelIds: buildVisibleLabelIds(projectedNodes, zoom) };
}

function projectNode(node: SceneNode, rotation: Rotation, time: number, zoom: number): ProjectedNode {
  const width = GRAPH_WIDTH;
  const height = GRAPH_HEIGHT;
  const floatX = Math.sin(time * 0.75 + node.phase) * node.drift;
  const floatY = Math.cos(time * 0.64 + node.phase * 0.8) * node.drift * 0.72;
  const floatZ = Math.sin(time * 0.52 + node.phase * 1.4) * node.drift * 2.2;
  const centeredX = node.x - width / 2 + floatX;
  const centeredY = node.y - height / 2 + floatY;
  const centeredZ = node.z + floatZ;

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
    x: width / 2 + x1 * scale * zoom,
    y: height / 2 + y2 * scale * zoom,
    radius,
    scale,
    depth: z2,
    opacity: clamp(0.5 + scale * 0.42, 0.62, 1),
  };
}

function nodeRadius(degree: number) {
  return Math.min(15.5, 6.5 + degree * 1.05);
}

function buildVisibleLabelIds(nodes: ProjectedNode[], zoom: number) {
  const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const visible = new Set<string>();
  const maxLabels = zoom >= 1.45 ? 72 : zoom >= 1.15 ? 46 : 28;
  const candidates = nodes
    .filter((node) => node.x > 24 && node.x < GRAPH_WIDTH - 24 && node.y > 24 && node.y < GRAPH_HEIGHT - 38)
    .filter((node) => zoom >= 1.35 || node.node.degree >= 4 || (node.scale > 1.08 && node.node.degree >= 2))
    .sort(
      (a, b) =>
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
      top: node.y + node.radius + 4,
      bottom: node.y + node.radius + 24,
    };
    if (box.left < 6 || box.right > GRAPH_WIDTH - 6 || box.bottom > GRAPH_HEIGHT - 8) continue;
    if (boxes.some((other) => intersects(box, other))) continue;
    boxes.push(box);
    visible.add(node.node.entity.id);
  }

  return visible;
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
