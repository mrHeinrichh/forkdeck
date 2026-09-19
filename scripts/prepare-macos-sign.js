const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = async function prepareMacosSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Finder/iCloud can add these attributes while a bundle is assembled. They
  // invalidate code signing; clear only those attributes on this generated app.
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork"]) {
    execFileSync("/usr/bin/xattr", ["-dr", attribute, appPath], { stdio: "inherit" });
  }
};
