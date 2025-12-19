const debugEnabled =
  process.env.MCP_JIRA_DEBUG === "1" ||
  process.env.MCP_JIRA_DEBUG === "true";

let logTarget: "stdout" | "stderr" =
  process.env.MCP_JIRA_LOG_STDERR === "1" ||
  process.env.MCP_JIRA_LOG_STDERR === "true"
    ? "stderr"
    : "stdout";

export function setLogTarget(target: "stdout" | "stderr") {
  logTarget = target;
}

function logLine(message: string) {
  if (logTarget === "stderr") {
    console.error(message);
    return;
  }
  console.log(message);
}

export function info(message: string) {
  logLine(message);
}

export function warn(message: string) {
  console.error(message);
}

export function error(message: string) {
  console.error(message);
}

export function debug(message: string) {
  if (!debugEnabled) {
    return;
  }
  logLine(message);
}
