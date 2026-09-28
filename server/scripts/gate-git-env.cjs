// The environment every gate runs in: the caller's, with git's GLOBAL config swapped for the
// suite's own `gates.gitconfig`. System and repo-local config still apply; only the operator's
// personal layer (hooks, editors, credential helpers, identity) is kept out of the throwaway repos.
const path = require("node:path");

const GATES_GITCONFIG = path.join(__dirname, "gates.gitconfig");

function gateEnv(base = process.env) {
  return { ...base, GIT_CONFIG_GLOBAL: GATES_GITCONFIG };
}

module.exports = { GATES_GITCONFIG, gateEnv };
