import { RotateCcw } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { relationshipTypeLabel } from '@/lib/graph/answer';
import type { Entity, Relationship } from '@/types';

type RelationshipGraphProps = {
  centerEntity: Entity;
  relationships: Relationship[];
  entities: Entity[];
  depth?: number;
  onDepthChange?: (depth: number) => void;
};

type GraphNode = {
  entity: Entity;
  x: number;
  y: number;
  degree: number;
  depth: number;
  isCenter: boolean;
};

type GraphLink = {
  relationship: Relationship;
  from: GraphNode;
  to: GraphNode;
};

type GraphLayout = {
  nodes: GraphNode[];
  links: GraphLink[];
  omittedNodeCount: number;
};

type NodeOverride = {
  x: number;
  y: number;
};

type DragState = {
  nodeId: string;
  pointerId: number;
  lastPoint: { x: number; y: number };
};

const graphWidth = 1000;
const graphHeight = 460;
const maxVisibleNodes = 46;

const typeColors: Record<Entity['type'], string> = {
  person: '#16a34a',
  project: '#2563eb',
  event: '#64748b',
  topic: '#d9a400',
};

const typeLabels: Record<Entity['type'], string> = {
  person: '人物',
  project: '事项',
  event: '互动',
  topic: '主题',
};

export function RelationshipGraph({
  centerEntity,
  relationships,
  entities,
  depth,
  onDepthChange,
}: RelationshipGraphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodeWasDraggedRef = useRef(false);
  const [layoutSalt, setLayoutSalt] = useState(0);
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, NodeOverride>>({});
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const layout = useMemo(
    () => buildLocalGraphLayout(centerEntity, entities, relationships, layoutSalt, nodeOverrides),
    [centerEntity, entities, relationships, layoutSalt, nodeOverrides],
  );
  const highlightedNodeIds = useMemo(
    () => buildHighlightedNodeIds(layout, hoveredNodeId),
    [layout, hoveredNodeId],
  );
  const hoveredNode = hoveredNodeId ? layout.nodes.find((node) => node.entity.id === hoveredNodeId) : undefined;

  if (relationships.length === 0) {
    return (
      <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
        <div className="border-b border-[#e5e5e4] pb-3">
          <h3 className="text-sm font-semibold text-[#1f2937]">关系网络</h3>
        </div>
        <p className="pt-5 text-sm text-[#626965]">暂无可视化关系。</p>
      </section>
    );
  }

  function handleResetLayout() {
    setLayoutSalt((value) => value + 1);
    setNodeOverrides({});
  }

  function handleNodePointerDown(event: ReactPointerEvent<SVGGElement>, node: GraphNode) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    nodeWasDraggedRef.current = false;
    svgRef.current?.setPointerCapture(event.pointerId);
    setDragState({
      nodeId: node.entity.id,
      pointerId: event.pointerId,
      lastPoint: getSvgPoint(event),
    });
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    const point = getSvgPoint(event);
    const dx = point.x - dragState.lastPoint.x;
    const dy = point.y - dragState.lastPoint.y;
    if (Math.abs(dx) + Math.abs(dy) > 1.4) {
      nodeWasDraggedRef.current = true;
    }
    const currentNode = layout.nodes.find((node) => node.entity.id === dragState.nodeId);
    if (!currentNode) return;

    setNodeOverrides((current) => {
      const base = current[dragState.nodeId] ?? {
        x: currentNode.x,
        y: currentNode.y,
      };
      return {
        ...current,
        [dragState.nodeId]: {
          x: clamp(base.x + dx, 48, graphWidth - 48),
          y: clamp(base.y + dy, 48, graphHeight - 54),
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
      x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * graphWidth,
      y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * graphHeight,
    };
  }

  return (
    <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e5e4] pb-3">
        <div>
          <h3 className="text-sm font-semibold text-[#1f2937]">关系网络</h3>
          <p className="mt-1 text-xs text-[#626965]">
            {layout.nodes.length} 个节点 / {layout.links.length} 条关系
            {layout.omittedNodeCount > 0 ? ` / 已折叠 ${layout.omittedNodeCount} 个远端节点` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onDepthChange && depth ? (
            <div className="rounded-full border border-[#d9d9d6] bg-[#f7f7f5] p-1">
              {[1, 2, 3].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onDepthChange(value)}
                  className={[
                    'rounded-full px-2.5 py-1 text-xs transition',
                    depth === value ? 'bg-white text-[#155eef] shadow-sm' : 'text-[#626965] hover:text-[#155eef]',
                  ].join(' ')}
                >
                  {value} 跳
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            onClick={handleResetLayout}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#d9d9d6] bg-white px-3 py-1.5 text-xs text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
          >
            <RotateCcw size={13} />
            重排
          </button>
        </div>
      </div>

      <div className="relative mt-4 overflow-hidden rounded-[10px] border border-[#eeeeed] bg-[#fbfbfa]">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${graphWidth} ${graphHeight}`}
          role="img"
          aria-label={`${centerEntity.title} 的关系网络`}
          className="mywiki-local-graph h-[380px] w-full"
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <defs>
            <pattern id="local-graph-grid" width="36" height="36" patternUnits="userSpaceOnUse">
              <path d="M 36 0 L 0 0 0 36" fill="none" stroke="rgba(148, 163, 184, 0.1)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={graphWidth} height={graphHeight} fill="#fbfbfa" />
          <rect width={graphWidth} height={graphHeight} fill="url(#local-graph-grid)" />

          {layout.links.map((link) => {
            const focused =
              !highlightedNodeIds ||
              link.from.entity.id === hoveredNodeId ||
              link.to.entity.id === hoveredNodeId;
            const showLabel = focused && (hoveredNodeId || layout.links.length <= 14);
            return (
              <g key={link.relationship.id} className="mywiki-local-link-group">
                <line
                  x1={link.from.x}
                  y1={link.from.y}
                  x2={link.to.x}
                  y2={link.to.y}
                  className="mywiki-local-link"
                  style={{ opacity: focused ? 0.72 : 0.11 }}
                />
                {showLabel ? (
                  <text
                    x={(link.from.x + link.to.x) / 2}
                    y={(link.from.y + link.to.y) / 2 - 7}
                    textAnchor="middle"
                    className="mywiki-local-edge-label"
                  >
                    {relationshipTypeLabel(link.relationship.type)}
                  </text>
                ) : null}
              </g>
            );
          })}

          {layout.nodes.map((node) => {
            const color = typeColors[node.entity.type];
            const focused = !highlightedNodeIds || highlightedNodeIds.has(node.entity.id);
            const isHovered = hoveredNodeId === node.entity.id;
            const label = shortTitle(node.entity.title, node.isCenter || isHovered ? 28 : 17);
            const radius = nodeRadius(node);
            return (
              <Link
                key={node.entity.id}
                to={`/wiki/${node.entity.type}/${node.entity.id}`}
                onClick={(event) => {
                  if (nodeWasDraggedRef.current) {
                    event.preventDefault();
                    nodeWasDraggedRef.current = false;
                  }
                }}
              >
                <g
                  className="mywiki-local-node"
                  style={{ opacity: focused ? 1 : 0.22 }}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
                  onPointerEnter={() => setHoveredNodeId(node.entity.id)}
                  onPointerLeave={() => setHoveredNodeId(null)}
                >
                  <circle cx={node.x} cy={node.y} r={radius + 16} fill="transparent" pointerEvents="all" />
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={radius + (node.isCenter ? 7 : 5)}
                    fill={color}
                    className="mywiki-local-node-halo"
                  />
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={radius}
                    fill={color}
                    stroke="#ffffff"
                    strokeWidth={node.isCenter ? 3 : 2.2}
                  />
                  <circle
                    cx={node.x - radius * 0.32}
                    cy={node.y - radius * 0.35}
                    r={Math.max(2.3, radius * 0.25)}
                    fill="#ffffff"
                    opacity="0.45"
                    pointerEvents="none"
                  />
                  <text
                    x={node.x}
                    y={node.y + radius + 18}
                    textAnchor="middle"
                    className={isHovered || node.isCenter ? 'mywiki-local-label mywiki-local-label-active' : 'mywiki-local-label'}
                  >
                    {label}
                  </text>
                </g>
              </Link>
            );
          })}
        </svg>

        {hoveredNode ? (
          <div
            className="pointer-events-none absolute max-w-[260px] rounded-[10px] border border-[#d9d9d6] bg-white/95 px-3 py-2 text-xs shadow-lg"
            style={{
              left: `${clamp((hoveredNode.x / graphWidth) * 100, 4, 74)}%`,
              top: `${clamp((hoveredNode.y / graphHeight) * 100 + 4, 8, 74)}%`,
            }}
          >
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ backgroundColor: typeColors[hoveredNode.entity.type] }} />
              <span className="font-semibold text-[#1f2937]">{hoveredNode.entity.title}</span>
              <span className="rounded-full border border-[#d9d9d6] px-1.5 py-0.5 text-[10px] text-[#626965]">
                {typeLabels[hoveredNode.entity.type]}
              </span>
            </div>
            <p className="mt-1.5 line-clamp-3 leading-5 text-[#626965]">
              {hoveredNode.entity.summary || '暂无摘要。'}
            </p>
            <p className="mt-1 text-[11px] text-[#8a908b]">
              {hoveredNode.isCenter ? '中心实体' : `${hoveredNode.depth} 跳关系`} / {hoveredNode.degree} 条连接
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function buildLocalGraphLayout(
  centerEntity: Entity,
  entities: Entity[],
  relationships: Relationship[],
  salt: number,
  nodeOverrides: Record<string, NodeOverride>,
): GraphLayout {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  entityById.set(centerEntity.id, centerEntity);

  const validRelationships = relationships.filter(
    (relationship) => entityById.has(relationship.from) && entityById.has(relationship.to),
  );
  const degreeById = new Map<string, number>();
  const depthById = computeDepths(centerEntity.id, validRelationships);

  for (const entity of entityById.values()) {
    degreeById.set(entity.id, 0);
  }
  for (const relationship of validRelationships) {
    degreeById.set(relationship.from, (degreeById.get(relationship.from) ?? 0) + 1);
    degreeById.set(relationship.to, (degreeById.get(relationship.to) ?? 0) + 1);
  }

  const selectedEntities = [...entityById.values()]
    .filter((entity) => depthById.has(entity.id))
    .sort((left, right) => {
      if (left.id === centerEntity.id) return -1;
      if (right.id === centerEntity.id) return 1;
      return (
        (depthById.get(left.id) ?? 99) - (depthById.get(right.id) ?? 99) ||
        (degreeById.get(right.id) ?? 0) - (degreeById.get(left.id) ?? 0) ||
        right.updatedAt - left.updatedAt
      );
    })
    .slice(0, maxVisibleNodes);
  const selectedIds = new Set(selectedEntities.map((entity) => entity.id));
  const selectedRelationships = validRelationships.filter(
    (relationship) => selectedIds.has(relationship.from) && selectedIds.has(relationship.to),
  );
  const nodes = runLocalForceLayout(selectedEntities, selectedRelationships, degreeById, depthById, centerEntity.id, salt)
    .map((node) => {
      const override = nodeOverrides[node.entity.id];
      return override ? { ...node, ...override } : node;
    });
  const nodeById = new Map(nodes.map((node) => [node.entity.id, node]));
  const links = selectedRelationships
    .map((relationship) => {
      const from = nodeById.get(relationship.from);
      const to = nodeById.get(relationship.to);
      return from && to ? { relationship, from, to } : undefined;
    })
    .filter((link): link is GraphLink => Boolean(link));

  return {
    nodes,
    links,
    omittedNodeCount: Math.max(0, entityById.size - selectedEntities.length),
  };
}

function computeDepths(centerId: string, relationships: Relationship[]) {
  const adjacency = new Map<string, string[]>();
  for (const relationship of relationships) {
    adjacency.set(relationship.from, [...(adjacency.get(relationship.from) ?? []), relationship.to]);
    adjacency.set(relationship.to, [...(adjacency.get(relationship.to) ?? []), relationship.from]);
  }

  const depths = new Map<string, number>([[centerId, 0]]);
  const queue = [centerId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentDepth = depths.get(currentId) ?? 0;
    for (const nextId of adjacency.get(currentId) ?? []) {
      if (depths.has(nextId)) continue;
      depths.set(nextId, currentDepth + 1);
      queue.push(nextId);
    }
  }
  return depths;
}

function runLocalForceLayout(
  entities: Entity[],
  relationships: Relationship[],
  degreeById: Map<string, number>,
  depthById: Map<string, number>,
  centerId: string,
  salt: number,
): GraphNode[] {
  const centerX = graphWidth / 2;
  const centerY = graphHeight / 2;
  const workingNodes = entities.map((entity, index) => {
    const depth = depthById.get(entity.id) ?? 1;
    const angle = ((index + salt * 5) / Math.max(entities.length, 1)) * Math.PI * 2 + (hashCode(entity.id) % 90) / 120;
    const radius = depth === 0 ? 0 : 110 + depth * 82 + (hashCode(entity.title) % 46);
    return {
      entity,
      x: entity.id === centerId ? centerX : centerX + Math.cos(angle) * radius,
      y: entity.id === centerId ? centerY : centerY + Math.sin(angle) * radius * 0.66,
      vx: 0,
      vy: 0,
      degree: degreeById.get(entity.id) ?? 0,
      depth,
      isCenter: entity.id === centerId,
    };
  });
  const nodeById = new Map(workingNodes.map((node) => [node.entity.id, node]));

  for (let step = 0; step < 220; step += 1) {
    for (let leftIndex = 0; leftIndex < workingNodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < workingNodes.length; rightIndex += 1) {
        const left = workingNodes[leftIndex];
        const right = workingNodes[rightIndex];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distanceSq = Math.max(dx * dx + dy * dy, 81);
        const minDistance = 58 + Math.min(left.degree + right.degree, 10) * 2.6;
        const collisionBoost = distanceSq < minDistance * minDistance ? 4.2 : 1;
        const force = (7800 * collisionBoost) / distanceSq;
        const distance = Math.sqrt(distanceSq);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        if (!left.isCenter) {
          left.vx -= fx;
          left.vy -= fy;
        }
        if (!right.isCenter) {
          right.vx += fx;
          right.vy += fy;
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
      const targetDistance = 118 + Math.max(from.depth, to.depth) * 32;
      const force = (distance - targetDistance) * 0.011;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      if (!from.isCenter) {
        from.vx += fx;
        from.vy += fy;
      }
      if (!to.isCenter) {
        to.vx -= fx;
        to.vy -= fy;
      }
    }

    for (const node of workingNodes) {
      if (node.isCenter) {
        node.x = centerX;
        node.y = centerY;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      const preferredRadius = 112 + node.depth * 82;
      const angle = Math.atan2(node.y - centerY, node.x - centerX);
      const shellX = centerX + Math.cos(angle) * preferredRadius;
      const shellY = centerY + Math.sin(angle) * preferredRadius * 0.66;
      node.vx += (shellX - node.x) * 0.0045;
      node.vy += (shellY - node.y) * 0.0045;
      node.vx += (centerX - node.x) * 0.0007;
      node.vy += (centerY - node.y) * 0.0007;
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= 0.7;
      node.vy *= 0.7;
      node.x = clamp(node.x, 48, graphWidth - 48);
      node.y = clamp(node.y, 50, graphHeight - 58);
    }
  }

  return workingNodes.map(({ entity, x, y, degree, depth, isCenter }) => ({
    entity,
    x,
    y,
    degree,
    depth,
    isCenter,
  }));
}

function buildHighlightedNodeIds(layout: GraphLayout, hoveredNodeId: string | null) {
  if (!hoveredNodeId) return undefined;
  const ids = new Set<string>([hoveredNodeId]);
  for (const link of layout.links) {
    if (link.from.entity.id === hoveredNodeId) ids.add(link.to.entity.id);
    if (link.to.entity.id === hoveredNodeId) ids.add(link.from.entity.id);
  }
  return ids;
}

function nodeRadius(node: GraphNode) {
  if (node.isCenter) return 16;
  return clamp(8.2 + node.degree * 0.9 + Math.max(0, 3 - node.depth) * 1.2, 8, 14);
}

function shortTitle(title: string, maxLength = 16) {
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
  return hash >>> 0;
}
