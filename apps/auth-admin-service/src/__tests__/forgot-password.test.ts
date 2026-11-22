import { describe, expect, it } from 'vitest';
import { DomainError, TokenService } from '@loved-ones/shared/auth';
import { AuthGroupModule } from '../domain/auth-group-module.js';

describe('@loved-ones/auth-admin-service unconfigured SMTP forgot-password', () => {
  it('reports email recovery unavailable and instructs users to contact Host Admin', async () => {
    const authGroup = new AuthGroupModule(
      {} as never,
      { saveSession: async () => {} } as never,
      {} as TokenService,
      {
        emailSender: {
          isConfigured: () => false,
          sendMail: async () => {},
        },
      },
    );

    expect(authGroup.isEmailRecoveryConfigured()).toBe(false);
    await expect(
      authGroup.requestPasswordReset({ email: 'member@lovedones.test' }),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('contact your Host Admin'),
      details: { code: 'SMTP_NOT_CONFIGURED' },
    } satisfies Partial<DomainError>);
  });
});
