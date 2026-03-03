import { ForbiddenException } from '@nestjs/common';
import { InMemoryStore } from '../../common/in-memory.store';
import { AdminController } from './admin.controller';

const clearCollection = (collection: Parameters<typeof InMemoryStore.list>[0]) => {
  InMemoryStore.list(collection).length = 0;
};

describe('AdminController control center smoke', () => {
  const prismaMock: any = {
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    userProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const notificationsMock: any = {
    emitToUsers: jest.fn(),
    emitToUser: jest.fn(),
    isUserOnline: jest.fn().mockReturnValue(false),
  };
  const emailsMock: any = {};

  let controller: AdminController;

  beforeEach(() => {
    [
      'rolePermissions',
      'featureFlags',
      'paymentDisputes',
      'refunds',
      'contentPolicies',
      'policyAcceptances',
      'kycReviews',
      'notifications',
      'auditLogs',
    ].forEach((key) => clearCollection(key as any));
    jest.clearAllMocks();
    controller = new AdminController(prismaMock, notificationsMock, emailsMock);
  });

  it('enforces role matrix permissions for non-super admins', async () => {
    await expect(
      (controller as any).assertPermission(
        { user: { userId: 'finance-1', role: 'ADMIN_FINANCE' } },
        'REVENUE_VIEW',
      ),
    ).resolves.toBeUndefined();

    await expect(
      (controller as any).assertPermission(
        { user: { userId: 'finance-1', role: 'ADMIN_FINANCE' } },
        'KYC_REVIEW',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updates feature flags via fallback store', async () => {
    const req = { user: { userId: 'super-1', role: 'SUPER_ADMIN' } };
    const updated = await controller.updateFeatureFlags(req, {
      flags: { videoCalls: false, voiceAi: true },
    });

    expect(updated.flags.videoCalls).toBe(false);
    expect(updated.flags.voiceAi).toBe(true);
    expect(Number(updated.version)).toBeGreaterThanOrEqual(2);
  });

  it('creates refund automatically when dispute is refund-approved', async () => {
    const req = { user: { userId: 'super-1', role: 'SUPER_ADMIN' } };
    const dispute = await controller.createDispute(req, {
      paymentId: 'pay-1',
      userId: 'user-1',
      amount: 250,
      reason: 'Duplicate charge',
    });

    await controller.updateDispute(req, dispute.id, { status: 'refund_approved' });
    const snapshot = await controller.getDisputes(req);

    expect(snapshot.disputes.length).toBe(1);
    expect(snapshot.refunds.length).toBe(1);
    expect(String(snapshot.refunds[0].status).toUpperCase()).toBe('PENDING');
  });

  it('creates and publishes a content policy', async () => {
    const req = { user: { userId: 'super-1', role: 'SUPER_ADMIN' } };
    const policy = await controller.createContentPolicy(req, {
      type: 'TERMS',
      title: 'Terms v1',
      body: 'Policy body',
      version: 'v1',
    });

    const published = await controller.publishContentPolicy(req, policy.id, { broadcast: false });
    expect(String(published.status).toUpperCase()).toBe('PUBLISHED');
  });

  it('records KYC reviews and updates profile extras', async () => {
    const req = { user: { userId: 'super-1', role: 'SUPER_ADMIN' } };
    const response = await controller.reviewKycQueue(req, 'user-42', {
      status: 'approved',
      notes: 'All docs valid',
    });

    expect(response.success).toBe(true);
    expect(String(response.review.status).toUpperCase()).toBe('APPROVED');
    expect(prismaMock.userProfile.upsert).toHaveBeenCalled();
  });
});
