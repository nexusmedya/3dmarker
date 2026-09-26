/** One adapter per provider kind. */
import type { ProviderAdapter, ProviderKindId } from '../types';
import { openAiAdapter, openAiCompatibleAdapter } from './openai';
import { geminiAdapter } from './gemini';
import { stabilityAdapter } from './stability';
import { replicateAdapter } from './replicate';
import { falAdapter } from './fal';
import { tripoAdapter } from './tripo';
import { customHttpAdapter } from './customHttp';

const ADAPTERS: Record<ProviderKindId, ProviderAdapter> = {
  openai: openAiAdapter,
  gemini: geminiAdapter,
  stability: stabilityAdapter,
  replicate: replicateAdapter,
  fal: falAdapter,
  tripo: tripoAdapter,
  'openai-compatible': openAiCompatibleAdapter,
  'custom-http': customHttpAdapter,
};

export function getAdapter(kind: ProviderKindId): ProviderAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`No adapter for AI provider kind: ${kind}`);
  return adapter;
}
