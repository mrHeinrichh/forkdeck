// Queue write workflows so their validation, Git action and snapshot stay together.
const pending = new Map();

function withRepoMutation(root, action) {
  const result = (pending.get(root) || Promise.resolve()).then(action);
  const settled = result.catch(() => {});
  pending.set(root, settled);
  settled.then(() => { if (pending.get(root) === settled) pending.delete(root); });
  return result;
}

module.exports = { withRepoMutation };
