// Fully-qualified MCP tool names. SDK in-process servers expose tools as
// `mcp__<serverName>__<toolName>`; keep these in one place so allowedTools
// lists can never drift from the registered tools.

export const MEMORY_SERVER = "memory";
export const BUS_SERVER = "bus";
export const DIRECTOR_SERVER = "director";

export const T = {
  searchMemory: `mcp__${MEMORY_SERVER}__search_memory`,
  readMemory: `mcp__${MEMORY_SERVER}__read_memory`,
  postFinding: `mcp__${BUS_SERVER}__post_finding`,
  readFindings: `mcp__${BUS_SERVER}__read_findings`,
  notifyThread: `mcp__${BUS_SERVER}__notify_thread`,
  busAskUser: `mcp__${BUS_SERVER}__ask_user`,
  askUser: `mcp__${DIRECTOR_SERVER}__ask_user`,
  dispatch: `mcp__${DIRECTOR_SERVER}__dispatch`,
  listThreads: `mcp__${DIRECTOR_SERVER}__list_threads`,
  threadStatus: `mcp__${DIRECTOR_SERVER}__thread_status`,
  inject: `mcp__${DIRECTOR_SERVER}__inject`,
  interruptThread: `mcp__${DIRECTOR_SERVER}__interrupt_thread`,
  readFindingsAll: `mcp__${DIRECTOR_SERVER}__read_findings`,
} as const;

export const BUS_TOOLS = [T.postFinding, T.readFindings, T.notifyThread, T.busAskUser];
export const DIRECTOR_TOOLS = [
  T.searchMemory,
  T.readMemory,
  T.askUser,
  T.dispatch,
  T.listThreads,
  T.threadStatus,
  T.inject,
  T.interruptThread,
  T.readFindingsAll,
];
