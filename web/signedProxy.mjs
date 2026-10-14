export function readSignedTarget(raw, bucket) {
  if (!raw || !bucket) return null;
  let target;
  try { target = new URL(raw); } catch { return null; }
  if (target.protocol !== 'https:' || target.username || target.password) return null;
  if (target.hostname !== 'storage.googleapis.com') return null;
  if (!target.pathname.startsWith('/' + bucket + '/')) return null;
  return target.toString();
}
