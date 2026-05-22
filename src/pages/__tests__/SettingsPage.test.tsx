import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsPage } from '../SettingsPage';

describe('SettingsPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the Chinese-first provider settings center', () => {
    render(<SettingsPage />);

    expect(screen.getByText('设置中心')).toBeTruthy();
    expect(screen.getAllByText('LLM 模型').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('模型职责').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('MiniMax 中国').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Wiki 编译模型')).toBeTruthy();
  });

  it('activates one provider and persists the selected default model', () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByLabelText('启用 Ollama'));

    const saved = JSON.parse(window.localStorage.getItem('mywiki.v2.llmProviderSettings') ?? '{}');
    expect(saved.activeProviderId).toBe('ollama');
    expect(saved.configs.filter((config: { enabled: boolean }) => config.enabled)).toHaveLength(1);
    expect(saved.configs.find((config: { providerId: string }) => config.providerId === 'ollama')?.enabled).toBe(true);
  });

  it('keeps provider configs while switching active provider', () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByLabelText('展开 OpenAI'));
    fireEvent.change(screen.getByLabelText('OpenAI API Key'), {
      target: { value: 'sk-openai-test' },
    });
    fireEvent.click(screen.getByLabelText('启用 OpenAI'));
    fireEvent.click(screen.getByLabelText('启用 Ollama'));

    const saved = JSON.parse(window.localStorage.getItem('mywiki.v2.llmProviderSettings') ?? '{}');
    expect(saved.activeProviderId).toBe('ollama');
    expect(saved.configs.find((config: { providerId: string }) => config.providerId === 'openai')?.apiKey).toBe(
      'sk-openai-test',
    );
  });

  it('updates the MiniMax endpoint when switching API mode defaults', () => {
    render(<SettingsPage />);

    const endpointInput = screen.getByLabelText('MiniMax 中国 接口地址');
    expect(endpointInput).toHaveProperty('value', 'https://api.minimaxi.com/anthropic');

    fireEvent.click(screen.getByText('OpenAI 兼容'));
    expect(endpointInput).toHaveProperty('value', 'https://api.minimaxi.com/v1');

    fireEvent.change(endpointInput, { target: { value: 'https://proxy.example.com/minimax' } });
    fireEvent.click(screen.getByText('Anthropic 兼容'));
    expect(endpointInput).toHaveProperty('value', 'https://proxy.example.com/minimax');
  });

  it('persists provider thinking controls', () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByLabelText('展开 DeepSeek'));
    fireEvent.click(screen.getByLabelText('DeepSeek Thinking / Reasoning 关闭'));

    const saved = JSON.parse(window.localStorage.getItem('mywiki.v2.llmProviderSettings') ?? '{}');
    expect(saved.configs.find((config: { providerId: string }) => config.providerId === 'deepseek')?.reasoningMode).toBe(
      'disabled',
    );
  });

});
