function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function identityText(identity) {
  if (!identity?.name && !identity?.email) return "Not set";
  if (!identity.email) return identity.name;
  if (!identity.name) return identity.email;
  return `${identity.name} <${identity.email}>`;
}

function initials(profile) {
  return (profile.label || profile.name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function colorFromText(value) {
  const palette = ["#18c7b8", "#f28a38", "#66c56f", "#a777e3", "#ff6b64", "#f4c84a", "#60a5fa"];
  const text = String(value || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length];
}

function statusClass(value) {
  const label = String(value || "changed").toLowerCase();
  if (label.includes("delete") || label === "d") return "status-deleted";
  if (label.includes("add") || label === "a" || label.includes("untracked")) return "status-added";
  if (label.includes("rename") || label === "r") return "status-renamed";
  if (label.includes("conflict") || label === "u") return "status-conflict";
  if (label.includes("modif") || label === "m") return "status-modified";
  return "status-changed";
}

function highlightDiff(text) {
  const value = String(text || "");
  if (!value) return "";
  return value
    .split("\n")
    .map((line) => {
      let className = "diff-line";
      if (line.startsWith("@@")) className += " diff-hunk";
      else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) className += " diff-file";
      else if (line.startsWith("+") && !line.startsWith("+++")) className += " diff-add";
      else if (line.startsWith("-") && !line.startsWith("---")) className += " diff-del";
      return `<span class="${className}">${line ? escapeHtml(line) : " "}</span>`;
    })
    .join("");
}

function highlightConflictText(text) {
  let section = "";
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (line.startsWith("<<<<<<<")) section = "ours";
      else if (line.startsWith("=======")) section = "divider";
      else if (line.startsWith(">>>>>>>")) section = "theirs";
      const marker = line.startsWith("<<<<<<<") || line.startsWith("=======") || line.startsWith(">>>>>>>");
      const className = marker ? "conflict-marker" : section === "ours" ? "conflict-ours-line" : section === "theirs" ? "conflict-theirs-line" : "conflict-line";
      if (line.startsWith("=======")) section = "theirs";
      if (line.startsWith(">>>>>>>")) section = "";
      return `<span class="${className}">${line ? escapeHtml(line) : " "}</span>`;
    })
    .join("");
}

function conflictPane(title, subtitle, text, tone) {
  return `
    <section class="conflict-pane ${tone}">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(subtitle)}</span>
      </header>
      <div class="conflict-code">${highlightConflictText(text || "No content available for this side.")}</div>
    </section>
  `;
}

export { escapeHtml, identityText, initials, colorFromText, statusClass, highlightDiff, highlightConflictText, conflictPane };
