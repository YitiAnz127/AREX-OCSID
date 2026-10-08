/** Observation only: does not change OCSID's prompt, model, tools or decisions. */
import fs from "node:fs";
import path from "node:path";

export default function runtimeAudit(ocsid) {
  ocsid.on("before_agent_start", (event, ctx) => {
    fs.mkdirSync("/logs/agent/runtime", { recursive: true });
    const header = ctx.sessionManager.getHeader();
    fs.writeFileSync(path.join("/logs/agent/runtime", `${header?.id ?? "session"}.json`), JSON.stringify({
      header,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
      systemPrompt: event.systemPrompt,
      skills: (event.systemPromptOptions.skills ?? []).map((skill) => ({ name: skill.name, filePath: skill.filePath })),
      selectedTools: event.systemPromptOptions.selectedTools,
      activeTools: ocsid.getActiveTools(),
      cwd: event.systemPromptOptions.cwd,
    }, null, 2) + "\n");
  });
}
