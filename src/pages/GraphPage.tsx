import { Activity, AlertTriangle, GitBranch, Network, Radar, RotateCcw, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { buildGraphOverview, relationshipTypeLabel } from '@/lib/graph';
import { db } from '@/lib/db';
import type { Entity, EntityType, Relationship } from '@/types';

type SceneNode = {
  entity: Entity;
  x: number;
  y: number;
  degree: number;
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

const entityTypeLabels: Record<EntityType, string> = {
  person: '人员',
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

const insightTypeLabels = {
  'bridge-node': '桥接',
  'knowledge-gap': '空白',
  'surprising-link': '连接',
  'dense-hub': '高密',
} as const;

export function GraphPage() {
  const [layoutSalt, setLayoutSalt] = useState(0);
  const entities = useLiveQuery(() => db.entities.toArray(), [], []);
  const relationships = useLiveQuery(() => db.relationships.toArray(), [], []);
  const overview = useMemo(() => buildGraphOverview(entities, relationships), [entities, relationships]);
  const scene = useMemo(() => buildGraphScene(entities, relationships, layoutSalt), [entities, relationships, layoutSalt]);

  return (
    <section className="mx-auto max-w-6xl px-5 py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#155eef]">Graph</p>
          <h2 className="mt-2 text-2xl font-semibold text-[#1f2937]">关系图谱</h2>
        </div>
        <button
          type="button"
          onClick={() => setLayoutSalt((value) => value + 1)}
          className="inline-flex items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-4 py-2 text-sm font-medium text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
        >
          <RotateCcw size={16} />
          重排
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
        <section className="overflow-hidden rounded-[12px] border border-[#d9d9d6] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e5e4] px-5 py-4">
            <div className="flex items-center gap-3 text-[#1f2937]">
              <span className="flex size-9 items-center justify-center rounded-[10px] border border-[#d9d9d6] bg-[#f4f8ff] text-[#155eef]">
                <Network size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold">Knowledge Network</h3>
                <p className="text-xs text-[#626965]">{overview.entityCount} nodes · {overview.relationshipCount} links</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <TypeLegend type="project" />
              <TypeLegend type="topic" />
              <TypeLegend type="person" />
              <TypeLegend type="event" />
            </div>
          </div>

          <div className="relative min-h-[520px] bg-[#fbfbfa]">
            {scene.nodes.length === 0 ? (
              <div className="flex min-h-[520px] items-center justify-center px-6 text-center text-sm text-[#626965]">
                暂无实体。先捕获一条材料后，图谱会在这里生成。
              </div>
            ) : (
              <svg viewBox="0 0 1000 620" className="mywiki-tech-graph h-[520px] w-full" role="img" aria-label="MyWiki 关系图谱">
                <defs>
                  <pattern id="graph-grid" width="42" height="42" patternUnits="userSpaceOnUse">
                    <path d="M 42 0 L 0 0 0 42" fill="none" stroke="rgba(148, 163, 184, 0.11)" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect width="1000" height="620" fill="#fbfbfa" />
                <rect width="1000" height="620" fill="url(#graph-grid)" />

                {scene.links.map((link) => (
                  <g key={link.relationship.id}>
                    <line
                      x1={link.from.x}
                      y1={link.from.y}
                      x2={link.to.x}
                      y2={link.to.y}
                      className="mywiki-tech-link"
                    />
                    <title>
                      {link.from.entity.title} · {relationshipTypeLabel(link.relationship.type)} · {link.to.entity.title}
                    </title>
                  </g>
                ))}

                {scene.nodes.map((node) => {
                  const color = nodeColors[node.entity.type];
                  const radius = nodeRadius(node.degree);
                  return (
                    <a key={node.entity.id} href={`/wiki/${node.entity.type}/${node.entity.id}`}>
                      <g className="mywiki-tech-node">
                        <circle cx={node.x} cy={node.y} r={radius + 6} stroke={color} className="mywiki-tech-node-ring" />
                        <circle cx={node.x} cy={node.y} r={radius} fill={color} stroke="#ffffff" strokeWidth="2" />
                        <text x={node.x} y={node.y + radius + 18} textAnchor="middle" className="mywiki-tech-label">
                          {shortTitle(node.entity.title)}
                        </text>
                        <title>
                          {entityTypeLabels[node.entity.type]} · {node.entity.title} · {node.degree} links
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
            {overview.insights.length === 0 ? (
              <div className="mt-4 flex items-center gap-2 rounded-[10px] border border-[#d9d9d6] bg-[#fbfbfa] px-3 py-3 text-sm text-[#626965]">
                <Sparkles size={16} />
                暂无需要处理的洞察。
              </div>
            ) : (
              <div className="mt-4 grid gap-3">
                {overview.insights.map((insight) => (
                  <article key={insight.id} className="rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-3">
                    <div className="flex items-start gap-2">
                      <InsightIcon type={insight.type} />
                      <div className="min-w-0">
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

function TypeLegend({ type }: { type: EntityType }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#d9d9d6] bg-[#fbfbfa] px-2.5 py-1 text-[#4b5563]">
      <span className="size-2 rounded-full" style={{ backgroundColor: nodeColors[type] }} />
      {entityTypeLabels[type]}
    </span>
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

function buildGraphScene(entities: Entity[], relationships: Relationship[], salt: number): GraphScene {
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

  const nodes = runForceLayout(selectedEntities, selectedRelationships, degreeById, salt);
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
): SceneNode[] {
  const width = 1000;
  const height = 620;
  const centerX = width / 2;
  const centerY = height / 2;
  const typeAnchors: Record<EntityType, { x: number; y: number }> = {
    project: { x: width * 0.42, y: height * 0.44 },
    topic: { x: width * 0.64, y: height * 0.42 },
    person: { x: width * 0.35, y: height * 0.64 },
    event: { x: width * 0.64, y: height * 0.66 },
  };
  const nodes = entities.map((entity, index) => {
    const angle = ((index + salt * 3) / Math.max(entities.length, 1)) * Math.PI * 2;
    const radius = 150 + (hashCode(entity.id) % 90);
    return {
      entity,
      x: centerX + Math.cos(angle) * radius + (hashCode(entity.title) % 80) - 40,
      y: centerY + Math.sin(angle) * radius + (hashCode(entity.id + entity.title) % 70) - 35,
      vx: 0,
      vy: 0,
      degree: degreeById.get(entity.id) ?? 0,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.entity.id, node]));

  for (let step = 0; step < 180; step += 1) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distanceSq = Math.max(dx * dx + dy * dy, 64);
        const force = 3800 / distanceSq;
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
      const desired = 120;
      const force = (distance - desired) * 0.012;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      from.vx += fx;
      from.vy += fy;
      to.vx -= fx;
      to.vy -= fy;
    }

    for (const node of nodes) {
      const anchor = typeAnchors[node.entity.type];
      node.vx += (anchor.x - node.x) * 0.004;
      node.vy += (anchor.y - node.y) * 0.004;
      node.vx += (centerX - node.x) * 0.0015;
      node.vy += (centerY - node.y) * 0.0015;
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= 0.72;
      node.vy *= 0.72;
      node.x = clamp(node.x, 70, width - 70);
      node.y = clamp(node.y, 70, height - 80);
    }
  }

  return fitLayoutToViewport(nodes.map(({ entity, x, y, degree }) => ({ entity, x, y, degree })), width, height);
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
  const paddingY = 90;
  const scale = Math.min(
    2.15,
    (width - paddingX * 2) / spreadX,
    (height - paddingY * 2) / spreadY,
  );
  const graphCenterX = minX + spreadX / 2;
  const graphCenterY = minY + spreadY / 2;

  return nodes.map((node) => ({
    ...node,
    x: width / 2 + (node.x - graphCenterX) * scale,
    y: height * 0.45 + (node.y - graphCenterY) * scale,
  }));
}

function nodeRadius(degree: number) {
  return Math.min(16, 7 + degree * 1.15);
}

function shortTitle(title: string) {
  return title.length > 13 ? `${title.slice(0, 12)}...` : title;
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
