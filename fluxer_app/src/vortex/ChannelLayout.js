// SPDX-License-Identifier: AGPL-3.0-or-later

// Validate the entire drag operation before writing encrypted channel metadata.
export function planChannelMoves(channels, changes) {
  if (!Array.isArray(changes) || changes.length > 1000) throw new Error('Invalid channel order');
  const byId = new Map(channels.map(channel => [channel.id, {...channel}]));
  const changed = new Set(), parents = new Set();
  for (const change of changes) {
    const channel = byId.get(change.id);
    if (!channel || changed.has(change.id)) throw new Error('Invalid channel in order');
    changed.add(change.id); parents.add(channel.parent_id);
    if (change.position !== undefined && (!Number.isSafeInteger(change.position) || change.position < 0 || change.position > 10000)) throw new Error('Invalid channel position');
    if (change.parent_id !== undefined) {
      const parent = change.parent_id === null ? null : byId.get(change.parent_id);
      if (change.parent_id !== null && (!parent || parent.type !== 4 || channel.type === 4)) throw new Error('Choose a category in this Space');
      channel.parent_id = change.parent_id;
    }
    parents.add(channel.parent_id);
  }
  const groups = new Map();
  for (const parent of parents) groups.set(parent, [...byId.values()].filter(channel => channel.parent_id === parent).sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)));
  for (const change of changes) {
    const channel = byId.get(change.id), siblings = groups.get(channel.parent_id);
    if (change.preceding_sibling_id === undefined && change.position === undefined) continue;
    siblings.splice(siblings.findIndex(sibling => sibling.id === channel.id), 1);
    let index;
    if (change.preceding_sibling_id !== undefined) {
      index = change.preceding_sibling_id === null ? 0 : siblings.findIndex(sibling => sibling.id === change.preceding_sibling_id) + 1;
      if (change.preceding_sibling_id !== null && index === 0) throw new Error('Choose a preceding channel in the same category');
    } else {
      index = siblings.findIndex(sibling => sibling.position >= change.position);
      if (index < 0) index = siblings.length;
    }
    siblings.splice(index, 0, channel);
  }
  const result = [];
  for (const [parent, siblings] of groups) {
    let voice = false;
    for (const [position, channel] of siblings.entries()) {
      if (parent !== null) {
        if (channel.type === 2) voice = true;
        else if (voice) throw new Error('Text channels must precede voice channels in a category');
      }
      const original = channels.find(original => original.id === channel.id);
      if (original.position !== position || original.parent_id !== channel.parent_id) result.push({id: channel.id, position, parent_id: channel.parent_id});
    }
  }
  return result;
}
