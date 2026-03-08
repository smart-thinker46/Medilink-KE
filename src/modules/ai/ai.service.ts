import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { mergeProfileExtras, getProfileExtras, getProfileExtrasMap } from 'src/common/profile-extras';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';

type SearchResult = {
  id: string;
  type: 'patient' | 'medic' | 'hospital' | 'pharmacy';
  name: string;
  subtitle?: string;
  score: number;
  reason?: string;
};

type AiProvider = 'openai' | 'gemini' | 'ollama';

type AiAccessState = {
  userId: string;
  provider: AiProvider;
  displayProvider: string;
  isPremium: boolean;
  aiEnabled: boolean;
  canUse: boolean;
  blockedReason?: string | null;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly displayProviderName = 'Medilink AI';
  private readonly provider: AiProvider;
  private readonly openAiApiKey: string;
  private readonly openAiModel: string;
  private readonly geminiApiKey: string;
  private readonly geminiModel: string;
  private readonly ollamaBaseUrl: string;
  private readonly ollamaModel: string;
  private readonly ollamaTimeoutMs: number;
  private readonly ollamaNumCtx: number;
  private readonly ollamaMaxOutputTokens: number;
  private cachedOllamaModel: string | null = null;
  private aiCooldownUntil = 0;
  private aiCooldownReason: string | null = null;
  private lastAiErrorLogAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsGateway: NotificationsGateway,
  ) {
    const configuredProvider = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
    this.openAiApiKey = process.env.OPENAI_API_KEY?.trim() || '';
    this.geminiApiKey = process.env.GEMINI_API_KEY?.trim() || '';
    this.ollamaBaseUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
      .trim()
      .replace(/\/+$/, '');

    this.provider =
      configuredProvider === 'gemini'
        ? 'gemini'
        : configuredProvider === 'openai'
            ? 'openai'
            : configuredProvider === 'ollama'
                ? 'ollama'
                : this.geminiApiKey
                    ? 'gemini'
                    : this.openAiApiKey
                        ? 'openai'
                        : 'ollama';

    this.openAiModel = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
    this.geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-1.5-flash';
    this.ollamaModel = process.env.OLLAMA_MODEL?.trim() || 'llama3.1:8b-instruct';
    this.ollamaTimeoutMs = Math.max(
      Number(process.env.OLLAMA_TIMEOUT_MS || 300000) || 300000,
      60000,
    );
    this.ollamaNumCtx = Math.max(Number(process.env.OLLAMA_NUM_CTX || 1024) || 1024, 256);
    this.ollamaMaxOutputTokens = Math.max(
      Number(process.env.OLLAMA_MAX_OUTPUT_TOKENS || 220) || 220,
      64,
    );
  }

  private get isAiCoolingDown() {
    return Date.now() < this.aiCooldownUntil;
  }

  private aiUnavailableReason() {
    if (this.isAiCoolingDown) {
      return (
        this.aiCooldownReason ||
        `${this.displayProviderName} is temporarily unavailable. Please retry shortly.`
      );
    }
    if (this.provider === 'gemini' && !this.geminiApiKey) {
      return `${this.displayProviderName} is not configured on this environment.`;
    }
    if (this.provider === 'openai' && !this.openAiApiKey) {
      return `${this.displayProviderName} is not configured on this environment.`;
    }
    if (this.provider === 'ollama' && !this.ollamaBaseUrl) {
      return `${this.displayProviderName} is not configured on this environment.`;
    }
    return null;
  }

  private markCooldown(ms: number) {
    this.aiCooldownUntil = Math.max(this.aiCooldownUntil, Date.now() + ms);
  }

  private shouldLogNow(windowMs = 10000) {
    const now = Date.now();
    if (now - this.lastAiErrorLogAt > windowMs) {
      this.lastAiErrorLogAt = now;
      return true;
    }
    return false;
  }

  private normalizeGeminiModel(model: string) {
    return String(model || '')
      .trim()
      .replace(/^models\//i, '')
      .replace(/:generateContent$/i, '');
  }

  private geminiModelCandidates() {
    const configured = this.normalizeGeminiModel(this.geminiModel);
    const defaults = [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest',
      'gemini-1.5-pro',
    ];
    return Array.from(new Set([configured, ...defaults].filter(Boolean)));
  }

  private extractAxiosErrorMessage(error: any) {
    const status = Number(error?.response?.status || error?.status || 0);
    const data = error?.response?.data;
    const message =
      data?.error ||
      data?.error?.message ||
      data?.message ||
      error?.message ||
      'Unknown AI error';
    return status ? `${status} ${String(message)}` : String(message);
  }

  private handleAiError(error: any) {
    const status = Number(error?.status || error?.response?.status || 0);
    const code = String(error?.code || error?.error?.code || '').toLowerCase();
    const type = String(error?.type || error?.error?.type || '').toLowerCase();
    const message = this.extractAxiosErrorMessage(error);

    const isQuota =
      code === 'insufficient_quota' ||
      type === 'insufficient_quota' ||
      message.toLowerCase().includes('quota');
    const isRateLimit = status === 429;
    if (isQuota) {
      const retrySecondsMatch = message.match(/retry in\s+([0-9.]+)s/i);
      const retrySeconds = retrySecondsMatch ? Number(retrySecondsMatch[1]) : NaN;
      const retryMs = Number.isFinite(retrySeconds)
        ? Math.max(60_000, Math.ceil(retrySeconds * 1000))
        : 15 * 60 * 1000;
      // If account quota is effectively disabled (limit: 0), cool down for longer to avoid noisy retries.
      const longCooldown = message.toLowerCase().includes('limit: 0')
        ? 12 * 60 * 60 * 1000
        : retryMs;
      this.markCooldown(longCooldown);
      this.aiCooldownReason =
        `${this.displayProviderName} is currently unavailable due to quota limits. Please retry later.`;
    } else if (isRateLimit) {
      this.markCooldown(60 * 1000);
      this.aiCooldownReason = `${this.displayProviderName} is temporarily rate limited. Please retry shortly.`;
    } else {
      this.aiCooldownReason = null;
    }

    if (this.shouldLogNow()) {
      this.logger.warn(
        `${this.provider.toUpperCase()} unavailable (${isQuota ? 'quota' : isRateLimit ? 'rate_limit' : 'error'}): ${message}`,
      );
    }
  }

  private parseJson<T>(raw: string, fallback: T): T {
    if (!raw) return fallback;
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      return fallback;
    }
  }

  private toTextList(value: unknown, limit = 6) {
    return (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, limit);
  }

  private listSpeechChunk(label: string, value: unknown, limit = 4) {
    const list = this.toTextList(value, limit);
    if (!list.length) return '';
    return `${label}: ${list.join('. ')}`;
  }

  private buildSpeechText(parts: Array<unknown>, maxChars = 1800) {
    const text = parts
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('. ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.slice(0, maxChars);
  }

  private normalizeRole(role: unknown) {
    return String(role || '').trim().toUpperCase();
  }

  private extractCurrencyNumber(value: unknown) {
    const cleaned = String(value ?? '')
      .replace(/[^0-9.]/g, '')
      .trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private normalizeHelpTopic(topic: unknown, query?: string) {
    const raw = `${String(topic || '').toLowerCase()} ${String(query || '').toLowerCase()}`.trim();
    if (!raw) return 'general';
    if (/(book|appointment|schedule|visit|consult)/.test(raw)) return 'appointments';
    if (/(medic|doctor|nurse|specialist|find provider)/.test(raw)) return 'find_medic';
    if (/(emergency|urgent|ambulance|sos)/.test(raw)) return 'emergency';
    if (/(pharmacy|medicine|drug|order|cart|delivery|product)/.test(raw)) return 'pharmacy';
    if (/(voice|microphone|speak|call ai)/.test(raw)) return 'voice';
    if (/(chat|message|conversation|support)/.test(raw)) return 'chat';
    if (/(profile|account|settings|password|security)/.test(raw)) return 'profile';
    if (/(subscription|premium|payment|billing)/.test(raw)) return 'subscription';
    return 'general';
  }

  private looksLikeAppHelpQuery(query: string) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return false;
    return /(how to|how do i|where can i|guide|help me|steps|use medilink|navigate|find|book|order|profile|subscription|voice ai|chat|emergency)/.test(
      q,
    );
  }

  private buildAppUsageGuide(roleInput: unknown, topicInput: unknown, queryInput = '') {
    const role = this.normalizeRole(roleInput);
    const topic = this.normalizeHelpTopic(topicInput, queryInput);

    const shared = {
      chat: {
        title: 'Use secure chat',
        summary: 'Open Conversations, choose a contact, and send secure messages.',
        steps: [
          'Go to the chat/conversations tab.',
          'Select the person you want to message.',
          'Type your message and tap send.',
          'Use attachments only when needed for care coordination.',
        ],
      },
      profile: {
        title: 'Update your profile',
        summary: 'Keep profile details up to date so matching and communication work correctly.',
        steps: [
          'Open Settings then Edit Profile.',
          'Update phone, name, and emergency details.',
          'Save changes and re-open profile to confirm.',
          'Update password/security settings if needed.',
        ],
      },
      subscription: {
        title: 'Manage premium subscription',
        summary: 'Premium unlocks AI features and selected advanced workflows.',
        steps: [
          'Open Settings or Subscription page.',
          'Choose a plan and confirm payment.',
          'Wait for active status confirmation.',
          'Re-open AI tools and verify premium is enabled.',
        ],
      },
      voice: {
        title: 'Use Medilink Voice Assistant',
        summary: 'Voice Assistant helps with guided tools like search and emergency support.',
        steps: [
          'Open AI Assistant and tap Voice AI.',
          'Choose a session mode (general/search/records/support/emergency).',
          'Start session, then run guided tools based on your task.',
          'Check recent voice sessions for results and history.',
        ],
      },
    } as const;

    const byRole: Record<string, Record<string, { title: string; summary: string; steps: string[] }>> = {
      PATIENT: {
        appointments: {
          title: 'Book a patient appointment',
          summary: 'Find a medic, select a slot, then confirm your booking.',
          steps: [
            'Go to Patient home and open Appointments or Search Medics.',
            'Filter by specialization, price, and location.',
            'Open medic profile and choose an available date/time.',
            'Confirm booking and monitor status in Appointments.',
          ],
        },
        find_medic: {
          title: 'Find the right medic',
          summary: 'Use AI search with specialty, experience, and location terms.',
          steps: [
            'Open AI Assistant and enter your needs (e.g. cardiologist Nairobi).',
            'Review AI-ranked medic results.',
            'Open profiles, compare ratings/fees, then book.',
            'Use chat or call tools to follow up.',
          ],
        },
        emergency: {
          title: 'Get emergency help fast',
          summary: 'Use Emergency and Voice tools to reach nearby support quickly.',
          steps: [
            'Open Emergency from patient section.',
            'Use Voice AI emergency mode for nearest contacts.',
            'Call emergency contacts directly from listed options.',
            'Share your location when prompted.',
          ],
        },
        pharmacy: {
          title: 'Order from pharmacies',
          summary: 'Search products, add to cart, then complete checkout.',
          steps: [
            'Open Pharmacy/Marketplace.',
            'Search medicine/product and compare stock/price.',
            'Add products to cart and review totals.',
            'Checkout and track order status.',
          ],
        },
      },
      MEDIC: {
        appointments: {
          title: 'Manage medic appointments',
          summary: 'Track upcoming bookings, update records, and follow up quickly.',
          steps: [
            'Open Medic dashboard and go to Appointments.',
            'Review patient queue and appointment details.',
            'Update clinical notes/records after consultation.',
            'Use chat for post-visit follow-up.',
          ],
        },
        find_medic: {
          title: 'Discover peers and specialists',
          summary: 'Use AI search to locate specialists and facilities for referrals.',
          steps: [
            'Open AI Assistant and run search with specialty/location.',
            'Check ranked providers and hospitals.',
            'Open profile details for contact and capabilities.',
            'Coordinate referrals via chat.',
          ],
        },
        emergency: {
          title: 'Emergency coordination',
          summary: 'Use emergency and voice workflows to coordinate urgent care paths.',
          steps: [
            'Use Voice AI emergency mode when urgent support is needed.',
            'Retrieve nearest medics/hospitals.',
            'Contact emergency lines and care teams immediately.',
            'Document urgent actions in records.',
          ],
        },
      },
      HOSPITAL_ADMIN: {
        general: {
          title: 'Run hospital operations',
          summary: 'Use hospital dashboard, shifts, analytics, and staffing tools daily.',
          steps: [
            'Review dashboard metrics and alerts.',
            'Manage shifts, appointments, and medic staffing.',
            'Track inventory and pharmacy marketplace needs.',
            'Use AI analytics summary for action priorities.',
          ],
        },
      },
      PHARMACY_ADMIN: {
        pharmacy: {
          title: 'Manage pharmacy operations',
          summary: 'Control stock, orders, and product catalog efficiently.',
          steps: [
            'Open pharmacy dashboard and check low stock first.',
            'Update products, pricing, and availability.',
            'Process pending orders and stock movements.',
            'Use AI assistant for reorder and demand actions.',
          ],
        },
      },
      SUPER_ADMIN: {
        general: {
          title: 'Manage platform administration',
          summary: 'Use Control Center, users, subscriptions, and audit logs for governance.',
          steps: [
            'Open Admin dashboard and review totals.',
            'Manage users/tenants/subscriptions and disputes.',
            'Review audit logs and policy compliance.',
            'Adjust AI and platform settings in shared settings/control center.',
          ],
        },
      },
    };

    const roleGuides = byRole[role] || {};
    const guide =
      roleGuides[topic] ||
      roleGuides.general ||
      shared[topic as keyof typeof shared] ||
      {
        title: 'Use Medilink effectively',
        summary: 'Use dashboard modules, AI assistant, and settings to complete tasks faster.',
        steps: [
          'Start from your role dashboard.',
          'Use AI Assistant for search, summaries, and workflow help.',
          'Use Voice AI for hands-free guided actions.',
          'Update profile/settings to keep your account accurate.',
        ],
      };

    const tips = [
      'Use specific keywords (role, location, price, specialization) for better AI search results.',
      'Confirm critical actions from primary screens after AI suggestions.',
      'For emergencies, call official contacts immediately in parallel with app actions.',
    ];

    return {
      role,
      topic,
      title: guide.title,
      summary: guide.summary,
      steps: guide.steps.slice(0, 6),
      tips,
    };
  }

  private async askGemini(system: string, prompt: string, expectJson: boolean) {
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${system}\n\n${prompt}` }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        ...(expectJson ? { responseMimeType: 'application/json' } : {}),
      },
    };

    const apiVersions = ['v1beta', 'v1'];
    const models = this.geminiModelCandidates();
    const configuredModel = this.normalizeGeminiModel(this.geminiModel);
    let lastError: any = null;

    for (const apiVersion of apiVersions) {
      for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${this.geminiApiKey}`;
        try {
          const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
          });
          const parts = response?.data?.candidates?.[0]?.content?.parts || [];
          const text = parts
            .map((part: any) => String(part?.text || '').trim())
            .filter(Boolean)
            .join('\n');

          if (model !== configuredModel && this.shouldLogNow(30000)) {
            this.logger.warn(
              `Gemini model fallback applied: configured=${configuredModel}, using=${model} (${apiVersion})`,
            );
          }
          return text;
        } catch (error: any) {
          lastError = error;
          const status = Number(error?.response?.status || error?.status || 0);
          // Try next model/version when this one is unsupported.
          if (status === 404 || status === 400) {
            continue;
          }
          throw error;
        }
      }
    }

    throw new Error(
      `Gemini request failed after fallback attempts: ${this.extractAxiosErrorMessage(lastError)}`,
    );
  }

  private async askOpenAi(system: string, prompt: string, expectJson: boolean) {
    const response = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: this.openAiModel,
        temperature: 0.2,
        ...(expectJson ? { text: { format: { type: 'json_object' } } } : {}),
        input: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${this.openAiApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      },
    );

    return String(response?.data?.output_text || '').trim();
  }

  private async listOllamaModels() {
    const response = await axios.get(`${this.ollamaBaseUrl}/api/tags`, {
      timeout: 15000,
    });
    const models = Array.isArray(response?.data?.models) ? response.data.models : [];
    return models
      .map((m: any) => String(m?.name || '').trim())
      .filter(Boolean);
  }

  private async pickOllamaModel() {
    if (this.cachedOllamaModel) {
      return this.cachedOllamaModel;
    }

    const available = await this.listOllamaModels();
    if (!available.length) {
      throw new Error('No Ollama models are available. Pull a model first.');
    }

    const configured = String(this.ollamaModel || '').trim();
    const configuredBase = configured.split(':')[0];
    const exact = available.find((name) => name === configured);
    if (exact) {
      this.cachedOllamaModel = exact;
      return exact;
    }

    const sameFamily = available.find((name) => name.split(':')[0] === configuredBase);
    if (sameFamily) {
      if (this.shouldLogNow(30000)) {
        this.logger.warn(
          `Ollama model fallback applied: configured=${configured}, using=${sameFamily}`,
        );
      }
      this.cachedOllamaModel = sameFamily;
      return sameFamily;
    }

    const first = available[0];
    if (this.shouldLogNow(30000)) {
      this.logger.warn(
        `Ollama model fallback applied: configured=${configured}, using=${first}`,
      );
    }
    this.cachedOllamaModel = first;
    return first;
  }

  private async askOllama(system: string, prompt: string, expectJson: boolean) {
    const model = await this.pickOllamaModel();
    const textPrompt = `${system}\n\n${prompt}`;
    const options = {
      temperature: 0.2,
      num_ctx: this.ollamaNumCtx,
      num_predict: this.ollamaMaxOutputTokens,
    };

    try {
      const response = await axios.post(
        `${this.ollamaBaseUrl}/api/generate`,
        {
          model,
          prompt: textPrompt,
          stream: false,
          options,
          ...(expectJson ? { format: 'json' } : {}),
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: this.ollamaTimeoutMs,
        },
      );

      const output = String(response?.data?.response || '').trim();
      if (!output) {
        throw new Error('Ollama returned an empty response.');
      }
      return output;
    } catch (error: any) {
      const status = Number(error?.response?.status || error?.status || 0);
      const details = this.extractAxiosErrorMessage(error).toLowerCase();

      // If /api/generate is unavailable on this runtime, try /api/chat.
      if (status === 404 && !details.includes('model') && !details.includes('not found')) {
        const chatResponse = await axios.post(
          `${this.ollamaBaseUrl}/api/chat`,
          {
            model,
            stream: false,
            options,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
            ...(expectJson ? { format: 'json' } : {}),
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: this.ollamaTimeoutMs,
          },
        );
        const output = String(chatResponse?.data?.message?.content || '').trim();
        if (!output) {
          throw new Error('Ollama chat returned an empty response.');
        }
        return output;
      }

      throw error;
    }
  }

  private async askWithProvider(system: string, prompt: string, expectJson: boolean) {
    if (this.provider === 'gemini') {
      return this.askGemini(system, prompt, expectJson);
    }
    if (this.provider === 'openai') {
      return this.askOpenAi(system, prompt, expectJson);
    }
    return this.askOllama(system, prompt, expectJson);
  }

  private async askJson<T>(system: string, prompt: string, fallback: T): Promise<T> {
    if (this.aiUnavailableReason()) {
      return fallback;
    }
    try {
      const output = await this.askWithProvider(system, prompt, true);
      return this.parseJson<T>(output, fallback);
    } catch (error) {
      this.handleAiError(error);
      return fallback;
    }
  }

  private async askText(system: string, prompt: string, fallback = ''): Promise<string> {
    if (this.aiUnavailableReason()) {
      return fallback;
    }
    try {
      const output = await this.askWithProvider(system, prompt, false);
      return output || fallback;
    } catch (error) {
      this.handleAiError(error);
      return fallback;
    }
  }

  private async getAiAccessState(user: any): Promise<AiAccessState> {
    const userId = String(user?.userId || '');
    if (!userId) {
      throw new ForbiddenException('Unauthorized');
    }

    const role = String(user?.role || '').toUpperCase();
    const isSuperAdmin = role === 'SUPER_ADMIN';
    const extras = (await getProfileExtras(this.prisma, userId)) as any;
    const paidPremium = Boolean(
      extras?.subscriptionActive || extras?.premiumActive || extras?.isPremium,
    );
    const isPremium = isSuperAdmin || paidPremium;
    const aiEnabled = isSuperAdmin ? true : Boolean(extras?.aiEnabled);
    const providerIssue = this.aiUnavailableReason();

    let blockedReason: string | null = null;
    if (!isPremium) {
      blockedReason =
        'AI is locked for this account. Only SUPER_ADMIN has free access. Activate AI subscription to unlock.';
    } else if (!aiEnabled && !isSuperAdmin) {
      blockedReason = 'AI is disabled. Enable AI in Settings to use this feature.';
    } else if (providerIssue) {
      blockedReason = providerIssue;
    }

    return {
      userId,
      provider: this.provider,
      displayProvider: this.displayProviderName,
      isPremium,
      aiEnabled,
      canUse: !blockedReason,
      blockedReason,
    };
  }

  private async ensureAiAccess(user: any) {
    const state = await this.getAiAccessState(user);
    if (!state.canUse) {
      throw new ForbiddenException(state.blockedReason || 'AI access denied.');
    }
    return state;
  }

  async getSettings(user: any) {
    const state = await this.getAiAccessState(user);
    return {
      provider: state.provider,
      displayProvider: state.displayProvider,
      isPremium: state.isPremium,
      aiEnabled: state.aiEnabled,
      canUse: state.canUse,
      blockedReason: state.blockedReason || null,
    };
  }

  async healthCheck() {
    const providerIssue = this.aiUnavailableReason();
    if (providerIssue) {
      return {
        ok: false,
        provider: this.provider,
        displayProvider: this.displayProviderName,
        configured: false,
        reason: providerIssue,
        cooldownUntil: this.aiCooldownUntil || null,
      };
    }

    if (this.provider !== 'ollama') {
      return {
        ok: true,
        provider: this.provider,
        displayProvider: this.displayProviderName,
        configured: true,
        details: 'Provider configured and ready.',
      };
    }

    try {
      const response = await axios.get(`${this.ollamaBaseUrl}/api/tags`, {
        timeout: 5000,
      });
      const models = Array.isArray(response?.data?.models) ? response.data.models : [];
      const hasSelectedModel = models.some(
        (m: any) => String(m?.name || '').trim() === this.ollamaModel,
      );

      return {
        ok: true,
        provider: this.provider,
        displayProvider: this.displayProviderName,
        configured: true,
        ollamaBaseUrl: this.ollamaBaseUrl,
        selectedModel: this.ollamaModel,
        modelPresent: hasSelectedModel,
        availableModels: models.map((m: any) => String(m?.name || '')).filter(Boolean),
      };
    } catch (error: any) {
      return {
        ok: false,
        provider: this.provider,
        displayProvider: this.displayProviderName,
        configured: true,
        ollamaBaseUrl: this.ollamaBaseUrl,
        selectedModel: this.ollamaModel,
        reason: this.extractAxiosErrorMessage(error),
      };
    }
  }

  async getAccessState(user: any) {
    return this.getAiAccessState(user);
  }

  async assertAccess(user: any) {
    return this.ensureAiAccess(user);
  }

  async translateText(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const inputText = String(payload?.text || '').trim();
    if (!inputText) {
      throw new BadRequestException('Text is required for translation.');
    }

    const targetLanguage = String(payload?.targetLanguage || payload?.target || 'en')
      .trim()
      .toLowerCase();
    const sourceLanguage = String(payload?.sourceLanguage || payload?.source || 'auto')
      .trim()
      .toLowerCase();

    if (!targetLanguage) {
      throw new BadRequestException('targetLanguage is required for translation.');
    }

    const system =
      'You are Medilink AI translation engine. Translate accurately and return only translated text. No explanations, no markdown, no quotes.';
    const prompt = [
      `Target language: ${targetLanguage}`,
      `Source language hint: ${sourceLanguage || 'auto'}`,
      'Text:',
      inputText,
    ].join('\n');

    const translated = String(await this.askText(system, prompt, inputText)).trim() || inputText;
    const changed = translated !== inputText;

    return {
      text: translated,
      originalText: inputText,
      sourceLanguage: sourceLanguage || 'auto',
      targetLanguage,
      translated: changed,
      provider: this.displayProviderName,
    };
  }

  async updateSettings(user: any, payload: any) {
    const userId = String(user?.userId || '');
    if (!userId) {
      throw new ForbiddenException('Unauthorized');
    }

    const role = String(user?.role || '').toUpperCase();
    const isSuperAdmin = role === 'SUPER_ADMIN';
    const extras = (await getProfileExtras(this.prisma, userId)) as any;
    const paidPremium = Boolean(
      extras?.subscriptionActive || extras?.premiumActive || extras?.isPremium,
    );
    const isPremium = isSuperAdmin || paidPremium;
    const nextEnabled = Boolean(payload?.enabled);

    if (nextEnabled && !isPremium) {
      throw new ForbiddenException(
        'AI is locked for this account. Only SUPER_ADMIN has free access. Activate AI subscription to unlock.',
      );
    }

    await mergeProfileExtras(this.prisma, userId, {
      aiEnabled: nextEnabled,
    });

    return this.getSettings(user);
  }

  async summarizeHealthStatus(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const requesterId = user?.userId;
    const requesterRole = user?.role;
    const patientId = payload?.patientId || requesterId;
    if (!patientId) {
      return { summary: 'No patient selected.', highlights: [], risks: [], nextSteps: [] };
    }

    if (requesterRole === 'PATIENT' && patientId !== requesterId) {
      return {
        summary: 'Patients can only summarize their own health records.',
        highlights: [],
        risks: [],
        nextSteps: [],
      };
    }

    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: {
        id: true,
        fullName: true,
        email: true,
        gender: true,
        dateOfBirth: true,
        createdAt: true,
      },
    });

    if (!patient) {
      return { summary: 'Patient not found.', highlights: [], risks: [], nextSteps: [] };
    }

    const records = await this.prisma.medicalRecord.findMany({
      where: { patientId },
      include: {
        medic: {
          select: { id: true, fullName: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
    });

    const extrasMap = await getProfileExtrasMap(this.prisma, [patientId]);
    const extras = extrasMap.get(patientId) || {};

    const compact = {
      patient: {
        id: patient.id,
        fullName: patient.fullName,
        email: patient.email,
        gender: patient.gender,
        dateOfBirth: patient.dateOfBirth,
        createdAt: patient.createdAt,
      },
      profile: {
        bloodGroup: (extras as any).bloodGroup || null,
        allergies: (extras as any).allergies || null,
        chronicCondition: (extras as any).chronicCondition || null,
        preferredLanguage: (extras as any).preferredLanguage || null,
      },
      records: records.map((r) => ({
        id: r.id,
        type: r.type,
        condition: r.condition,
        notes: r.notes,
        medic: r.medic?.fullName || r.medic?.email || null,
        createdAt: r.createdAt,
      })),
    };

    const latestRecords = records.slice(0, 4);
    const fallbackHighlights = latestRecords
      .map((r) => [r.type, r.condition].filter(Boolean).join(': '))
      .filter(Boolean)
      .slice(0, 6);
    const fallbackRisks = [
      (extras as any).chronicCondition ? `Chronic condition noted: ${(extras as any).chronicCondition}` : '',
      (extras as any).allergies ? `Allergy information recorded: ${(extras as any).allergies}` : '',
      records.length === 0 ? 'No clinical records found yet.' : '',
    ].filter(Boolean);
    const fallbackNextSteps = [
      records.length ? 'Review latest clinical notes with your medic during next visit.' : 'Book a consultation to establish baseline records.',
      'Seek urgent care if severe or rapidly worsening symptoms appear.',
      'Keep profile health information up to date for safer care coordination.',
    ].filter(Boolean);
    const healthFallback = {
      summary:
        records.length > 0
          ? `Based on ${records.length} record(s), your recent medical updates were reviewed for key trends and follow-up actions.`
          : 'No sufficient data to summarize health status yet.',
      highlights: fallbackHighlights,
      risks: fallbackRisks.slice(0, 6),
      nextSteps: fallbackNextSteps.slice(0, 6),
      carePlan: ['Follow clinician guidance and medication instructions.', 'Attend scheduled reviews and lab follow-ups.'],
      disclaimer: 'This summary is informational and not a medical diagnosis.',
    };

    const json = await this.askJson<{
      summary: string;
      highlights: string[];
      risks: string[];
      nextSteps: string[];
      carePlan?: string[];
      disclaimer?: string;
    }>(
      [
        'You are a clinical documentation assistant.',
        'You summarize records, not diagnose.',
        'Keep language clear and conservative.',
        'Always include a short caution that this is not medical advice.',
        'Prefer actionable follow-up suggestions with timelines where possible.',
      ].join(' '),
      [
        'Create a health status summary from this JSON.',
        'Return valid JSON with keys:',
        'summary (string), highlights (array of max 6), risks (array of max 6), nextSteps (array of max 6), carePlan (array of max 6), disclaimer (string).',
        JSON.stringify(compact),
      ].join('\n'),
      healthFallback,
    );

    const summaryText = String(json?.summary || 'No sufficient data to summarize health status.').trim();
    const highlights = this.toTextList(json?.highlights, 6);
    const risks = this.toTextList(json?.risks, 6);
    const nextSteps = this.toTextList(json?.nextSteps, 6);
    const carePlan = this.toTextList(json?.carePlan, 6);
    const disclaimerText =
      String(json?.disclaimer || '').trim() ||
      'This summary is informational and not a medical diagnosis.';
    const speechText = this.buildSpeechText([
      summaryText,
      this.listSpeechChunk('Highlights', highlights, 4),
      this.listSpeechChunk('Risks', risks, 4),
      this.listSpeechChunk('Next steps', nextSteps, 4),
      disclaimerText,
    ]);

    return {
      patientId,
      summary: summaryText,
      highlights,
      risks,
      nextSteps,
      carePlan,
      disclaimer: disclaimerText,
      speechText,
      generatedAt: new Date().toISOString(),
    };
  }

  private scoreCandidate(query: string, haystack: string): number {
    const q = query.toLowerCase().trim();
    const h = haystack.toLowerCase();
    if (!q) return 0;
    if (h === q) return 100;
    if (h.startsWith(q)) return 80;
    if (h.includes(q)) return 55;
    const parts = q.split(/\s+/).filter(Boolean);
    const hits = parts.filter((p) => h.includes(p)).length;
    return Math.min(50, hits * 12);
  }

  private extractSearchHints(query: string) {
    const text = String(query || '').toLowerCase();
    const minExperienceMatch = text.match(/(?:at least|min|minimum)\s*(\d+)\s*(?:years?|yrs?)/i) ||
      text.match(/(\d+)\s*(?:\+)?\s*(?:years?|yrs?)\s*(?:experience)?/i);
    const maxPriceMatch =
      text.match(/(?:under|below|less than|<=?)\s*(?:kes|ksh|kshs)?\s*([0-9]+(?:\.[0-9]+)?)/i) ||
      text.match(/(?:kes|ksh|kshs)\s*([0-9]+(?:\.[0-9]+)?)/i);
    const inLocationMatch = text.match(/\bin\s+([a-z\s]{2,40})/i);
    const locationTerms = inLocationMatch
      ? String(inLocationMatch[1] || '')
          .trim()
          .split(/\s+/)
          .filter((part) => part.length > 2)
      : [];

    const includeTypes: Array<'patient' | 'medic' | 'hospital' | 'pharmacy'> = [];
    if (/(medic|doctor|nurse|specialist|consultant|clinic)/.test(text)) includeTypes.push('medic');
    if (/(hospital|facility|ward|admission)/.test(text)) includeTypes.push('hospital');
    if (/(pharmacy|medicine|drug|medication|product)/.test(text)) includeTypes.push('pharmacy');

    return {
      minExperience: minExperienceMatch ? Number(minExperienceMatch[1]) : 0,
      maxPrice: maxPriceMatch ? Number(maxPriceMatch[1]) : 0,
      locationTerms,
      includeTypes: Array.from(new Set(includeTypes)),
    };
  }

  async smartSearch(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const query = String(payload?.query || '').trim();
    const limit = Math.min(Math.max(Number(payload?.limit || 12), 1), 25);
    const include = Array.isArray(payload?.include) ? payload.include : null;
    const hints = this.extractSearchHints(query);
    const resolvedInclude =
      include && include.length
        ? include
        : hints.includeTypes.length
          ? hints.includeTypes
          : null;

    if (!query) {
      return { query, results: [] as SearchResult[], notes: 'Query is required.' };
    }

    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        createdAt: true,
      },
      take: 600,
      orderBy: { createdAt: 'desc' },
    });
    const medicProfiles = await this.prisma.medic.findMany({
      select: {
        userId: true,
        specialization: true,
        licenseNumber: true,
        experienceYears: true,
        consultationFee: true,
      },
      take: 600,
    });
    const medicByUserId = new Map(medicProfiles.map((m) => [m.userId, m]));
    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));

    const userCandidates: SearchResult[] = users
      .map((u) => {
        const type =
          u.role === 'MEDIC'
            ? 'medic'
            : u.role === 'PATIENT'
              ? 'patient'
              : u.role === 'HOSPITAL_ADMIN'
                ? 'hospital'
                : u.role === 'PHARMACY_ADMIN'
                  ? 'pharmacy'
                  : null;
        if (!type) return null;
        if (resolvedInclude?.length && !resolvedInclude.includes(type)) return null;
        const medic = medicByUserId.get(u.id);
        const extras = (extrasMap.get(u.id) || {}) as any;

        const searchable = [
          u.fullName || '',
          u.email || '',
          u.role || '',
          medic?.specialization || '',
          String(medic?.experienceYears ?? ''),
          extras.hospitalName || '',
          extras.pharmacyName || '',
          extras.facilityType || '',
          extras.pharmacyType || '',
          extras.specialization || '',
          extras.services || '',
          extras.specialties || '',
          extras.locationTown || '',
          extras.county || '',
          extras.townCity || '',
          extras.hourlyRate || '',
          extras.consultationFee || '',
        ].join(' ');

        let score = this.scoreCandidate(query, searchable);
        const locationHaystack = `${extras.locationTown || ''} ${extras.county || ''} ${extras.townCity || ''}`.toLowerCase();
        if (hints.locationTerms.length) {
          const hasLocationHit = hints.locationTerms.some((term) =>
            locationHaystack.includes(String(term).toLowerCase()),
          );
          score += hasLocationHit ? 12 : -4;
        }
        if (type === 'medic' && hints.minExperience > 0) {
          const exp = Number(medic?.experienceYears || 0);
          score += exp >= hints.minExperience ? 14 : -10;
        }
        const fee = this.extractCurrencyNumber(
          extras.hourlyRate || extras.consultationFee || medic?.consultationFee || '',
        );
        if (hints.maxPrice > 0 && fee > 0) {
          score += fee <= hints.maxPrice ? 10 : -14;
        }
        if (score <= 0) return null;

        const subtitleBits =
          type === 'medic'
            ? [medic?.specialization, `${medic?.experienceYears ?? 0} yrs`, extras?.hourlyRate && `KES ${extras.hourlyRate}/hr`, u.email]
            : type === 'hospital'
              ? [extras.hospitalName, extras.county, extras.services || extras.specialties, u.email]
              : type === 'pharmacy'
                ? [extras.pharmacyName, extras.county || extras.townCity, u.email]
                : [u.email];

        return {
          id: u.id,
          type,
          name: u.fullName || u.email || `${type} user`,
          subtitle: subtitleBits.filter(Boolean).join(' | '),
          score,
        } as SearchResult;
      })
      .filter(Boolean) as SearchResult[];

    const candidates = [...userCandidates]
      .sort((a, b) => b.score - a.score)
      .slice(0, 80);

    if (!candidates.length) {
      return { query, results: [], notes: 'No matching records.' };
    }

    const reranked = await this.askJson<{ results: SearchResult[]; notes?: string }>(
      [
        'You are a medical operations search assistant.',
        'Rerank candidates by best match to user query.',
        'Use filters implied in query: specialization, years, location, price.',
        'Prioritize exact specialization and geographic matches.',
        'Do not fabricate IDs. Use provided IDs only.',
      ].join(' '),
      [
        `Query: ${query}`,
        `Hints JSON: ${JSON.stringify(hints)}`,
        `Return at most ${limit} results in JSON format: { "results": [ ... ], "notes": "..." }`,
        'Each result needs: id, type, name, subtitle, score(0-100), reason.',
        `Candidates JSON: ${JSON.stringify(candidates)}`,
      ].join('\n'),
      { results: candidates.slice(0, limit), notes: '' },
    );

    const safeResults = Array.isArray(reranked?.results)
      ? reranked.results
          .filter((r) => candidates.some((c) => c.id === r.id && c.type === r.type))
          .slice(0, limit)
      : candidates.slice(0, limit);

    return {
      query,
      results: safeResults.length ? safeResults : candidates.slice(0, limit),
      notes: reranked?.notes || '',
      hints,
      generatedAt: new Date().toISOString(),
    };
  }

  async analyticsSummary(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const role = String(user?.role || '');
    const isAdminLike =
      role === 'SUPER_ADMIN' || role === 'HOSPITAL_ADMIN' || role === 'PHARMACY_ADMIN';
    if (!isAdminLike) {
      return {
        summary: 'Analytics AI summary is available for admin roles only.',
        insights: [],
        alerts: [],
      };
    }

    const operations = {
      shifts: InMemoryStore.list('shifts').length,
      appointments: InMemoryStore.list('appointments').length,
      complaints: InMemoryStore.list('complaints').length,
      notifications: InMemoryStore.list('notifications').length,
      hires: InMemoryStore.list('medicHires').length,
      orders: InMemoryStore.list('orders').length,
      subscriptions: InMemoryStore.list('subscriptions').length,
      auditEvents: InMemoryStore.list('auditLogs').length,
    };

    const dbStats = {
      users: await this.prisma.user.count(),
      tenants: await this.prisma.tenant.count(),
      medics: await this.prisma.medic.count(),
      products: await this.prisma.product.count(),
      messages: await this.prisma.message.count(),
      medicalRecords: await this.prisma.medicalRecord.count(),
    };

    const summary = await this.askJson<{
      summary: string;
      insights: string[];
      alerts: string[];
      recommendations: string[];
    }>(
      [
        'You are a healthcare operations analyst.',
        'Use metrics to produce concise, practical insights.',
        'No medical diagnosis.',
      ].join(' '),
      [
        `Context role: ${role}`,
        `Timeframe hint: ${String(payload?.timeframe || 'current snapshot')}`,
        `In-memory operations: ${JSON.stringify(operations)}`,
        `Database totals: ${JSON.stringify(dbStats)}`,
        'Return JSON: { summary, insights[], alerts[], recommendations[] }',
      ].join('\n'),
      {
        summary:
          `Operational snapshot processed for ${String(payload?.timeframe || 'current window')}. ` +
          `Users: ${dbStats.users}, records: ${dbStats.medicalRecords}, orders: ${operations.orders}, complaints: ${operations.complaints}.`,
        insights: [
          operations.complaints > 0
            ? `There are ${operations.complaints} complaint record(s) requiring triage.`
            : 'No complaints currently registered in the in-memory queue.',
          operations.orders > 0
            ? `${operations.orders} pharmacy order record(s) were detected.`
            : 'No pharmacy orders currently tracked in in-memory operations.',
          operations.appointments > 0
            ? `${operations.appointments} appointment record(s) exist in current snapshot.`
            : 'No appointment records detected in in-memory snapshot.',
        ],
        alerts: [
          operations.hires > 0 ? `${operations.hires} hire workflow item(s) need monitoring.` : '',
          operations.auditEvents > 100 ? 'High audit event volume detected; review recent admin actions.' : '',
        ].filter(Boolean),
        recommendations: [
          'Review AI insights with the latest dashboard totals before actioning decisions.',
          'Prioritize unresolved complaints and pending operational workflows.',
          'Track subscription status and unpaid estimates in weekly operations review.',
        ],
      },
    );

    const summaryText = String(summary?.summary || 'Operational metrics were processed.').trim();
    const insights = this.toTextList(summary?.insights, 8);
    const alerts = this.toTextList(summary?.alerts, 8);
    const recommendations = this.toTextList(summary?.recommendations, 8);
    const speechText = this.buildSpeechText([
      summaryText,
      this.listSpeechChunk('Insights', insights, 4),
      this.listSpeechChunk('Alerts', alerts, 4),
      this.listSpeechChunk('Recommendations', recommendations, 4),
    ]);

    return {
      summary: summaryText,
      insights,
      alerts,
      recommendations,
      speechText,
      metrics: { operations, dbStats },
      generatedAt: new Date().toISOString(),
    };
  }

  private async buildQuickAssistantContext(user: any) {
    const role = String(user?.role || '').toUpperCase();
    const userId = String(user?.userId || '');
    if (!userId) return {};

    if (role === 'PATIENT') {
      const extras = (await getProfileExtras(this.prisma, userId)) as any;
      const records = await this.prisma.medicalRecord.findMany({
        where: { patientId: userId },
        include: {
          medic: {
            select: { fullName: true, email: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      return {
        role,
        profile: {
          bloodGroup: extras?.bloodGroup || null,
          allergies: extras?.allergies || null,
          chronicCondition: extras?.chronicCondition || null,
          county: extras?.county || extras?.locationCounty || null,
        },
        recentRecords: records.map((r) => ({
          type: r.type,
          condition: r.condition,
          notes: r.notes,
          medic: r.medic?.fullName || r.medic?.email || null,
          createdAt: r.createdAt,
        })),
      };
    }

    if (role === 'MEDIC') {
      const medic = await this.prisma.medic.findUnique({
        where: { userId },
        select: {
          specialization: true,
          experienceYears: true,
          consultationFee: true,
        },
      });
      const recent = await this.prisma.medicalRecord.findMany({
        where: { medicId: userId },
        select: {
          condition: true,
          type: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 12,
      });
      return {
        role,
        medic,
        recentCases: recent,
      };
    }

    const [users, tenants, medics, products, medicalRecords] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.tenant.count(),
      this.prisma.medic.count(),
      this.prisma.product.count(),
      this.prisma.medicalRecord.count(),
    ]);
    return {
      role,
      metrics: {
        users,
        tenants,
        medics,
        products,
        medicalRecords,
      },
    };
  }

  private ensureAdminRole(user: any) {
    const role = String(user?.role || '').toUpperCase();
    if (role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only super admins can use this AI admin workspace.');
    }
    return role;
  }

  private parseBooleanFilter(value: unknown) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return null;
    if (['true', 'yes', '1', 'active', 'verified'].includes(raw)) return true;
    if (['false', 'no', '0', 'inactive', 'unverified'].includes(raw)) return false;
    return null;
  }

  private safeTimeoutMs(value: unknown, fallbackMs: number, minMs = 3000, maxMs = 300000) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallbackMs;
    return Math.min(Math.max(parsed, minMs), maxMs);
  }

  private buildAdminEmailFallback(brief: string, tone: string, audience: string) {
    const trimmedBrief = String(brief || '').trim();
    const normalizedTone = String(tone || 'professional').trim().toLowerCase();
    const audienceLabel =
      audience === 'PATIENT'
        ? 'Patients'
        : audience === 'MEDIC'
          ? 'Medics'
          : audience === 'HOSPITAL_ADMIN'
            ? 'Hospital Admins'
            : audience === 'PHARMACY_ADMIN'
              ? 'Pharmacy Admins'
              : audience === 'SUPER_ADMIN'
                ? 'Admins'
                : 'Users';

    const firstSentence = trimmedBrief
      .split(/[.!?]/)
      .map((part) => part.trim())
      .filter(Boolean)[0];
    const subject = firstSentence
      ? `MediLink Update: ${firstSentence.slice(0, 70)}`
      : `MediLink Update for ${audienceLabel}`;

    const opening =
      normalizedTone.includes('friendly')
        ? `Hello ${audienceLabel},`
        : normalizedTone.includes('urgent')
          ? `Attention ${audienceLabel},`
          : `Dear ${audienceLabel},`;

    const body = [
      opening,
      '',
      trimmedBrief || 'We have an important platform update to share with you.',
      '',
      'Please open the MediLink app for details and any required action.',
      '',
      'Regards,',
      'MediLink Admin Team',
    ].join('\n');

    return {
      subject,
      body,
      preview: String(body).slice(0, 180),
      notes: 'Fallback draft generated locally due to AI timeout/unavailable response.',
      fallback: true,
    };
  }

  private summarizeEmailFallback(emailText: string) {
    const lines = String(emailText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const summary = lines.slice(0, 3).join(' ') || 'No clear summary available.';
    const actionItems = lines
      .filter((line) => /(please|action|required|deadline|urgent|review|confirm)/i.test(line))
      .slice(0, 5);

    return {
      summary: summary.slice(0, 420),
      keyPoints: lines.slice(0, 5),
      actionItems: actionItems.length ? actionItems : ['Review the full email and respond accordingly.'],
      suggestedReplySubject: 'Re: Your message',
      suggestedReplyBody: 'Thank you for your message. We have reviewed it and will follow up shortly.',
      fallback: true,
    };
  }

  private extractAudienceFromQuery(query: string) {
    const q = String(query || '').toLowerCase();
    if (/\bpatient(s)?\b/.test(q)) return 'PATIENT';
    if (/\bmedic(s)?\b|\bdoctor(s)?\b|\bnurse(s)?\b/.test(q)) return 'MEDIC';
    if (/\bhospital(s)?\b/.test(q)) return 'HOSPITAL_ADMIN';
    if (/\bpharmacy\b|\bpharmacies\b/.test(q)) return 'PHARMACY_ADMIN';
    if (/\badmin(s)?\b/.test(q)) return 'SUPER_ADMIN';
    return 'ALL';
  }

  private extractEmailFromQuery(query: string) {
    const match = String(query || '')
      .trim()
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? String(match[0]).toLowerCase() : '';
  }

  private buildNotificationDraftFromQuery(query: string, audience: string) {
    const cleaned = String(query || '').trim();
    const afterColon = cleaned.includes(':') ? cleaned.split(':').slice(1).join(':').trim() : '';
    const message =
      afterColon ||
      cleaned
        .replace(/\b(send|create|draft|broadcast|announce|notification|notify)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim() ||
      'Important platform update from Medilink Admin.';
    const subject =
      message.length > 64 ? `MediLink Update: ${message.slice(0, 64).trim()}` : `MediLink Update: ${message}`;
    return {
      title: subject,
      message,
      audience,
      sendEmail: /\bemail\b/.test(cleaned.toLowerCase()),
      emailSubject: subject,
      emailText: message,
      type: 'INFO',
    };
  }

  private extractPriorityFromQuery(query: string) {
    const q = String(query || '').toLowerCase();
    if (/\burgent\b|\bcritical\b|\bp0\b|\bhighest\b/.test(q)) return 'HIGH';
    if (/\blow\b|\bminor\b|\bp3\b/.test(q)) return 'LOW';
    return 'MEDIUM';
  }

  private extractSeverityFromQuery(query: string) {
    const q = String(query || '').toLowerCase();
    if (/\bcritical\b|\blife[- ]?threatening\b|\bsevere\b/.test(q)) return 'CRITICAL';
    if (/\bhigh\b|\burgent\b/.test(q)) return 'HIGH';
    if (/\blow\b|\bminor\b/.test(q)) return 'LOW';
    return 'MEDIUM';
  }

  private extractComplianceScopeFromQuery(query: string) {
    const q = String(query || '').toLowerCase();
    if (/\baudit\b/.test(q)) return 'audit';
    if (/\bprivacy\b/.test(q)) return 'privacy';
    if (/\bpayments?\b/.test(q)) return 'payments';
    if (/\busers?\b/.test(q)) return 'users';
    return 'overview';
  }

  private extractFeatureFlagUpdateFromQuery(query: string) {
    const q = String(query || '').toLowerCase();
    const enable = /\benable\b|\bturn on\b|\bactivate\b/.test(q);
    const disable = /\bdisable\b|\bturn off\b|\bdeactivate\b/.test(q);
    if (!enable && !disable) return null;

    let flag = String(query || '')
      .replace(/\b(enable|disable|turn on|turn off|activate|deactivate|feature flag|flag|feature|set)\b/gi, ' ')
      .replace(/[^a-zA-Z0-9 _-]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .toLowerCase();

    if (!flag) return null;
    flag = flag.replace(/[\s-]+/g, '_');
    return {
      flag,
      value: enable && !disable,
    };
  }

  private buildSupportTicketDraftFromQuery(query: string) {
    const cleaned = String(query || '')
      .replace(/\b(create|open|raise|submit|new|support|ticket)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const subjectBase = cleaned || 'Support Request';
    const subject = subjectBase.length > 80 ? subjectBase.slice(0, 80).trim() : subjectBase;
    return {
      subject,
      description: cleaned || 'Issue reported by AI help desk automation.',
      priority: this.extractPriorityFromQuery(query),
    };
  }

  private buildEmergencyIncidentDraftFromQuery(query: string) {
    const raw = String(query || '').trim();
    const locationMatch = raw.match(/\b(?:at|in|near)\s+([a-zA-Z0-9 ,.-]{3,80})/i);
    const location = String(locationMatch?.[1] || '').trim();
    const cleaned = raw
      .replace(/\b(create|open|raise|report|trigger|dispatch|emergency|incident)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const titleBase = cleaned || 'Emergency Incident';
    return {
      title: titleBase.length > 72 ? titleBase.slice(0, 72).trim() : titleBase,
      location: location || null,
      severity: this.extractSeverityFromQuery(query),
      notes: raw,
    };
  }

  private resolveAdminRouteFromQuery(query: string) {
    const q = String(query || '').toLowerCase();
    if (!/\b(open|go to|navigate|show|take me to|view)\b/.test(q)) {
      return null;
    }

    const routes = [
      { route: '/(app)/(admin)/users', label: 'users', terms: ['user', 'users', 'accounts'] },
      {
        route: '/(app)/(admin)/analytics',
        label: 'analytics',
        terms: ['analytics', 'reports', 'stats', 'dashboard'],
      },
      {
        route: '/(app)/(admin)/notifications',
        label: 'notifications',
        terms: ['notification', 'notifications', 'announcements'],
      },
      { route: '/(app)/(admin)/email-center', label: 'email center', terms: ['email', 'mail'] },
      {
        route: '/(app)/(admin)/subscriptions',
        label: 'subscriptions',
        terms: ['subscription', 'subscriptions', 'billing'],
      },
      { route: '/(app)/(admin)/complaints', label: 'complaints', terms: ['complaint', 'complaints'] },
      { route: '/(app)/(admin)/audit-logs', label: 'audit logs', terms: ['audit', 'logs', 'history'] },
      {
        route: '/(app)/(admin)/control-center',
        label: 'control center',
        terms: ['control center', 'operations', 'compliance', 'platform health'],
      },
      { route: '/(app)/(admin)/chat', label: 'chat', terms: ['chat', 'messages', 'support chat'] },
      { route: '/(app)/(admin)/settings', label: 'settings', terms: ['setting', 'settings'] },
    ];

    for (const item of routes) {
      if (item.terms.some((term) => q.includes(term))) {
        return item;
      }
    }
    return null;
  }

  private applyAdminUserFilters(
    users: Array<{
      id: string;
      fullName: string;
      email: string;
      phone: string | null;
      role: string;
      status: string;
      createdAt: Date;
      verified: boolean;
      subscriptionActive: boolean;
      location: string;
      isOnline: boolean;
    }>,
    filters: {
      role?: string | null;
      status?: string | null;
      verified?: boolean | null;
      subscriptionActive?: boolean | null;
      online?: boolean | null;
      search?: string | null;
    },
  ) {
    const role = String(filters?.role || '').trim().toUpperCase();
    const status = String(filters?.status || '').trim().toLowerCase();
    const search = String(filters?.search || '').trim().toLowerCase();
    const verified = filters?.verified ?? null;
    const subscriptionActive = filters?.subscriptionActive ?? null;
    const online = filters?.online ?? null;

    let list = users.slice();
    if (role) {
      list = list.filter((item) => String(item.role || '').toUpperCase() === role);
    }
    if (status) {
      list = list.filter((item) => String(item.status || '').toLowerCase() === status);
    }
    if (verified !== null) {
      list = list.filter((item) => Boolean(item.verified) === Boolean(verified));
    }
    if (subscriptionActive !== null) {
      list = list.filter(
        (item) => Boolean(item.subscriptionActive) === Boolean(subscriptionActive),
      );
    }
    if (online !== null) {
      list = list.filter((item) => Boolean(item.isOnline) === Boolean(online));
    }
    if (search) {
      const terms = search.split(/\s+/).filter(Boolean);
      list = list.filter((item) => {
        const haystack =
          `${item.fullName} ${item.email} ${item.phone || ''} ${item.location} ${item.role}`
            .toLowerCase()
            .trim();
        return terms.every((term) => haystack.includes(term));
      });
    }
    return list;
  }

  async adminUsersAssistant(payload: any, user: any) {
    await this.ensureAiAccess(user);
    this.ensureAdminRole(user);

    const query = String(payload?.query || '').trim();
    if (!query) {
      return {
        query,
        suggestedFilters: {},
        totalMatched: 0,
        results: [],
        notes: 'Query is required.',
      };
    }

    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));
    const indexed = users.map((item) => {
      const extras = extrasMap.get(item.id) || {};
      return {
        id: item.id,
        fullName: String(item.fullName || '').trim() || 'Unknown User',
        email: String(item.email || '').trim().toLowerCase(),
        phone: item.phone || null,
        role: String(item.role || ''),
        status: String(item.status || ''),
        createdAt: item.createdAt,
        verified: Boolean((extras as any)?.verified || (extras as any)?.isVerified),
        subscriptionActive: Boolean((extras as any)?.subscriptionActive),
        location: String(
          (extras as any)?.location?.address ||
            (extras as any)?.locationAddress ||
            (extras as any)?.address ||
            '',
        ),
        isOnline: this.notificationsGateway.isUserOnline(item.id),
      };
    });

    const aiFilters = await this.askJson<{
      role?: string;
      status?: string;
      verified?: boolean | string;
      subscriptionActive?: boolean | string;
      online?: boolean | string;
      search?: string;
      notes?: string;
    }>(
      [
        'You extract admin user filter criteria from a natural language query.',
        'Return only valid JSON.',
        'Allowed role values: PATIENT, MEDIC, HOSPITAL_ADMIN, PHARMACY_ADMIN, SUPER_ADMIN.',
        'Allowed status values: active, suspended.',
      ].join(' '),
      [
        `Query: ${query}`,
        'Return JSON shape:',
        '{ "role": "...", "status": "...", "verified": true|false|null, "subscriptionActive": true|false|null, "online": true|false|null, "search": "...", "notes": "..." }',
      ].join('\n'),
      {
        search: query,
      },
    );

    const allowedRoles = [
      'PATIENT',
      'MEDIC',
      'HOSPITAL_ADMIN',
      'PHARMACY_ADMIN',
      'SUPER_ADMIN',
    ];
    const allowedStatuses = ['active', 'suspended'];
    const normalizedRole = String(aiFilters?.role || '').trim().toUpperCase();
    const normalizedStatus = String(aiFilters?.status || '').trim().toLowerCase();
    const queryLower = query.toLowerCase();
    const inferredOnline =
      /\boffline\b/.test(queryLower)
        ? false
        : /\bonline\b/.test(queryLower)
          ? true
          : null;
    const inferredRole =
      /medic|doctor|nurse/.test(queryLower)
        ? 'MEDIC'
        : /patient/.test(queryLower)
          ? 'PATIENT'
          : /hospital/.test(queryLower)
            ? 'HOSPITAL_ADMIN'
            : /pharmacy/.test(queryLower)
              ? 'PHARMACY_ADMIN'
              : '';

    const suggestedFilters = {
      role: allowedRoles.includes(normalizedRole)
        ? normalizedRole
        : allowedRoles.includes(inferredRole)
          ? inferredRole
          : null,
      status: allowedStatuses.includes(normalizedStatus) ? normalizedStatus : null,
      verified: this.parseBooleanFilter(aiFilters?.verified),
      subscriptionActive: this.parseBooleanFilter(aiFilters?.subscriptionActive),
      online: this.parseBooleanFilter(aiFilters?.online) ?? inferredOnline,
      search: String(aiFilters?.search || query).trim() || null,
    };

    const filtered = this.applyAdminUserFilters(indexed, suggestedFilters);
    const scored = filtered
      .map((item) => {
        const haystack =
          `${item.fullName} ${item.email} ${item.phone || ''} ${item.role} ${item.location}`
            .toLowerCase()
            .trim();
        const baseScore = this.scoreCandidate(query, haystack);
        const boost =
          String(item.status || '').toLowerCase() === 'active'
            ? 3
            : 0;
        return {
          ...item,
          score: Math.min(100, baseScore + boost),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);

    return {
      query,
      suggestedFilters,
      totalMatched: filtered.length,
      results: scored,
      notes:
        String(aiFilters?.notes || '').trim() ||
        'AI filters were applied to the admin user list.',
      generatedAt: new Date().toISOString(),
    };
  }

  async adminEmailAssistant(payload: any, user: any) {
    await this.ensureAiAccess(user);
    this.ensureAdminRole(user);

    const mode = String(payload?.mode || '').trim().toLowerCase();
    if (mode === 'summarize') {
      const emailText = String(payload?.emailText || '').trim();
      if (!emailText) {
        return {
          mode,
          summary: '',
          keyPoints: [],
          actionItems: [],
          notes: 'emailText is required for summarize mode.',
        };
      }
      const emailTimeoutMs = this.safeTimeoutMs(
        process.env.AI_EMAIL_TIMEOUT_MS,
        45000,
        5000,
        180000,
      );
      const summarized = (await Promise.race([
        this.askJson<{
          summary: string;
          keyPoints: string[];
          actionItems: string[];
          suggestedReplySubject: string;
          suggestedReplyBody: string;
        }>(
          [
            'You are an admin email assistant.',
            'Summarize an incoming email for operational action.',
            'Return concise and actionable output.',
          ].join(' '),
          [
            'Input email:',
            emailText,
            'Return JSON with keys:',
            '{ "summary": "...", "keyPoints": [], "actionItems": [], "suggestedReplySubject": "...", "suggestedReplyBody": "..." }',
          ].join('\n'),
          {
            summary: '',
            keyPoints: [],
            actionItems: [],
            suggestedReplySubject: '',
            suggestedReplyBody: '',
          },
        ),
        new Promise<any>((resolve) => setTimeout(() => resolve(null), emailTimeoutMs)),
      ])) as
        | {
            summary: string;
            keyPoints: string[];
            actionItems: string[];
            suggestedReplySubject: string;
            suggestedReplyBody: string;
          }
        | null;

      const fallback = this.summarizeEmailFallback(emailText);
      const finalSummary = String(summarized?.summary || '').trim() || fallback.summary;
      const finalKeyPoints =
        Array.isArray(summarized?.keyPoints) && summarized?.keyPoints?.length
          ? summarized.keyPoints.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 8)
          : fallback.keyPoints;
      const finalActionItems =
        Array.isArray(summarized?.actionItems) && summarized?.actionItems?.length
          ? summarized.actionItems
              .map((p) => String(p || '').trim())
              .filter(Boolean)
              .slice(0, 8)
          : fallback.actionItems;
      const suggestedReplySubject =
        String(summarized?.suggestedReplySubject || '').trim() || fallback.suggestedReplySubject;
      const suggestedReplyBody =
        String(summarized?.suggestedReplyBody || '').trim() || fallback.suggestedReplyBody;
      const speechText = this.buildSpeechText([
        finalSummary,
        this.listSpeechChunk('Key points', finalKeyPoints, 4),
        this.listSpeechChunk('Action items', finalActionItems, 4),
      ]);

      return {
        mode,
        summary: finalSummary,
        keyPoints: finalKeyPoints,
        actionItems: finalActionItems,
        suggestedReplySubject,
        suggestedReplyBody,
        speechText,
        generatedAt: new Date().toISOString(),
        fallbackUsed: !summarized || !String(summarized?.summary || '').trim(),
      };
    }

    const brief = String(payload?.brief || '').trim();
    if (!brief) {
      return {
        mode: 'compose',
        subject: '',
        body: '',
        notes: 'brief is required for compose mode.',
      };
    }
    const tone = String(payload?.tone || 'professional').trim();
    const audience = String(payload?.audience || 'ALL').trim().toUpperCase();
    const emailTimeoutMs = this.safeTimeoutMs(
      process.env.AI_EMAIL_TIMEOUT_MS,
      45000,
      5000,
      180000,
    );
    const drafted = (await Promise.race([
      this.askJson<{
        subject: string;
        body: string;
        preview: string;
        notes: string;
      }>(
        [
          'You draft operational admin emails.',
          'Keep language clear, respectful and concise.',
          'Use neutral tone and no promises you cannot verify.',
        ].join(' '),
        [
          `Audience: ${audience}`,
          `Tone: ${tone}`,
          `Brief: ${brief}`,
          'Return JSON with keys: { "subject": "...", "body": "...", "preview": "...", "notes": "..." }',
        ].join('\n'),
        {
          subject: '',
          body: '',
          preview: '',
          notes: '',
        },
      ),
      new Promise<any>((resolve) => setTimeout(() => resolve(null), emailTimeoutMs)),
    ])) as { subject: string; body: string; preview: string; notes: string } | null;

    const fallback = this.buildAdminEmailFallback(brief, tone, audience);
    const subject = String(drafted?.subject || '').trim() || fallback.subject;
    const body = String(drafted?.body || '').trim() || fallback.body;
    const preview = String(drafted?.preview || '').trim() || fallback.preview;
    const notes = String(drafted?.notes || '').trim() || fallback.notes;
    const speechText = this.buildSpeechText([
      `Subject: ${subject}`,
      preview || body,
    ]);

    return {
      mode: 'compose',
      subject,
      body,
      preview,
      notes,
      speechText,
      fallbackUsed: !drafted || !String(drafted?.subject || '').trim() || !String(drafted?.body || '').trim(),
      generatedAt: new Date().toISOString(),
    };
  }

  async helpDesk(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const query = String(payload?.query || '').trim();
    if (!query) {
      return {
        intent: 'unknown',
        answer: 'Please provide your question or task request.',
        actions: [],
      };
    }

    const role = String(user?.role || '').toUpperCase();
    const normalized = query.toLowerCase();
    const execute = Boolean(payload?.execute);
    const routeIntent = this.resolveAdminRouteFromQuery(normalized);

    if (routeIntent) {
      return {
        intent: 'navigate',
        answer: `Opening ${routeIntent.label}.`,
        actions: [{ type: 'OPEN_SCREEN', target: routeIntent.route }],
        generatedAt: new Date().toISOString(),
      };
    }

    if (/search|find|filter/.test(normalized) && /user|users|account/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'search_users',
          answer: 'User search automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/users' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const data = await this.adminUsersAssistant({ query }, user);
      return {
        intent: 'search_users',
        answer: `I found ${Number(data?.totalMatched || 0)} matching users and prepared suggested filters.`,
        actions: [
          { type: 'OPEN_SCREEN', target: '/(app)/(admin)/users', params: data?.suggestedFilters || {} },
        ],
        data,
        generatedAt: new Date().toISOString(),
      };
    }

    if (/notify|notification|announce|broadcast|send update/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'send_notification',
          answer: 'Notification automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/notifications' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const audience = this.extractAudienceFromQuery(query);
      const notification = this.buildNotificationDraftFromQuery(query, audience);
      return {
        intent: 'send_notification',
        answer: execute
          ? `Sending notification to ${audience} audience.`
          : `I prepared a notification draft for ${audience} audience.`,
        actions: [{ type: 'SEND_NOTIFICATION', payload: notification, execute }],
        data: notification,
        generatedAt: new Date().toISOString(),
      };
    }

    if (/(create|open|raise|submit).*(support ticket|ticket)|(support ticket|ticket).*(create|open|raise|submit)/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'create_support_ticket',
          answer: 'Support ticket automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/chat' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const ticket = this.buildSupportTicketDraftFromQuery(query);
      return {
        intent: 'create_support_ticket',
        answer: execute
          ? 'Creating a support ticket now.'
          : 'I prepared a support ticket draft for review.',
        actions: [{ type: 'CREATE_SUPPORT_TICKET', payload: ticket, execute }],
        data: ticket,
        generatedAt: new Date().toISOString(),
      };
    }

    if (/(emergency|incident|dispatch).*(create|open|raise|report|trigger|dispatch)|(create|open|raise|report|trigger|dispatch).*(emergency|incident|dispatch)/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'create_emergency_incident',
          answer: 'Emergency automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/control-center' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const incident = this.buildEmergencyIncidentDraftFromQuery(query);
      return {
        intent: 'create_emergency_incident',
        answer: execute
          ? 'Creating emergency incident now.'
          : 'I prepared an emergency incident draft for review.',
        actions: [{ type: 'CREATE_EMERGENCY_INCIDENT', payload: incident, execute }],
        data: incident,
        generatedAt: new Date().toISOString(),
      };
    }

    if (/suspend|block|unsuspend|unblock|verify|unverify/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'manage_user_status',
          answer: 'User status automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/users' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const email = this.extractEmailFromQuery(query);
      if (!email) {
        return {
          intent: 'manage_user_status',
          answer: 'Please include the user email in your command.',
          actions: [],
          generatedAt: new Date().toISOString(),
        };
      }

      const target = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true, fullName: true, email: true, status: true, role: true },
      });
      if (!target) {
        return {
          intent: 'manage_user_status',
          answer: `No user found with email ${email}.`,
          actions: [],
          generatedAt: new Date().toISOString(),
        };
      }

      if (/verify/.test(normalized)) {
        const verified = !/unverify/.test(normalized);
        return {
          intent: 'manage_user_status',
          answer: execute
            ? `${verified ? 'Verifying' : 'Removing verification for'} ${target.email}.`
            : `I can ${verified ? 'verify' : 'remove verification for'} ${target.email}.`,
          actions: [{ type: 'VERIFY_USER', userId: target.id, verified, execute }],
          data: target,
          generatedAt: new Date().toISOString(),
        };
      }

      const blocked = /suspend|block/.test(normalized) && !/unsuspend|unblock/.test(normalized);
      return {
        intent: 'manage_user_status',
        answer: execute
          ? `${blocked ? 'Suspending' : 'Unsuspending'} ${target.email}.`
          : `I can ${blocked ? 'suspend' : 'unsuspend'} ${target.email}.`,
        actions: [{ type: 'BLOCK_USER', userId: target.id, blocked, execute }],
        data: target,
        generatedAt: new Date().toISOString(),
      };
    }

    if (/analytics|report|dashboard summary|platform health|stats/.test(normalized)) {
      const summary = await this.analyticsSummary({ timeframe: 'current snapshot' }, user);
      return {
        intent: 'analytics_summary',
        answer: String(summary?.summary || 'Analytics summary generated.'),
        data: summary,
        actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/analytics' }],
        generatedAt: new Date().toISOString(),
      };
    }

    if (/(export|generate|create).*(compliance|privacy|snapshot|data export)|(compliance|privacy|snapshot|data export).*(export|generate|create)/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'export_compliance',
          answer: 'Compliance export automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/audit-logs' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const scope = this.extractComplianceScopeFromQuery(query);
      return {
        intent: 'export_compliance',
        answer: execute
          ? `Generating ${scope} compliance snapshot now.`
          : `I can generate a ${scope} compliance snapshot.`,
        actions: [{ type: 'EXPORT_COMPLIANCE', scope, execute }],
        data: { scope },
        generatedAt: new Date().toISOString(),
      };
    }

    if (/feature flag|feature toggle|\bflag\b/.test(normalized) && /(enable|disable|turn on|turn off|activate|deactivate)/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'update_feature_flag',
          answer: 'Feature flag automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/settings' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const target = this.extractFeatureFlagUpdateFromQuery(query);
      if (!target?.flag) {
        return {
          intent: 'update_feature_flag',
          answer: 'Please specify which feature flag to update. Example: "enable feature flag ai_voice_enabled".',
          actions: [],
          generatedAt: new Date().toISOString(),
        };
      }
      return {
        intent: 'update_feature_flag',
        answer: execute
          ? `Updating feature flag ${target.flag} to ${target.value ? 'enabled' : 'disabled'}.`
          : `I can set feature flag ${target.flag} to ${target.value ? 'enabled' : 'disabled'}.`,
        actions: [{ type: 'UPDATE_FEATURE_FLAG', flag: target.flag, value: target.value, execute }],
        data: target,
        generatedAt: new Date().toISOString(),
      };
    }

    if (/(draft|write|compose).*(email)|email.*(draft|write|compose)/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'draft_email',
          answer: 'Email drafting automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/email-center' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const tone = String(payload?.tone || 'professional');
      const audience = String(payload?.audience || 'ALL');
      const draft = await this.adminEmailAssistant(
        { mode: 'compose', brief: query, tone, audience },
        user,
      );
      return {
        intent: 'draft_email',
        answer: 'I prepared an email draft for you.',
        actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/email-center' }],
        data: draft,
        generatedAt: new Date().toISOString(),
      };
    }

    if (/summari[sz]e.*email|email.*summari[sz]e/.test(normalized)) {
      if (role !== 'SUPER_ADMIN') {
        return {
          intent: 'summarize_email',
          answer: 'Email summarization automation is available for super admin only.',
          actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/email-center' }],
          generatedAt: new Date().toISOString(),
        };
      }
      const emailText = String(payload?.emailText || '').trim();
      if (!emailText) {
        return {
          intent: 'summarize_email',
          answer: 'Paste email text to summarize it.',
          actions: [],
          generatedAt: new Date().toISOString(),
        };
      }
      const summary = await this.adminEmailAssistant({ mode: 'summarize', emailText }, user);
      return {
        intent: 'summarize_email',
        answer: 'I summarized the email and extracted action items.',
        data: summary,
        actions: [{ type: 'OPEN_SCREEN', target: '/(app)/(admin)/email-center' }],
        generatedAt: new Date().toISOString(),
      };
    }

    if (/enable ai|turn on ai/.test(normalized)) {
      if (execute) {
        await this.updateSettings(user, { enabled: true });
      }
      return {
        intent: 'toggle_ai',
        answer: execute
          ? 'AI has been enabled for your account.'
          : 'I can enable AI for your account. Run this task with execute=true.',
        actions: [{ type: 'TOGGLE_AI', enabled: true, execute }],
        generatedAt: new Date().toISOString(),
      };
    }

    if (/disable ai|turn off ai/.test(normalized)) {
      if (execute) {
        await this.updateSettings(user, { enabled: false });
      }
      return {
        intent: 'toggle_ai',
        answer: execute
          ? 'AI has been disabled for your account.'
          : 'I can disable AI for your account. Run this task with execute=true.',
        actions: [{ type: 'TOGGLE_AI', enabled: false, execute }],
        generatedAt: new Date().toISOString(),
      };
    }

    const guide = this.buildAppUsageGuide(role, payload?.topic, query);
    const helpDeskTimeoutMs = this.safeTimeoutMs(
      process.env.AI_HELPDESK_TIMEOUT_MS,
      20000,
      4000,
      90000,
    );
    const assistant = (await Promise.race([
      this.quickAssistant({ query, topic: payload?.topic }, user),
      new Promise<any>((resolve) => setTimeout(() => resolve(null), helpDeskTimeoutMs)),
    ])) as any;
    const answer = String(assistant?.answer || '').trim() || guide.summary;
    return {
      intent: 'help',
      answer,
      appHelp: guide,
      fallbackUsed: !assistant,
      actions: [
        { type: 'OPEN_SCREEN', target: '/(app)/(shared)/settings' },
      ],
      generatedAt: new Date().toISOString(),
    };
  }

  async appHelp(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const role = String(user?.role || '');
    const topic = payload?.topic;
    const query = String(payload?.query || '').trim();
    const guide = this.buildAppUsageGuide(role, topic, query);

    return {
      ...guide,
      generatedAt: new Date().toISOString(),
    };
  }

  async quickAssistant(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const query = String(payload?.query || '').trim();
    if (!query) return { answer: 'Please provide a question.' };
    const role = String(user?.role || '');
    if (this.looksLikeAppHelpQuery(query)) {
      const guide = this.buildAppUsageGuide(role, payload?.topic, query);
      const answer = [
        `${guide.title}`,
        `${guide.summary}`,
        '',
        'Steps:',
        ...guide.steps.map((step, index) => `${index + 1}. ${step}`),
        '',
        'Tips:',
        ...guide.tips.map((tip) => `- ${tip}`),
      ].join('\n');

      return {
        answer,
        speechText: `${guide.title}. ${guide.summary}`,
        appHelp: guide,
        generatedAt: new Date().toISOString(),
      };
    }

    const context = await this.buildQuickAssistantContext(user);
    const answer = await this.askText(
      [
        'You are Medilink AI assistant.',
        'Scope: app workflows, analytics interpretation, record summaries, search guidance, and role-based onboarding help.',
        'Use provided RAG context from Medilink data; if missing, say what data is needed.',
        'When asked about app usage, provide numbered steps and mention the relevant module/screen.',
        'Do not provide diagnosis. Be concise and actionable.',
      ].join(' '),
      [
        `User role: ${role}`,
        `RAG context JSON: ${JSON.stringify(context)}`,
        `Question: ${query}`,
      ].join('\n'),
      'I could not generate an answer.',
    );
    return {
      answer,
      speechText: String(answer || '').slice(0, 420),
      generatedAt: new Date().toISOString(),
    };
  }
}
