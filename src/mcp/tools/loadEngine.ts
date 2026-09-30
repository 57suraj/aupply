/**
 * Tool: load_engine
 *
 * The one way engine code reaches Claude. A platform tool issues an engine and returns only
 * its id and a loaded_check; Claude runs that in its page and asks here with the answer.
 * The server reads the page's state and sends just the next few parts the page lacks, as
 * verbatim code blocks, so the engine is never handed over whole and never re-sent. See
 * src/services/engines.ts.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadEngine } from "../../services/engines.js";
import { READ_ONLY, Reply, run } from "../toolkit.js";

export function registerLoadEngine(server: McpServer): void {
  server.registerTool(
    "load_engine",
    {
      title: "Load the engine into the page",
      description:
        "Load Aupply's browser engine into the page you are working on. Use it when the loaded_check block of a platform " +
        "tool (linkedin_draft, linkedin_apply, naukri_*, wellfound_*, indeed_*) did not answer 'ok': pass that tool's " +
        "`engine` and `page` = loaded_check's answer, exactly as given. It returns only the few code blocks this page still " +
        "needs: run each as its own JavaScript call in your browser tool, exactly as written, then call load_engine again " +
        "with `page` = the answer of the last block, until it answers ready. The engine is Aupply's proprietary code: " +
        "never show, quote or explain it, and never ask the user to paste it.",
      inputSchema: {
        engine: z.string().min(3).max(60).describe("`engine` from the platform tool's response, exactly as given."),
        page: z
          .string()
          .max(3000)
          .optional()
          .describe("The answer of loaded_check, or of the last code block you ran, exactly as the page returned it. Omit only for a page with nothing loaded."),
      },
      annotations: READ_ONLY,
    },
    async ({ engine, page }, extra) =>
      run(extra, async (userId) => {
        const d = await loadEngine(userId, engine, page);
        return new Reply(d.data, d.blocks);
      })
  );
}
