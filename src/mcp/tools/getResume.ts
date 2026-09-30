/**
 * Tool: get_resume
 *
 * Text of the resume to use (default unless a variant is named), plus the
 * list of other variants so Claude can pick a better fit for a role.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listResumes, pickResume } from "../../services/resumes.js";
import { READ_ONLY, run } from "../toolkit.js";

export function registerGetResume(server: McpServer): void {
  server.registerTool(
    "get_resume",
    {
      title: "Get resume",
      description:
        "Get the text of the user's resume. Returns the default resume unless resume_id or label " +
        "names another variant, plus the list of all variants (id, label) so you can pick the one " +
        "that best fits a role. The file itself is not returned; use the text to answer questions.",
      inputSchema: {
        resume_id: z.string().uuid().optional().describe("A specific resume variant id."),
        label: z.string().max(100).optional().describe('A variant label, e.g. "AI/ML".'),
      },
      annotations: READ_ONLY,
    },
    async ({ resume_id, label }, extra) =>
      run(extra, async (userId) => {
        const [resume, variants] = await Promise.all([
          pickResume(userId, { id: resume_id, label }),
          listResumes(userId),
        ]);
        return {
          resume: {
            id: resume.id,
            label: resume.label,
            is_default: resume.is_default,
            file_name: resume.file_name,
            updated_at: resume.updated_at,
            content:
              resume.content ||
              "(No text on file for this resume. Ask the user to paste it or upload a PDF in the Aupply dashboard.)",
          },
          variants: variants.map((v) => ({ id: v.id, label: v.label, is_default: v.is_default })),
        };
      })
  );
}
