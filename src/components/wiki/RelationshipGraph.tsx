import type { Entity, Relationship } from '@/types';
import { relationshipTypeLabel } from '@/lib/graph/answer';

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
  isCenter: boolean;
};

const typeColors: Record<Entity['type'], string> = {
  person: '#12a150',
  project: '#155eef',
  event: '#5f6368',
  topic: '#d9a400',
};

export function RelationshipGraph({
  centerEntity,
  relationships,
  entities,
  depth,
  onDepthChange,
}: RelationshipGraphProps) {
  const relatedEntities = entities.filter((entity) => entity.id !== centerEntity.id);

  const nodes = layoutNodes(centerEntity, relatedEntities);
  const nodeById = new Map(nodes.map((node) => [node.entity.id, node]));

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

  return (
    <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
      <div className="flex items-center justify-between gap-3 border-b border-[#e5e5e4] pb-3">
        <h3 className="text-sm font-semibold text-[#1f2937]">关系网络</h3>
        <div className="flex items-center gap-2">
          {onDepthChange && depth ? (
            <div className="rounded-full border border-[#d9d9d6] bg-[#f7f7f5] p-1">
              {[1, 2].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onDepthChange(value)}
                  className={[
                    'rounded-full px-2.5 py-1 text-xs transition',
                    depth === value ? 'bg-white text-[#155eef]' : 'text-[#626965]',
                  ].join(' ')}
                >
                  {value} 跳
                </button>
              ))}
            </div>
          ) : null}
          <span className="text-xs text-[#626965]">{relatedEntities.length} 个相邻实体</span>
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-[10px] border border-[#eeeeed] bg-[#fbfbfa]">
        <svg viewBox="0 0 100 62" role="img" aria-label={`${centerEntity.title} 的关系网络`} className="h-80 w-full">
          <defs>
            <marker id="graph-arrow" markerHeight="5" markerWidth="5" orient="auto" refX="4.2" refY="2.5">
              <path d="M0,0 L5,2.5 L0,5 Z" fill="#b8beb9" />
            </marker>
          </defs>
          {relationships.map((relationship) => {
            const from = nodeById.get(relationship.from);
            const to = nodeById.get(relationship.to);
            if (!from || !to) return null;
            return (
              <g key={relationship.id}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  className="mywiki-graph-link"
                  markerEnd="url(#graph-arrow)"
                />
                <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 1.2} className="mywiki-graph-edge-label">
                  {relationshipTypeLabel(relationship.type)}
                </text>
              </g>
            );
          })}
          {nodes.map((node) => (
            <a key={node.entity.id} href={`/wiki/${node.entity.type}/${node.entity.id}`} className="mywiki-graph-node-link">
              <g className={node.isCenter ? 'mywiki-graph-node mywiki-graph-node-center' : 'mywiki-graph-node'}>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.isCenter ? 2.7 : 2.05}
                  fill={typeColors[node.entity.type]}
                  stroke="#ffffff"
                  strokeWidth="0.8"
                />
                <text x={node.x} y={node.y + (node.isCenter ? 6 : 5)} textAnchor="middle" className="mywiki-graph-label">
                  {shortTitle(node.entity.title)}
                </text>
              </g>
            </a>
          ))}
        </svg>
      </div>
    </section>
  );
}

function layoutNodes(centerEntity: Entity, relatedEntities: Entity[]): GraphNode[] {
  const center: GraphNode = { entity: centerEntity, x: 50, y: 31, isCenter: true };
  if (relatedEntities.length === 0) return [center];

  const nodes = relatedEntities.map((entity, index) => {
    const angle = (Math.PI * 2 * index) / relatedEntities.length - Math.PI / 2;
    const radiusX = relatedEntities.length <= 4 ? 28 : 34;
    const radiusY = relatedEntities.length <= 4 ? 17 : 22;
    return {
      entity,
      x: 50 + Math.cos(angle) * radiusX,
      y: 31 + Math.sin(angle) * radiusY,
      isCenter: false,
    };
  });

  return [center, ...nodes];
}

function shortTitle(title: string) {
  return title.length > 14 ? `${title.slice(0, 13)}...` : title;
}
