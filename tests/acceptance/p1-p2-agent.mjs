import { spawn } from "node:child_process";
import { environment } from "./workflow-support.mjs";

export async function freshAgent(root, prompt) {
  const evidence = { commands: [], summary: "", exit: null };
  const args = [
    "-a",
    "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "workspace-write",
    "--json",
    "-C",
    root,
    prompt +
      "\nWork only in this disposable repository. Follow its repository instructions. Do not install, commit, push, publish, change tool configuration, change verification policy, read credentials or unrelated directories, modify Director state, or invoke additional agents. Stop if blocked. Keep the final report concise.",
  ];
  evidence.invocation = args.slice(0, -1);
  await new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let pending = "",
      error = "",
      hardStop;
    const stop = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    };
    const timer = setTimeout(() => {
      evidence.timedOut = true;
      stop("SIGTERM");
      hardStop = setTimeout(() => stop("SIGKILL"), 1000);
    }, 240000);
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== "item.completed") continue;
        const item = event.item;
        if (item?.type === "agent_message") evidence.summary = item.text.slice(0, 4000);
        if (item?.type === "command_execution")
          evidence.commands.push({
            command: item.command,
            exit: item.exit_code,
            ...(/noxroot|cli\.js|node --test/.test(item.command)
              ? { output: item.aggregated_output?.slice(-3000) }
              : {}),
          });
      }
    });
    child.stderr.on("data", (chunk) => {
      error = (error + chunk).slice(-1000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      evidence.exit = code;
      if (code) evidence.error = error;
      resolve();
    });
  });
  return evidence;
}
