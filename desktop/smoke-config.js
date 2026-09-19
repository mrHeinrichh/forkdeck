const path = require("node:path");

function smokeConfiguration(argv, env, pathApi = path) {
  if (!argv.includes("--forkdeck-smoke")) return null;
  const scratch = env.FORKDECK_SMOKE_ROOT;
  if (!scratch || !pathApi.isAbsolute(scratch) || pathApi.parse(scratch).root === scratch) {
    throw new Error("Desktop smoke requires an isolated FORKDECK_SMOKE_ROOT.");
  }
  const configuration = {
    scratch,
    report: env.FORKDECK_SMOKE_REPORT,
    userData: env.FORKDECK_SMOKE_USER_DATA,
    repository: env.FORKDECK_SMOKE_REPO,
    gitConfig: env.GIT_CONFIG_GLOBAL,
    phase: env.FORKDECK_SMOKE_PHASE || "save"
  };
  for (const key of ["report", "userData", "repository", "gitConfig"]) {
    const value = configuration[key];
    const relative = value && pathApi.isAbsolute(value) ? pathApi.relative(scratch, value) : "..";
    if (!relative || relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
      throw new Error(`Desktop smoke ${key} must stay inside its isolated directory.`);
    }
  }
  if (env.GIT_CONFIG_NOSYSTEM !== "1") throw new Error("Desktop smoke must disable system Git configuration.");
  if (!["save", "restore"].includes(configuration.phase)) throw new Error("Unknown desktop smoke phase.");
  return configuration;
}

module.exports = { smokeConfiguration };
