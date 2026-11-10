/**
 * Crew hierarchy (task #855) — the CREWS sidebar's manual, display-only
 * tree. Stored as `agentBody.crewTree = { parents: { crewId: parentId } }`
 * (see `CrewTreeDef` in builder/types/index.ts).
 *
 * DISPLAY ONLY: nothing in builder/runtime reads it, and nothing here may
 * ever be wired into routing. Transitions come from the rules / Transition
 * Router as before.
 *
 * Shared by the Builder MCP (read + write + validation) and duplicate
 * (id remap). Pure functions — no DB.
 */

/** The parents map of a body's tree, or {} — tolerant of junk. */
function parentsOf(tree) {
  const p = tree && typeof tree === 'object' ? tree.parents : null;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

/**
 * Check a parents map against the agent's crews. Returns a list of
 * human-readable problems ([] = fine). Refuses: unknown crew ids (either
 * side), a crew under itself, and loops.
 */
function problemsOf(parents, crewIds) {
  const known = new Set(crewIds);
  const problems = [];
  for (const [child, parent] of Object.entries(parents)) {
    if (!known.has(child)) problems.push(`"${child}" is not a crew of this agent`);
    if (typeof parent !== 'string' || !known.has(parent)) problems.push(`"${child}" is put under "${parent}", which is not a crew of this agent`);
    if (child === parent) problems.push(`"${child}" is put under itself`);
  }
  if (problems.length) return problems;
  for (const start of Object.keys(parents)) {
    const seen = new Set([start]);
    let cur = parents[start];
    while (cur !== undefined) {
      if (seen.has(cur)) { problems.push(`loop: "${start}" ends up under itself`); break; }
      seen.add(cur);
      cur = parents[cur];
    }
  }
  return problems;
}

/** A body value for the tree: `undefined` when empty (empty == absent). */
function treeValue(parents) {
  return Object.keys(parents).length ? { parents } : undefined;
}

/**
 * Apply a change to a parents map. `patch` maps crewId → parentId, or
 * null / "" to move that crew back to the top level. `replace` starts
 * from an empty map instead of `current`.
 */
function applyPatch(current, patch, replace = false) {
  const next = replace ? {} : { ...current };
  for (const [child, parent] of Object.entries(patch || {})) {
    if (parent === null || parent === '' || parent === undefined) delete next[child];
    else next[child] = parent;
  }
  return next;
}

/** Remap crew ids on both sides (duplicate). Unmapped entries are dropped. */
function remapTree(tree, idMap) {
  const out = {};
  for (const [child, parent] of Object.entries(parentsOf(tree))) {
    if (idMap[child] && idMap[parent]) out[idMap[child]] = idMap[parent];
  }
  return treeValue(out);
}

/**
 * The tree as the sidebar shows it, as indented text with ids — crews in
 * their sidebar order, children under parents. A crew whose parent is
 * missing or that sits in a loop is shown at the top level (same rule as
 * the client).
 */
function renderTree(agent) {
  const crews = Array.isArray(agent.crews) ? agent.crews : [];
  const ids = new Set(crews.map(c => c.id));
  const raw = parentsOf(agent.crewTree);
  // Effective parent: only if it exists and walking up never loops.
  const parentOf = {};
  for (const c of crews) {
    const p = raw[c.id];
    if (!p || !ids.has(p)) continue;
    const seen = new Set([c.id]);
    let cur = p; let ok = true;
    while (cur) {
      if (seen.has(cur)) { ok = false; break; }
      seen.add(cur);
      cur = ids.has(raw[cur]) ? raw[cur] : undefined;
    }
    if (ok) parentOf[c.id] = p;
  }
  const lines = [];
  const walk = (parentId, depth) => {
    for (const c of crews) {
      if ((parentOf[c.id] || null) !== parentId) continue;
      const flags = agent.defaultCrewId === c.id ? '  (default — first turn)' : '';
      lines.push(`${'  '.repeat(depth)}- ${c.name || '(unnamed)'}  [${c.id}]${flags}`);
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}

module.exports = { parentsOf, problemsOf, treeValue, applyPatch, remapTree, renderTree };
