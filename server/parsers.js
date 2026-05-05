function parseStatus(raw) {
  const lines = raw.split("\n").filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const files = lines
    .filter((line) => !line.startsWith("## "))
    .map((line) => {
      const xy = line.slice(0, 2);
      const file = line.slice(3);
      return {
        index: xy[0],
        worktree: xy[1],
        file,
        label: statusLabel(xy)
      };
    });

  let branch = "detached";
  let ahead = 0;
  let behind = 0;
  if (branchLine) {
    const text = branchLine.slice(3);
    branch = text.startsWith("No commits yet on ")
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
  if (xy.includes("M")) return "Modified";
  if (xy.includes("A")) return "Added";
  if (xy.includes("D")) return "Deleted";
  if (xy.includes("R")) return "Renamed";
  if (xy.includes("U")) return "Conflict";
  return "Changed";
}

function parseBranches(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split("\t");
      return { name, current: head === "*", upstream: upstream || "" };
    });
}

function parseRemoteBranches(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((name) => name.trim())
    .filter((name) => name && !name.endsWith("/HEAD"));
}

function parseCommitFiles(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split("\t");
      return {
        status,
        file,
        label: status === "A" ? "Added" : status === "D" ? "Deleted" : status === "R" ? "Renamed" : "Modified"
      };
    });
}

function parseCommits(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, parents, author, relativeDate, timestamp, subject, refs] = line.split("\t");
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
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, relativeDate, timestamp, subject, hash, parents] = line.split("\t");
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
