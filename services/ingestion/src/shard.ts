const SHARD_COUNT = 2000;

export function getShardId(): number {
  return Math.floor(Math.random() * SHARD_COUNT) + 1;
}
