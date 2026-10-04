import { z } from 'zod';
import type { JobContext } from '../context.js';
import type { Decision } from '../policy.js';
import { jobTool } from '../toolkit.js';

/** Prepended by the system to every saved report, so the verdict shown is always the policy's. */
export function reportHeader(job: JobContext, decision: Decision): string {
  return `<!-- job ${job.jobId} -->\n> **Verdict (decided by policy): ${decision.verdict}**\n\n`;
}

export const saveReportTool = jobTool({
  id: 'save_report',
  owner: 'report-agent',
  description:
    "Saves the review report for this job as Markdown. The file name is chosen by the system. Call exactly once with the complete report.",
  input: z.object({
    markdown: z.string().min(20).max(20_000).describe('The full report in Markdown'),
  }),
  run: async ({ markdown }, job) => {
    // The verdict line is written by the system, not the model.
    const header = job.state.decision ? reportHeader(job, job.state.decision) : '';
    const path = await job.deps.store.saveReport(job.jobId, header + markdown);
    job.state.reportPath = path;
    return { result: { saved: true, path } };
  },
});

export const reportTools = { save_report: saveReportTool };
