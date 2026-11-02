import type { Transaction } from '../storage/database';
import { replyInterval } from '../shared/thread-reply';

const lastKey = (account: string) => 'thread-reply:last:' + account; // Also honors 0.3.0 sends.
const lockKey = (account: string) => 'page-send:slot:' + account;
interface Slot {
  owner: string;
  expires: number;
}

// Reserve preparation without counting a send. The last click time is advanced only on a permit.
export async function reserveSlot(
  tx: Transaction,
  account: string,
  owner: string,
  now: number,
): Promise<number> {
  const meta = tx.objectStore('meta');
  const last = Number((await meta.get(lastKey(account)))?.value ?? 0);
  const slot = (await meta.get(lockKey(account)))?.value as Slot | undefined;
  const due = Math.max(
    last ? last + replyInterval : 0,
    slot && slot.owner !== owner ? slot.expires : 0,
  );
  if (now < due) return due;
  await meta.put({ id: lockKey(account), value: { owner, expires: now + 90000 } });
  return 0;
}
export async function releaseSlot(tx: Transaction, account: string, owner: string) {
  const meta = tx.objectStore('meta');
  if (((await meta.get(lockKey(account)))?.value as Slot | undefined)?.owner === owner)
    await meta.delete(lockKey(account));
}
export async function consumeSlot(tx: Transaction, account: string, owner: string, now: number) {
  if (await reserveSlot(tx, account, owner, now)) return false;
  const meta = tx.objectStore('meta');
  await meta.put({ id: lastKey(account), value: now });
  await meta.delete(lockKey(account));
  return true;
}
