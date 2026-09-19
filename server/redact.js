// Git remotes, helper commands, and CLI diagnostics can contain credentials.
// Keep those secrets out of API responses and remembered repository metadata.
function redactSensitive(value) {
  return String(value || "")
    .replace(/(https?:\/\/)[^\s/]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_token|token|password|auth|key)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(?:gh[pousr]_[a-z\d_]+|github_pat_[a-z\d_]+)\b/gi, "[redacted]")
    .replace(/\b((?:password|oauth_token|access_token|authorization)\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]");
}

module.exports = { redactSensitive };
