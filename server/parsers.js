function parseStatus(raw) {
  const zeroTerminated = raw.includes("\0");
  const lines = raw.split(zeroTerminated ? "\0" : /\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const files = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3);
    const entry = { index: xy[0], worktree: xy[1], file, label: statusLabel(xy) };
    if (zeroTerminated && /[RC]/.test(xy)) entry.originalFile = lines[++index] || "";
    files.push(entry);
  }

  let branch = "detached";
  let ahead = 0;
  let behind = 0;
  if (branchLine) {
    const text = branchLine.slice(3);
    branch = text.startsWith("HEAD (no branch)") || text.startsWith("HEAD (detached") ? "detached" : text.startsWith("No commits yet on ")
      ? text.replace("No commits yet on ", "")
      : text.split("...")[0].split(" ")[0];
    const aheadMatch = text.match(/ahead (\d+)/);
    const behindMatch = text.match(/behind (\d+)/);
    ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
    behind = behindMatch ? Number(behindMatch[1]) : 0;
  }

  return { branch, ahead, behind, files };
}

function statusLabel(xy) {
  if (xy === "??") return "Untracked";
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) return "Conflict";
  if (xy.includes("R")) return "Renamed";
  if (xy.includes("M")) return "Modified";
  if (xy.includes("A")) return "Added";
  if (xy.includes("D")) return "Deleted";
  if (xy.includes("R")) return "Renamed";
  if (xy.includes("U")) return "Conflict";
  return "Changed";
}

function parseBranches(raw) {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split("\t");
      return { name, current: head === "*", upstream: upstream || "" };
    });
}

function parseRemoteBranches(raw) {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((name) => name.trim())
    .filter((name) => name && !name.endsWith("/HEAD"));
}

function parseCommitFiles(raw) {
  if (raw.includes("\0")) {
    const parts = raw.split("\0");
    const files = [];
    for (let index = 0; index < parts.length && parts[index]; index += 1) {
      const status = parts[index];
      let file = parts[++index];
      let originalFile;
      if (/^[RC]/.test(status)) {
        originalFile = file;
        file = parts[++index];
      }
      if (file) files.push({ status, file, ...(originalFile ? { originalFile } : {}), label: commitFileLabel(status) });
    }
    return files;
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [status, firstFile, renamedFile] = line.split("\t");
      return {
        status,
        file: renamedFile || firstFile,
        label: commitFileLabel(status)
      };
    });
}

function commitFileLabel(status) {
  return status.startsWith("A") ? "Added" : status.startsWith("D") ? "Deleted" : status.startsWith("R") ? "Renamed" : status.startsWith("C") ? "Copied" : "Modified";
}

function parseCommits(raw) {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const [hash, shortHash, parents, author, relativeDate, timestamp] = fields;
      const refs = fields.pop();
      const subject = fields.slice(6).join("\t");
      return {
        hash,
        shortHash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        author,
        relativeDate,
        timestamp: Number(timestamp) || 0,
        subject,
        refs: refs || ""
      };
    });
}

function parseStashes(raw) {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const [ref, relativeDate, timestamp] = fields;
      const parents = fields.pop();
      const hash = fields.pop();
      const subject = fields.slice(3).join("\t");
      const parentList = parents ? parents.split(" ").filter(Boolean) : [];
      return {
        ref,
        relativeDate,
        timestamp: Number(timestamp) || 0,
        subject,
        hash: hash || "",
        baseHash: parentList[0] || ""
      };
    });
}

module.exports = { parseStatus, parseBranches, parseRemoteBranches, parseCommitFiles, parseCommits, parseStashes };
