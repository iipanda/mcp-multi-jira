import { startLocalServer } from "../../src/mcp/server.ts";
import { createMockSessionManager } from "./mock-session-manager.ts";

await startLocalServer(createMockSessionManager(), "test");
