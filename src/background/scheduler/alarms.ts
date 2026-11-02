import type { Repository } from '../../storage/database';
export const alarmName = 'horitieba:wake';
export async function schedule(repo: Repository) {
  const runs = await Promise.all([repo.current('demo'), repo.current('real')]);
  const times: number[] = [];
  for (const r of runs) {
    if (r?.status !== 'running') continue;
    const tasks = await repo.db.getAllFromIndex('tasks', 'runId', r.id);
    const pending = tasks.some((t) => ['queued', 'waiting'].includes(t.status));
    times.push(Math.min(r.nextCheckAt, pending ? r.nextSendAt : Infinity));
  }
  if (!times.length) {
    await chrome.alarms.clear(alarmName);
    return;
  }
  await chrome.alarms.create(alarmName, { when: Math.max(Date.now() + 30000, Math.min(...times)) });
}
