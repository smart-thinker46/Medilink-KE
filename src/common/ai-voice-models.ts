import { existsSync } from 'fs';
import { basename } from 'path';

export type AiVoiceModelOption = {
  id: string;
  label: string;
  model: string;
  language?: string | null;
  exists: boolean;
  isDefault: boolean;
};

type VoiceEntry = {
  label: string;
  model: string;
  language: string | null;
};

const toText = (value: unknown) => String(value || '').trim();

const toSlug = (value: string) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'voice';

const deriveLabelFromModel = (modelPath: string) =>
  basename(modelPath)
    .replace(/\.onnx(\.json)?$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Voice';

const parseVoiceEntry = (raw: string): VoiceEntry | null => {
  const entry = toText(raw);
  if (!entry) return null;
  const equalIndex = entry.indexOf('=');
  if (equalIndex > 0) {
    const label = toText(entry.slice(0, equalIndex));
    const remainder = toText(entry.slice(equalIndex + 1));
    const parts = remainder.split('|').map((item) => toText(item)).filter(Boolean);
    const model = parts[0] || '';
    if (!model) return null;
    return {
      label: label || deriveLabelFromModel(model),
      model,
      language: parts[1] || null,
    };
  }
  const pipeParts = entry.split('|').map((item) => toText(item)).filter(Boolean);
  if (pipeParts.length >= 2) {
    const label = pipeParts[0];
    const model = pipeParts[1];
    if (!model) return null;
    return {
      label: label || deriveLabelFromModel(model),
      model,
      language: pipeParts[2] || null,
    };
  }
  return {
    label: deriveLabelFromModel(entry),
    model: entry,
    language: null,
  };
};

export function getConfiguredAiVoiceModels(env: NodeJS.ProcessEnv = process.env): AiVoiceModelOption[] {
  const defaultModel = toText(env.PIPER_MODEL);
  const variantsRaw = toText(env.PIPER_MODEL_VARIANTS || env.PIPER_VOICE_MODELS);
  const parsedVariants: VoiceEntry[] = variantsRaw
    ? variantsRaw
        .split(',')
        .map((item) => parseVoiceEntry(item))
        .filter((item): item is VoiceEntry => Boolean(item))
    : [];

  const merged: VoiceEntry[] = [...parsedVariants];
  if (defaultModel && !merged.some((item) => item.model === defaultModel)) {
    merged.unshift({
      label: 'Default Voice',
      model: defaultModel,
      language: null,
    });
  }

  const usedIds = new Set<string>();
  const usedModels = new Set<string>();
  const options: AiVoiceModelOption[] = [];

  merged.forEach((item, index) => {
    const model = toText(item.model);
    if (!model || usedModels.has(model)) return;
    usedModels.add(model);
    const baseId = toSlug(item.label || `voice-${index + 1}`);
    let id = baseId;
    let counter = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${counter}`;
      counter += 1;
    }
    usedIds.add(id);
    options.push({
      id,
      label: toText(item.label) || `Voice ${index + 1}`,
      model,
      language: toText(item.language || '') || null,
      exists: existsSync(model),
      isDefault: model === defaultModel,
    });
  });

  return options;
}

export function resolveAiVoiceModel(
  selectedModel: unknown,
  options: AiVoiceModelOption[],
  fallbackModel: unknown = '',
) {
  const selected = toText(selectedModel);
  if (selected && options.some((item) => item.model === selected)) {
    return selected;
  }
  const fallback = toText(fallbackModel);
  if (fallback && options.some((item) => item.model === fallback)) {
    return fallback;
  }
  const defaultOption = options.find((item) => item.isDefault) || options[0];
  return defaultOption?.model || '';
}
