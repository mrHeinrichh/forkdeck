const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { defaultDataDir } = require("../server/config");
const { repoFilePath } = require("../server/git");
const { commandCandidates, commandError } = require("../server/commands");
const { parseStatus, parseCommitFiles, parseBranches, parseCommits } = require("../server/parsers");
const { parseCredential, parseGhAuthStatus } = require("../server/services/githubAuthService");

test("application data follows each platform's user directory", () => {
  assert.equal(defaultDataDir("darwin", {}, "/Users/test"), "/Users/test/Library/Application Support/ForkDeck");
  assert.equal(defaultDataDir("win32", { APPDATA: "D:\\User data" }, "C:\\Users\\test"), "D:\\User data\\ForkDeck");
  assert.equal(defaultDataDir("win32", {}, "C:\\Users\\test"), "C:\\Users\\test\\AppData\\Roaming\\ForkDeck");
  assert.equal(defaultDataDir("linux", { XDG_DATA_HOME: "/tmp/data" }, "/home/test"), "/tmp/data/ForkDeck");
});

test("repository file boundaries reject traversal and other drives", () => {
  assert.equal(repoFilePath("/repos/work", "docs/read me.md", path.posix), "/repos/work/docs/read me.md");
  for (const file of ["../secret", "/repos/work-copy/secret", ".", ""]) {
    assert.throws(() => repoFilePath("/repos/work", file, path.posix), /inside the repository/);
  }
  assert.equal(repoFilePath("C:\\repos\\work", "src/app.js", path.win32), "C:\\repos\\work\\src\\app.js");
  for (const file of ["..\\secret", "D:\\secret", "C:\\repos\\work-copy\\secret", "\\\\server\\share\\secret"]) {
    assert.throws(() => repoFilePath("C:\\repos\\work", file, path.win32), /inside the repository/);
  }
});

test("GUI installs discover Git and gh without a shell PATH", () => {
  assert.ok(commandCandidates("git", "darwin", {}, "/Users/test").includes("/opt/homebrew/bin/git"));
  assert.ok(commandCandidates("gh", "win32", { ProgramFiles: "D:\\Program Files" }, "C:\\Users\\test")
    .includes("D:\\Program Files\\GitHub CLI\\gh.exe"));
  const error = commandError("git", { code: "ENOENT" });
  assert.equal(error.status, 503);
  assert.match(error.message, /git-scm.com\/downloads/);
});

test("NUL status preserves Unicode, whitespace and renamed filenames", () => {
  const parsed = parseStatus("## main...origin/main [ahead 2, behind 1]\0R  new name.txt\0old name.txt\0?? café.txt\0 M tab\tline\n.txt\0AA conflict.txt\0");
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  assert.deepEqual(parsed.files.map(({ file }) => file), ["new name.txt", "café.txt", "tab\tline\n.txt", "conflict.txt"]);
  assert.equal(parsed.files[0].originalFile, "old name.txt");
  assert.equal(parsed.files[3].label, "Conflict");
});

test("NUL commit files use rename destinations and preserve path characters", () => {
  const parsed = parseCommitFiles("R100\0old.txt\0new file.txt\0A\0café\tfile.txt\0D\0removed.txt\0");
  assert.deepEqual(parsed[0], { status: "R100", originalFile: "old.txt", file: "new file.txt", label: "Renamed" });
  assert.equal(parsed[1].file, "café\tfile.txt");
  assert.equal(parsed[2].label, "Deleted");
});

test("Windows line endings do not leak into Git and credential fields", () => {
  assert.deepEqual(parseBranches("main\t*\torigin/main\r\n"), [{ name: "main", current: true, upstream: "origin/main" }]);
  assert.deepEqual(parseCredential("protocol=https\r\nhost=github.com\r\nusername=octocat\r\npassword=private\r\n"), {
    protocol: "https", host: "github.com", username: "octocat", path: "", hasPassword: true
  });
  const gh = parseGhAuthStatus("Logged in to github.com account octocat (keyring)\r\n  - Active account: true\r\n  - Git operations protocol: https\r\n");
  assert.equal(gh.activeUser, "octocat");
  assert.equal(gh.activeProtocol, "https");
  assert.equal(parseCommits("abc\tabc\t\tAuthor\tnow\t123\tSubject\twith tab\tHEAD -> main\r\n")[0].subject, "Subject\twith tab");
});
