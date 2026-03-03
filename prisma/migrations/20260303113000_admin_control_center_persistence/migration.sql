-- Admin Control Center persistence tables

CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id" TEXT NOT NULL,
  "matrix" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyc_reviews" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "notes" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kyc_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "kyc_reviews_userId_createdAt_idx" ON "kyc_reviews"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "kyc_reviews_status_createdAt_idx" ON "kyc_reviews"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "fraud_cases" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "details" JSONB,
  "notes" TEXT,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fraud_cases_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "fraud_cases_status_createdAt_idx" ON "fraud_cases"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "fraud_cases_userId_createdAt_idx" ON "fraud_cases"("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "subject" TEXT NOT NULL,
  "description" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "assignedTo" TEXT,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "support_tickets_status_createdAt_idx" ON "support_tickets"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "support_tickets_assignedTo_createdAt_idx" ON "support_tickets"("assignedTo", "createdAt");

CREATE TABLE IF NOT EXISTS "content_policies" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "createdBy" TEXT,
  "publishedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "content_policies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "content_policies_status_createdAt_idx" ON "content_policies"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "content_policies_type_version_idx" ON "content_policies"("type", "version");

CREATE TABLE IF NOT EXISTS "policy_acceptances" (
  "id" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "userId" TEXT,
  "accepted" BOOLEAN NOT NULL DEFAULT true,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "policy_acceptances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "policy_acceptances_policyId_acceptedAt_idx" ON "policy_acceptances"("policyId", "acceptedAt");
CREATE INDEX IF NOT EXISTS "policy_acceptances_userId_acceptedAt_idx" ON "policy_acceptances"("userId", "acceptedAt");

CREATE TABLE IF NOT EXISTS "emergency_incidents" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "patientId" TEXT,
  "location" TEXT,
  "severity" TEXT NOT NULL DEFAULT 'HIGH',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "assignedTo" TEXT,
  "responders" JSONB,
  "notes" TEXT,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "emergency_incidents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "emergency_incidents_status_createdAt_idx" ON "emergency_incidents"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "emergency_incidents_severity_createdAt_idx" ON "emergency_incidents"("severity", "createdAt");

CREATE TABLE IF NOT EXISTS "compliance_requests" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "reason" TEXT,
  "requestedBy" TEXT,
  "updatedBy" TEXT,
  "completedAt" TIMESTAMP(3),
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "compliance_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "compliance_requests_status_createdAt_idx" ON "compliance_requests"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "compliance_requests_type_createdAt_idx" ON "compliance_requests"("type", "createdAt");

CREATE TABLE IF NOT EXISTS "feature_flags" (
  "id" TEXT NOT NULL,
  "flags" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payment_disputes" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT,
  "orderId" TEXT,
  "userId" TEXT,
  "reason" TEXT,
  "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_disputes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "payment_disputes_status_createdAt_idx" ON "payment_disputes"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "payment_disputes_paymentId_createdAt_idx" ON "payment_disputes"("paymentId", "createdAt");
CREATE INDEX IF NOT EXISTS "payment_disputes_orderId_createdAt_idx" ON "payment_disputes"("orderId", "createdAt");

CREATE TABLE IF NOT EXISTS "refunds" (
  "id" TEXT NOT NULL,
  "disputeId" TEXT,
  "paymentId" TEXT,
  "userId" TEXT,
  "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "refunds_status_createdAt_idx" ON "refunds"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "refunds_disputeId_createdAt_idx" ON "refunds"("disputeId", "createdAt");
CREATE INDEX IF NOT EXISTS "refunds_paymentId_createdAt_idx" ON "refunds"("paymentId", "createdAt");

CREATE TABLE IF NOT EXISTS "platform_health_snapshots" (
  "id" TEXT NOT NULL,
  "api" JSONB,
  "database" JSONB,
  "payments" JSONB,
  "emails" JSONB,
  "videoCalls" JSONB,
  "webhooks" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_health_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "platform_health_snapshots_createdAt_idx" ON "platform_health_snapshots"("createdAt");

