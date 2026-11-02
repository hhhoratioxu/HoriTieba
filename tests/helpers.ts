import { Repository } from '../src/storage/database';
import { Engine } from '../src/background/queue/engine';
import { DemoAdapter } from '../src/adapters/demo/adapter';
import { TiebaAdapter } from '../src/adapters/tieba/adapter';
import { uid } from '../src/domain/models';
export async function harness() {
  const repo = await Repository.open(`test-${uid()}`);
  let now = 2_000_000_000_000;
  const clock = () => now;
  const adapter = new DemoAdapter(repo, clock);
  const real = new TiebaAdapter(
    {
      scan: async () => {
        throw Error('not connected');
      },
    } as never,
    repo,
  );
  const engine = new Engine(repo, { demo: adapter, real }, clock);
  return {
    repo,
    engine,
    adapter,
    real,
    clock,
    advance: (ms = 60001) => {
      now += ms;
    },
    start: async () => {
      await engine.start('demo');
      await engine.tick('demo');
    },
    tasks: () => repo.db.getAll('tasks'),
    attempts: () => repo.db.getAll('attempts'),
    run: () => repo.current('demo'),
  };
}
