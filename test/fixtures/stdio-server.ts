import { startLocalServer } from "../../src/mcp/server.ts";
import { createMockSessionManager } from "./mockSessionManager.ts";

await startLocalServer(createMockSessionManager(), "test");
