import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { lastValueFrom, of } from 'rxjs';
import { LoggingInterceptor } from 'src/middleware/logging.interceptor.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { automock } from 'test/utils.js';

it('redacts pairing codes and passwords from verbose request logs', async () => {
  const logger = automock(LoggingRepository, { strict: false });
  const context = new ExecutionContextHost([
    {
      method: 'POST',
      ip: '127.0.0.1',
      url: '/auth/pairing/redeem',
      body: { code: 'secret-pairing-code', password: 'secret-password' },
    },
    { statusCode: 200 },
  ]);
  await lastValueFrom(new LoggingInterceptor(logger).intercept(context, { handle: () => of(null) }));
  expect(logger.verbose).toHaveBeenCalledWith('{"code":"********","password":"********"}');
  expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('secret-pairing-code');
});
