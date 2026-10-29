import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { SystemMetadataKey } from 'src/enum.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';

describe('persistent LAN identity', () => {
  let db: Kysely<DB>;
  let repository: SystemMetadataRepository;
  let queries: string[];

  beforeEach(() => {
    queries = [];
    db = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      log: ({ query }) => {
        queries.push(query.sql);
      },
    });
    repository = new SystemMetadataRepository(db);
  });

  afterEach(() => db.destroy());

  it('retains an existing instance secret without writing', async () => {
    vi.spyOn(repository, 'get').mockResolvedValue({ secret: 'existing-secret' });
    await expect(repository.getOrCreate(SystemMetadataKey.LanIdentity, { secret: 'proposed-secret' })).resolves.toEqual(
      {
        secret: 'existing-secret',
      },
    );
    expect(queries).toEqual([]);
  });

  it('returns the winning worker secret and never overwrites a conflicting row', async () => {
    vi.spyOn(repository, 'get').mockResolvedValueOnce(null).mockResolvedValueOnce({ secret: 'winning-secret' });
    await expect(repository.getOrCreate(SystemMetadataKey.LanIdentity, { secret: 'losing-secret' })).resolves.toEqual({
      secret: 'winning-secret',
    });
    expect(queries).toEqual([
      'insert into "system_metadata" ("key", "value") values ($1, $2) on conflict ("key") do nothing',
    ]);
  });

  it('fails instead of returning an unpersisted secret', async () => {
    vi.spyOn(repository, 'get').mockResolvedValue(null);
    await expect(repository.getOrCreate(SystemMetadataKey.LanIdentity, { secret: 'unsaved-secret' })).rejects.toThrow(
      'Failed to initialize system metadata: lan-identity',
    );
  });
});
