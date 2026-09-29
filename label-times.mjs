export function latestLabelTimes(timelineNodes) {
  const out = {};
  for (const n of timelineNodes || []) {
    const name = n?.label?.name?.toLowerCase();
    if (name && n.createdAt && (!out[name] || n.createdAt > out[name])) out[name] = n.createdAt;
  }
  return out;
}
