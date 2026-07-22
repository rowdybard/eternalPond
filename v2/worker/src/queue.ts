export interface PriorityQueueEntry {
  returningLife: boolean;
}

export function insertReturningFirstFifo<T extends PriorityQueueEntry>(queue: T[], entry: T): void {
  if (!entry.returningLife) {
    queue.push(entry);
    return;
  }
  const firstBirth = queue.findIndex((queued) => !queued.returningLife);
  if (firstBirth === -1) queue.push(entry);
  else queue.splice(firstBirth, 0, entry);
}
