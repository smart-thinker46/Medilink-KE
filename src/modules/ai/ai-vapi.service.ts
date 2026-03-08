import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { InMemoryStore } from 'src/common/in-memory.store';
import { AiService } from './ai.service';
import { AiVoiceToolsService } from './ai-voice-tools.service';

type VoiceMode = 'search' | 'support' | 'emergency' | 'records' | 'general';

@Injectable()
export class AiVapiService {
  private readonly logger = new Logger(AiVapiService.name);

  constructor(
    private readonly aiService: AiService,
    private readonly tools: AiVoiceToolsService,
  ) {}

  private get vapiPublicKey() {
    return String(process.env.VAPI_PUBLIC_KEY || '').trim();
  }

  private get vapiAssistantId() {
    return String(process.env.VAPI_ASSISTANT_ID || '').trim();
  }

  private get webhookSecret() {
    return String(process.env.VAPI_WEBHOOK_SECRET || '').trim();
  }

  private get backendPublicUrl() {
    return String(process.env.BACKEND_PUBLIC_URL || process.env.APP_BASE_URL || '').trim().replace(
      /\/+$/,
      '',
    );
  }

  private get normalizedWebhookUrl() {
    const explicit = String(process.env.VAPI_WEBHOOK_URL || '').trim();
    if (explicit) return explicit;
    if (this.backendPublicUrl) return `${this.backendPublicUrl}/api/ai/voice/webhook`;
    return '';
  }

  private modeTools(mode: VoiceMode) {
    if (mode === 'search') {
      return ['search_medics', 'search_hospitals', 'search_pharmacy_products', 'guide_app_usage'];
    }
    if (mode === 'support') {
      return ['request_support_chat', 'guide_app_usage'];
    }
    if (mode === 'emergency') {
      return ['get_emergency_contacts', 'search_medics', 'search_hospitals', 'guide_app_usage'];
    }
    if (mode === 'records') {
      return ['summarize_health_record', 'search_pharmacy_products', 'guide_app_usage'];
    }
    return [
      'search_medics',
      'search_hospitals',
      'search_pharmacy_products',
      'summarize_health_record',
      'get_emergency_contacts',
      'request_support_chat',
      'guide_app_usage',
    ];
  }

  private normalizeMode(value: unknown): VoiceMode {
    const mode = String(value || 'general').trim().toLowerCase();
    if (mode === 'search' || mode === 'support' || mode === 'emergency' || mode === 'records') {
      return mode;
    }
    return 'general';
  }

  private buildSystemPrompt(mode: VoiceMode, role: string) {
    const base = [
      'You are Medilink AI Voice Assistant.',
      'Keep responses concise and actionable.',
      'Never claim to be a doctor and never provide diagnosis.',
      'Use tool calls for data retrieval; do not fabricate records.',
      'For emergency requests, prioritize nearest valid contacts and advise immediate phone dialing.',
    ];
    if (mode === 'search') {
      base.push('Focus on discovery: medics, hospitals, and pharmacy products.');
    } else if (mode === 'support') {
      base.push('Focus on support triage and escalate to admin when needed.');
    } else if (mode === 'emergency') {
      base.push('Focus on emergency contact resolution and urgent next action.');
    } else if (mode === 'records') {
      base.push('Focus on health-record summaries and medication lookup.');
    } else {
      base.push('Handle mixed workflows across search, records, emergency, and support.');
    }
    base.push(`Current user role: ${role}.`);
    return base.join(' ');
  }

  async createSession(user: any, payload: any) {
    const access = await this.aiService.getAccessState(user);
    if (!access?.canUse) {
      throw new ForbiddenException(access?.blockedReason || 'AI access denied.');
    }

    const mode = this.normalizeMode(payload?.mode);
    const userId = String(user?.userId || '');
    if (!userId) throw new ForbiddenException('Unauthorized');
    const role = String(user?.role || '').toUpperCase();

    const session = InMemoryStore.create('aiVoiceSessions', {
      userId,
      role,
      provider: 'vapi',
      mode,
      status: 'ACTIVE',
      tools: this.modeTools(mode),
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationSec: null,
      premiumCharged: false,
      metadata: {
        locale: payload?.locale || 'en-KE',
        platform: payload?.platform || 'mobile',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    InMemoryStore.create('aiVoiceEvents', {
      sessionId: session.id,
      eventType: 'session_created',
      payloadJson: {
        mode,
        role,
      },
      createdAt: new Date().toISOString(),
    } as any);

    return {
      sessionId: session.id,
      provider: 'vapi',
      mode,
      status: session.status,
      tools: session.tools,
      vapi: {
        publicKey: this.vapiPublicKey || null,
        assistantId: this.vapiAssistantId || null,
        webhookUrl: this.normalizedWebhookUrl || null,
        configured: Boolean(this.vapiPublicKey && this.vapiAssistantId),
      },
      systemPrompt: this.buildSystemPrompt(mode, role),
      warning:
        this.vapiPublicKey && this.vapiAssistantId
          ? null
          : 'Vapi keys are not configured. Voice session works in app-guided mode only.',
    };
  }

  async listHistory(user: any, query: any) {
    const role = String(user?.role || '').toUpperCase();
    const userId = String(user?.userId || '');
    const sessionId = String(query?.sessionId || '').trim();
    const limit = Math.min(Math.max(Number(query?.limit || 20), 1), 100);

    let sessions = (InMemoryStore.list('aiVoiceSessions') as any[]) || [];
    if (role !== 'SUPER_ADMIN') {
      sessions = sessions.filter((item) => item.userId === userId);
    }
    if (sessionId) {
      sessions = sessions.filter((item) => item.id === sessionId);
    }
    sessions = sessions
      .slice()
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      .slice(0, limit);

    const sessionIds = sessions.map((item) => item.id);
    const events = ((InMemoryStore.list('aiVoiceEvents') as any[]) || []).filter((item) =>
      sessionIds.includes(item.sessionId),
    );
    const audits = ((InMemoryStore.list('aiToolAudits') as any[]) || []).filter((item) =>
      sessionIds.includes(item.sessionId),
    );

    return sessions.map((session) => ({
      ...session,
      events: events.filter((item) => item.sessionId === session.id),
      toolAudits: audits.filter((item) => item.sessionId === session.id),
    }));
  }

  private verifySignature(body: any, headers: Record<string, any>) {
    if (!this.webhookSecret) return true;
    const signatureHeader =
      headers?.['x-vapi-signature'] ||
      headers?.['X-Vapi-Signature'] ||
      headers?.['x-signature'] ||
      headers?.['X-Signature'];
    const signatureRaw = String(signatureHeader || '').trim();
    const signature = signatureRaw.replace(/^sha256=/i, '');
    if (!signature) return false;

    const digestHex = createHmac('sha256', this.webhookSecret)
      .update(JSON.stringify(body || {}))
      .digest('hex');
    const digestBase64 = Buffer.from(digestHex, 'hex').toString('base64');

    const expected = [digestHex, digestBase64];
    for (const candidate of expected) {
      const a = Buffer.from(signature);
      const b = Buffer.from(candidate);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return true;
      }
    }
    return false;
  }

  private getToolCalls(body: any) {
    const callBlocks = [
      body?.toolCalls,
      body?.tool_calls,
      body?.message?.toolCalls,
      body?.message?.tool_calls,
      body?.call?.toolCalls,
      body?.call?.tool_calls,
    ];
    for (const block of callBlocks) {
      if (Array.isArray(block) && block.length) return block;
    }
    return [];
  }

  private getSessionId(body: any) {
    return (
      body?.metadata?.sessionId ||
      body?.sessionId ||
      body?.call?.metadata?.sessionId ||
      body?.call?.sessionId ||
      body?.conversation?.metadata?.sessionId ||
      body?.conversationId ||
      ''
    );
  }

  private async runTool(name: string, args: any, context: { userId: string; role: string }) {
    if (name === 'search_medics') {
      return this.tools.searchMedics({
        ...args,
        requesterId: context.userId,
        requesterRole: context.role,
      });
    }
    if (name === 'search_hospitals') {
      return this.tools.searchHospitals(args);
    }
    if (name === 'search_pharmacy_products') {
      return this.tools.searchPharmacyProducts(args);
    }
    if (name === 'summarize_health_record') {
      return this.tools.summarizeHealthRecord(args, context);
    }
    if (name === 'get_emergency_contacts') {
      return this.tools.getEmergencyContacts(args, context);
    }
    if (name === 'request_support_chat') {
      return this.tools.requestSupportChat(args, context);
    }
    if (name === 'guide_app_usage') {
      return this.tools.guideAppUsage(args, context);
    }
    throw new BadRequestException(`Unsupported tool: ${name}`);
  }

  async executeTool(user: any, payload: any) {
    const access = await this.aiService.getAccessState(user);
    if (!access?.canUse) {
      throw new ForbiddenException(access?.blockedReason || 'AI access denied.');
    }
    const toolName = String(payload?.toolName || '').trim();
    if (!toolName) throw new BadRequestException('toolName is required');
    const args = payload?.args || {};
    return this.runTool(toolName, args, {
      userId: String(user?.userId || ''),
      role: String(user?.role || ''),
    });
  }

  async handleWebhook(body: any, headers: Record<string, any>) {
    if (!this.verifySignature(body, headers)) {
      throw new ForbiddenException('Invalid Vapi signature');
    }

    const sessionId = String(this.getSessionId(body) || '').trim();
    const session = sessionId
      ? (InMemoryStore.findById('aiVoiceSessions', sessionId) as any)
      : null;

    const eventType = String(
      body?.type || body?.event || body?.message?.type || body?.status || 'webhook',
    ).toLowerCase();
    InMemoryStore.create('aiVoiceEvents', {
      sessionId: session?.id || null,
      eventType,
      payloadJson: body,
      createdAt: new Date().toISOString(),
    } as any);

    if (session && (eventType.includes('end') || eventType.includes('hangup'))) {
      const endedAt = new Date();
      const startedAt = new Date(session.startedAt || endedAt.toISOString());
      const durationSec = Math.max(
        0,
        Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
      );
      InMemoryStore.update('aiVoiceSessions', session.id, {
        status: 'ENDED',
        endedAt: endedAt.toISOString(),
        durationSec,
        updatedAt: new Date().toISOString(),
      } as any);
    }

    const toolCalls = this.getToolCalls(body);
    if (!toolCalls.length) {
      return { ok: true };
    }

    if (!session) {
      throw new BadRequestException('Unknown voice session');
    }

    const outputs: any[] = [];
    for (const call of toolCalls) {
      const toolName = String(call?.name || call?.toolName || call?.function?.name || '').trim();
      const toolCallId = String(call?.id || call?.toolCallId || call?.call_id || '').trim();
      const argsRaw = call?.arguments || call?.args || call?.function?.arguments || {};
      const args =
        typeof argsRaw === 'string'
          ? (() => {
              try {
                return JSON.parse(argsRaw);
              } catch {
                return {};
              }
            })()
          : argsRaw || {};

      try {
        const result = await this.runTool(toolName, args, {
          userId: session.userId,
          role: session.role,
        });
        InMemoryStore.create('aiToolAudits', {
          sessionId: session.id,
          toolName,
          inputJson: args,
          outputJson: result,
          success: true,
          createdAt: new Date().toISOString(),
        } as any);
        outputs.push({
          toolCallId,
          name: toolName,
          result,
        });
      } catch (error: any) {
        const message = error?.message || 'Tool execution failed';
        InMemoryStore.create('aiToolAudits', {
          sessionId: session.id,
          toolName,
          inputJson: args,
          outputJson: { error: message },
          success: false,
          createdAt: new Date().toISOString(),
        } as any);
        outputs.push({
          toolCallId,
          name: toolName,
          error: message,
        });
      }
    }

    return {
      ok: true,
      toolOutputs: outputs,
      results: outputs,
    };
  }
}
