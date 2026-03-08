import { existsSync } from 'fs';
import { basename } from 'path';

export type AiVoiceModelOption = {
  id: string;
  label: string;
  model: string;
  exists: boolean;
  isDefault: boolean;
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

const parseVoiceEntry = (raw: string) => {
  const entry = toText(raw);
  if (!entry) return null;
  const equalIndex = entry.indexOf('=');
  if (equalIndex > 0) {
    const label = toText(entry.slice(0, equalIndex));
    const model = toText(entry.slice(equalIndex + 1));
    if (!model) return null;
    return {
      label: label || deriveLabelFromModel(model),
      model,
    };
  }
  const pipeIndex = entry.indexOf('|');
  if (pipeIndex > 0) {
    const label = toText(entry.slice(0, pipeIndex));
    const model = toText(entry.slice(pipeIndex + 1));
    if (!model) return null;
    return {
      label: label || deriveLabelFromModel(model),
      model,
    };
  }
  return {
    label: deriveLabelFromModel(entry),
    model: entry,
  };
};

export function getConfiguredAiVoiceModels(env: NodeJS.ProcessEnv = process.env): AiVoiceModelOption[] {
  const defaultModel = toText(env.PIPER_MODEL);
  const variantsRaw = toText(env.PIPER_MODEL_VARIANTS || env.PIPER_VOICE_MODELS);
  const parsedVariants = variantsRaw
    ? variantsRaw
        .split(',')
        .map((item) => parseVoiceEntry(item))
        .filter((item): item is { label: string; model: string } => Boolean(item))
    : [];

  const merged = [...parsedVariants];
  if (defaultModel && !merged.some((item) => item.model === defaultModel)) {
    merged.unshift({
      label: 'Default Voice',
      model: defaultModel,
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
