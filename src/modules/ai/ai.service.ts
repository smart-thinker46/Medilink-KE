import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { mergeProfileExtras, getProfileExtras, getProfileExtrasMap } from 'src/common/profile-extras';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';

type SearchResult = {
  id: string;
  type: 'patient' | 'medic' | 'hospital' | 'pharmacy';
  name: string;
  subtitle?: string;
  score: number;
  reason?: string;
};

type AiProvider = 'openai' | 'gemini';

type AiAccessState = {
  userId: string;
  provider: AiProvider;
  isPremium: boolean;
  aiEnabled: boolean;
  canUse: boolean;
  blockedReason?: string | null;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly provider: AiProvider;
  private readonly openAiApiKey: string;
  private readonly openAiModel: string;
  private readonly geminiApiKey: string;
  private readonly geminiModel: string;
  private aiCooldownUntil = 0;
  private aiCooldownReason: string | null = null;
  private lastAiErrorLogAt = 0;

  constructor(private readonly prisma: PrismaService) {
    const configuredProvider = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
    this.openAiApiKey = process.env.OPENAI_API_KEY?.trim() || '';
    this.geminiApiKey = process.env.GEMINI_API_KEY?.trim() || '';

    this.provider =
      configuredProvider === 'gemini'
        ? 'gemini'
        : configuredProvider === 'openai'
            ? 'openai'
            : this.geminiApiKey
              ? 'gemini'
              : 'openai';

    this.openAiModel = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
    this.geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-1.5-flash';
  }

  private get isAiCoolingDown() {
    return Date.now() < this.aiCooldownUntil;
  }

  private aiUnavailableReason() {
    if (this.isAiCoolingDown) {
      return (
        this.aiCooldownReason ||
        'AI service temporarily unavailable due to quota/rate limits.'
      );
    }
    if (this.provider === 'gemini' && !this.geminiApiKey) {
      return 'AI service not configured: missing GEMINI_API_KEY.';
    }
    if (this.provider === 'openai' && !this.openAiApiKey) {
      return 'AI service not configured: missing OPENAI_API_KEY.';
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
    const providerName = this.provider.toUpperCase();

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
        `AI unavailable: ${providerName} quota exceeded. Enable billing/increase quota, then retry later.`;
    } else if (isRateLimit) {
      this.markCooldown(60 * 1000);
      this.aiCooldownReason = `AI temporarily rate limited by ${providerName}. Please retry shortly.`;
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

  private async askJson<T>(system: string, prompt: string, fallback: T): Promise<T> {
    if (this.aiUnavailableReason()) {
      return fallback;
    }
    try {
      const output =
        this.provider === 'gemini'
          ? await this.askGemini(system, prompt, true)
          : await this.askOpenAi(system, prompt, true);
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
      const output =
        this.provider === 'gemini'
          ? await this.askGemini(system, prompt, false)
          : await this.askOpenAi(system, prompt, false);
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
    const aiEnabled = Boolean(extras?.aiEnabled);
    const providerIssue = this.aiUnavailableReason();

    let blockedReason: string | null = null;
    if (!isPremium) {
      blockedReason = 'AI is a premium feature. Activate a subscription first.';
    } else if (!aiEnabled) {
      blockedReason = 'AI is disabled. Enable AI in Settings to use this feature.';
    } else if (providerIssue) {
      blockedReason = providerIssue;
    }

    return {
      userId,
      provider: this.provider,
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
      isPremium: state.isPremium,
      aiEnabled: state.aiEnabled,
      canUse: state.canUse,
      blockedReason: state.blockedReason || null,
    };
  }

  async getAccessState(user: any) {
    return this.getAiAccessState(user);
  }

  async assertAccess(user: any) {
    return this.ensureAiAccess(user);
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
      throw new ForbiddenException('AI is a premium feature. Activate a subscription first.');
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

    const json = await this.askJson<{
      summary: string;
      highlights: string[];
      risks: string[];
      nextSteps: string[];
      disclaimer?: string;
    }>(
      [
        'You are a clinical documentation assistant.',
        'You summarize records, not diagnose.',
        'Keep language clear and conservative.',
        'Always include a short caution that this is not medical advice.',
      ].join(' '),
      [
        'Create a health status summary from this JSON.',
        'Return valid JSON with keys:',
        'summary (string), highlights (array of max 6), risks (array of max 6), nextSteps (array of max 6), disclaimer (string).',
        JSON.stringify(compact),
      ].join('\n'),
      {
        summary: 'No sufficient data to summarize health status.',
        highlights: [],
        risks: [],
        nextSteps: [],
        disclaimer: 'This summary is informational and not a medical diagnosis.',
      },
    );

    return {
      patientId,
      ...json,
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

  async smartSearch(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const query = String(payload?.query || '').trim();
    const limit = Math.min(Math.max(Number(payload?.limit || 12), 1), 25);
    const include = Array.isArray(payload?.include) ? payload.include : null;

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
        if (include?.length && !include.includes(type)) return null;
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

        const score = this.scoreCandidate(query, searchable);
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
        'Do not fabricate IDs. Use provided IDs only.',
      ].join(' '),
      [
        `Query: ${query}`,
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
        summary: 'Operational metrics were processed.',
        insights: [],
        alerts: [],
        recommendations: [],
      },
    );

    return {
      ...summary,
      metrics: { operations, dbStats },
      generatedAt: new Date().toISOString(),
    };
  }

  async quickAssistant(payload: any, user: any) {
    await this.ensureAiAccess(user);

    const query = String(payload?.query || '').trim();
    if (!query) return { answer: 'Please provide a question.' };
    const role = String(user?.role || '');
    const answer = await this.askText(
      [
        'You are Medilink AI assistant.',
        'Scope: app workflows, analytics interpretation, record summaries and entity discovery.',
        'Do not provide diagnosis. Be concise and actionable.',
      ].join(' '),
      `User role: ${role}\nQuestion: ${query}`,
      'I could not generate an answer.',
    );
    return { answer, generatedAt: new Date().toISOString() };
  }
}
