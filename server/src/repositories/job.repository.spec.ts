import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { AssetProcessingStage as Stage } from 'src/dtos/asset-processing.dto.js';
import { QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

// Exercise the Redis boundary through the same queue token used by the application.
describe('asset processing failure retention', () => {
  it('scopes failures by asset and stage, expires them, and clears them for retries', async () => {
    const values = new Map<string, string>();
    const client = {
      runCommand: vi.fn((_command: string, keys: string[]) =>
        Promise.resolve(keys.map((key) => values.get(key) ?? null)),
      ),
      set: vi.fn((key: string, value: string, _options: { EX: number }) => {
        values.set(key, value);
        return Promise.resolve('OK');
      }),
      del: vi.fn((key: string) => Promise.resolve(Number(values.delete(key)))),
    };
    const module = await Test.createTestingModule({
      providers: [
        JobRepository,
        { provide: ConfigRepository, useValue: {} },
        { provide: EventRepository, useValue: {} },
        { provide: LoggingRepository, useValue: { setContext: vi.fn() } },
        {
          provide: getQueueToken(QueueName.BackgroundTask),
          useValue: {
            getBackend: () => ({ client: Promise.resolve(client) }),
            toKey: (suffix: string) => `test:background:${suffix}`,
          },
        },
      ],
    }).compile();
    try {
      const repository = module.get(JobRepository);
      await repository.setAssetProcessingFailure('a', Stage.Metadata, true);
      await repository.setAssetProcessingFailure('a', Stage.Faces, true);
      expect(client.set).toHaveBeenCalledWith('test:background:processing-failure:a:metadata', 'failed', {
        EX: 604_800,
      });
      await expect(repository.getAssetProcessingFailures(['a', 'b'])).resolves.toEqual([
        [Stage.Metadata, Stage.Faces],
        [],
      ]);
      expect(client.runCommand).toHaveBeenCalledTimes(1);
      expect(client.runCommand.mock.calls[0][0]).toBe('mget');
      await expect(repository.getAssetProcessingFailures([])).resolves.toEqual([]);
      expect(client.runCommand).toHaveBeenCalledTimes(1);
      await repository.setAssetProcessingFailure('a', Stage.Metadata, false);
      await expect(repository.getAssetProcessingFailures(['a'])).resolves.toEqual([[Stage.Faces]]);
    } finally {
      await module.close();
    }
  });
});
