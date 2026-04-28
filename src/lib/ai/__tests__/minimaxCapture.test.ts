import { describe, expect, it } from 'vitest';
import { normalizeMiniMaxCaptureResponse } from '@/lib/ai/minimaxCapture';

describe('MiniMax capture normalization', () => {
  it('normalizes MiniMax JSON into editable capture draft', () => {
    const draft = normalizeMiniMaxCaptureResponse(
      JSON.stringify({
        primaryEntity: {
          type: 'event',
          title: '股票监控进度同步',
          summary: '和虾总同步股票监控项目进展。',
          tags: ['会议', '项目'],
          scenes: ['work'],
        },
        relatedEntities: [
          {
            type: 'person',
            title: '虾总',
            summary: '本次会议参与人。',
            tags: ['人物'],
            scenes: ['work'],
          },
          {
            type: 'project',
            title: '股票监控',
            summary: '相关项目。',
            tags: ['项目'],
            scenes: ['work'],
          },
        ],
        relationships: [
          { fromTitle: '虾总', type: 'attendee', toTitle: '股票监控进度同步' },
          { fromTitle: '股票监控进度同步', type: 'about', toTitle: '股票监控' },
        ],
        tasks: [
          {
            description: '调通飞书推送',
            ownerTitle: '虾总',
            linkedToTitles: ['股票监控'],
            dueDate: '本周内',
            status: 'pending',
          },
        ],
      }),
    );

    expect(draft.primaryEntity.title).toBe('股票监控进度同步');
    expect(draft.relatedEntities).toHaveLength(2);
    expect(draft.relationships).toHaveLength(2);
    expect(draft.tasks[0]?.description).toBe('调通飞书推送');
  });

  it('uses the first complete JSON object when the model adds trailing content', () => {
    const draft = normalizeMiniMaxCaptureResponse(`{"note":"reasoning object"}
    {
      "primaryEntity": {
        "type": "topic",
        "title": "一句话总结",
        "summary": "一条记录。",
        "tags": [],
        "scenes": ["personal"]
      },
      "relatedEntities": [],
      "relationships": [],
      "tasks": []
    }
    {"note":"trailing"}`);

    expect(draft.primaryEntity.title).toBe('一句话总结');
    expect(draft.primaryEntity.type).toBe('topic');
  });

  it('keeps tasks with uncertain owner by assigning editable implicit owner', () => {
    const draft = normalizeMiniMaxCaptureResponse(
      JSON.stringify({
        primaryEntity: {
          type: 'project',
          title: '桌面数字生命体',
          summary: '下一阶段要做稳语音链路和执行链路。',
          tags: ['路线规划'],
          scenes: ['work'],
        },
        relatedEntities: [],
        relationships: [],
        tasks: [
          {
            description: '做稳语音链路和执行链路',
            ownerTitle: 'uncertain',
            linkedToTitles: ['桌面数字生命体'],
            status: 'pending',
          },
        ],
      }),
    );

    expect(draft.tasks).toHaveLength(1);
    expect(draft.relatedEntities.some((entity) => entity.title === '我')).toBe(true);
    expect(draft.tasks[0]?.ownerClientId).toBe(
      draft.relatedEntities.find((entity) => entity.title === '我')?.clientId,
    );
  });
});
